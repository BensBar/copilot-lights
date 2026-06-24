import * as dgram from 'node:dgram';
import type { LightAdapter, LightFrame, LightSnapshot } from './adapter.js';
import type { z } from 'zod';
import type { GoveeConfigSchema } from '../config/schema.js';

/**
 * Govee LAN API adapter.
 *
 * Spec: https://app-h5.govee.com/user-manual/wlan-guide
 *
 * Protocol summary (no auth, LAN-only, UDP/JSON):
 *   - Discovery request (multicast): UDP to 239.255.255.250:4001
 *     {"msg":{"cmd":"scan","data":{"account_topic":"reserve"}}}
 *     Devices respond on UDP/4002 with their IP, SKU, etc.
 *   - Control: UDP to <device-ip>:4003 with one of:
 *     {"msg":{"cmd":"turn","data":{"value":1|0}}}
 *     {"msg":{"cmd":"brightness","data":{"value":0..100}}}
 *     {"msg":{"cmd":"colorwc","data":{"color":{"r":..,"g":..,"b":..},"colorTemInKelvin":0}}}
 *
 * The user must enable "LAN Control" per device in the Govee Home app
 * before this adapter can talk to them.
 *
 * Implementation notes:
 *   - We do NOT discover at every frame — adapter.connect() does at most
 *     one discovery, then we cache device IPs from config (or from the
 *     discovery scan).
 *   - applyFrame coalesces: if a frame is already in flight we keep only
 *     the latest pending frame. Same shape as the Hue adapter.
 *   - The protocol is fire-and-forget UDP — there are no acks. We don't
 *     await any response; failures show up only as the next discovery
 *     scan finding nothing.
 */

export interface GoveeDevice {
  ip: string;
  sku?: string;
  name?: string;
}

export interface GoveeSnapshot extends LightSnapshot {
  _kind: 'govee';
  capturedAt: number;
  /** We can't read state back over LAN reliably; snapshot just records
   *  the last frame we sent so restore can re-apply it. */
  lastFrame: LightFrame | null;
}

// ---------- Pure packet builders (unit-tested) ----------

/** Clamp + round any number to a 0..255 byte. */
export function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function buildDiscoveryPacket(): Buffer {
  return Buffer.from(JSON.stringify({
    msg: { cmd: 'scan', data: { account_topic: 'reserve' } },
  }));
}

export function buildTurnPacket(on: boolean): Buffer {
  return Buffer.from(JSON.stringify({
    msg: { cmd: 'turn', data: { value: on ? 1 : 0 } },
  }));
}

export function buildBrightnessPacket(brightness: number): Buffer {
  const v = Math.max(0, Math.min(100, Math.round(brightness)));
  return Buffer.from(JSON.stringify({
    msg: { cmd: 'brightness', data: { value: v } },
  }));
}

export function buildColorPacket(r: number, g: number, b: number): Buffer {
  return Buffer.from(JSON.stringify({
    msg: {
      cmd: 'colorwc',
      data: {
        color: { r: clampByte(r), g: clampByte(g), b: clampByte(b) },
        colorTemInKelvin: 0,
      },
    },
  }));
}

/**
 * Parse a discovery response packet from a Govee device. Returns null if
 * the packet doesn't look like a discovery reply. Defensive against
 * malformed JSON or unexpected schemas — never throws.
 */
export function parseDiscoveryResponse(buf: Buffer): GoveeDevice | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const msg = (parsed as { msg?: unknown }).msg;
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as { cmd?: unknown; data?: unknown };
  if (m.cmd !== 'scan') return null;
  const data = m.data as { ip?: unknown; sku?: unknown; device?: unknown } | undefined;
  if (!data || typeof data !== 'object') return null;
  if (typeof data.ip !== 'string' || data.ip.length === 0) return null;
  return {
    ip: data.ip,
    sku: typeof data.sku === 'string' ? data.sku : undefined,
    name: typeof data.device === 'string' ? data.device : undefined,
  };
}

// ---------- Adapter ----------

export interface GoveeAdapterOptions {
  /** Test seam: substitute a UDP socket factory. */
  socketFactory?: () => dgram.Socket;
  /** Test seam: substitute a clock for the discovery deadline. */
  now?: () => number;
  /** Override the config's minimum burst spacing (ms). Mainly for tests. */
  minSendIntervalMs?: number;
  /** Override the config's inter-packet gap (ms). Mainly for tests. */
  interPacketGapMs?: number;
  /** Test seam: substitute the inter-packet delay implementation. */
  delay?: (ms: number) => Promise<void>;
}

/** What we last physically pushed to the device, used to send only the
 *  packets that actually changed (avoids re-sending `turn:1` every frame,
 *  which makes some Govee bulbs flicker, and avoids crowding out the
 *  colour packet under rapid delivery). Brightness is stored rounded so the
 *  comparison matches the wire value. */
interface SentState {
  on: boolean;
  r: number;
  g: number;
  b: number;
  brightness: number;
}

export class GoveeAdapter implements LightAdapter {
  readonly kind = 'govee';
  private readonly cfg: z.infer<typeof GoveeConfigSchema>;
  private readonly socketFactory: () => dgram.Socket;
  private readonly now: () => number;
  private readonly minSendIntervalMs: number;
  private readonly interPacketGapMs: number;
  private readonly delay: (ms: number) => Promise<void>;

  private socket: dgram.Socket | null = null;
  private devices: GoveeDevice[] = [];
  private closed = false;
  private lastFrame: LightFrame | null = null;

  // ---- Throttle / coalescing state ----
  /** The most recent frame requested but not yet physically sent. Only the
   *  latest matters — intermediate frames are intentionally dropped. */
  private pendingFrame: LightFrame | null = null;
  /** True while a burst is being written to the socket. */
  private sending = false;
  /** now() at the start of the last physical burst. */
  private lastSendStartAt = 0;
  /** Pending trailing-flush timer, if scheduled. */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last state physically sent, for change-detection. */
  private lastSentState: SentState | null = null;

  /** Read-only view of the device list (post-connect / post-discovery).
   * Used by the `copilot-lights govee discover` CLI to print results. */
  get discoveredDevices(): readonly GoveeDevice[] {
    return this.devices;
  }

  constructor(cfg: z.infer<typeof GoveeConfigSchema>, opts?: GoveeAdapterOptions) {
    this.cfg = cfg;
    this.socketFactory = opts?.socketFactory ?? (() => dgram.createSocket({ type: 'udp4', reuseAddr: true }));
    this.now = opts?.now ?? (() => Date.now());
    this.minSendIntervalMs = opts?.minSendIntervalMs ?? cfg.minSendIntervalMs ?? 120;
    this.interPacketGapMs = opts?.interPacketGapMs ?? cfg.interPacketGapMs ?? 40;
    this.delay = opts?.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }


  async connect(): Promise<void> {
    if (this.closed) throw new Error('GoveeAdapter is closed');

    // Seed device list from config IPs immediately — these work with no
    // discovery round-trip required and are the common case once a user
    // has things configured.
    this.devices = this.cfg.devices.map((d) => ({
      ip: d.ip,
      sku: d.sku,
      name: d.name,
    }));

    // Open the socket (used both for discovery responses and for
    // outgoing control packets).
    this.socket = this.socketFactory();

    // Bind to the response port so we can hear discovery replies. Try 4002
    // first (Govee devices reply there), then fall back to an OS-assigned
    // port if 4002 is unavailable — control packets still go out fine, only
    // discovery replies are missed in that case.
    await new Promise<void>((resolve, reject) => {
      const sock = this.socket!;
      const bindToPort = (port: number, onFail?: (err: Error) => void) => {
        const onError = (err: Error) => {
          if (onFail) onFail(err);
          else reject(err);
        };
        sock.once('error', onError);
        sock.bind(port, () => {
          sock.removeListener('error', onError);
          try {
            sock.setBroadcast(true);
          } catch {
            // Some platforms reject this; not fatal for unicast control.
          }
          resolve();
        });
      };
      bindToPort(4002, () => {
        // 4002 unavailable (already bound by another govee tool, etc.) —
        // ask the OS for any free port.
        bindToPort(0);
      });
    });

    // Optional discovery scan to learn additional / replace stale IPs.
    if (this.cfg.devices.length === 0 || this.cfg.discoveryTimeoutMs > 0) {
      try {
        const found = await this.discover(this.cfg.discoveryTimeoutMs);
        for (const dev of found) {
          if (!this.devices.some((d) => d.ip === dev.ip)) {
            this.devices.push(dev);
          }
        }
      } catch {
        // Non-fatal: configured devices may still work.
      }
    }
  }

  /** Fire one multicast discovery packet and collect responses for the
   *  given time window. Resolves with the list of devices that replied. */
  async discover(timeoutMs: number): Promise<GoveeDevice[]> {
    if (!this.socket) throw new Error('GoveeAdapter not connected');
    const found = new Map<string, GoveeDevice>();
    const onMessage = (buf: Buffer, _rinfo: dgram.RemoteInfo): void => {
      const dev = parseDiscoveryResponse(buf);
      if (dev) found.set(dev.ip, dev);
    };
    this.socket.on('message', onMessage);
    try {
      const packet = buildDiscoveryPacket();
      await new Promise<void>((resolve, reject) => {
        this.socket!.send(packet, 4001, '239.255.255.250', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      const deadline = this.now() + Math.max(0, timeoutMs);
      while (this.now() < deadline) {
        await new Promise((r) => setTimeout(r, Math.min(50, deadline - this.now())));
      }
    } finally {
      this.socket.removeListener('message', onMessage);
    }
    return Array.from(found.values());
  }

  /**
   * Queue a frame for delivery. Returns once the frame has either been sent
   * (if we're outside the throttle window) or coalesced into the pending
   * slot for a trailing flush. Per the LightAdapter contract this never
   * blocks the caller on the device's pace — at most one burst is sent per
   * `minSendIntervalMs`, always carrying the most recent frame.
   */
  async applyFrame(frame: LightFrame): Promise<void> {
    if (this.closed) throw new Error('GoveeAdapter is closed');
    if (!this.socket) throw new Error('GoveeAdapter not connected');

    this.pendingFrame = frame;
    await this.maybeFlush();
  }

  /** Send the pending frame now if the throttle window has elapsed, else
   *  arm a trailing timer to send it when the window opens. */
  private async maybeFlush(): Promise<void> {
    if (this.sending || this.pendingFrame === null) return;

    const elapsed = this.now() - this.lastSendStartAt;
    if (elapsed < this.minSendIntervalMs) {
      this.scheduleFlush(this.minSendIntervalMs - elapsed);
      return;
    }

    const frame = this.pendingFrame;
    this.pendingFrame = null;
    this.sending = true;
    this.lastSendStartAt = this.now();
    try {
      await this.sendFrame(frame);
      this.lastFrame = frame;
    } finally {
      this.sending = false;
    }

    // Frames that arrived mid-send get a trailing flush (which the throttle
    // will defer to the next window).
    if (this.pendingFrame !== null) {
      await this.maybeFlush();
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.maybeFlush();
    }, Math.max(0, delayMs));
    // Don't keep the event loop alive just for a trailing light update.
    if (typeof (this.flushTimer as { unref?: () => void }).unref === 'function') {
      (this.flushTimer as { unref: () => void }).unref();
    }
  }

  /**
   * Push one frame to every device, sending only the packets that changed
   * since the last burst and spacing them by `interPacketGapMs` so the
   * device reliably processes each one.
   *
   * Govee floor lamps only render a solid `colorwc` colour when the device
   * is in a plain colour mode — if it's running a Scene/DIY effect, the
   * colour is stored but the effect keeps rendering. There's no LAN command
   * to exit a scene, so colour control requires the device to be in colour
   * mode (documented in the README).
   */
  private async sendFrame(frame: LightFrame): Promise<void> {
    const on = frame.brightness > 0;
    const r = clampByte(frame.rgb.r);
    const g = clampByte(frame.rgb.g);
    const b = clampByte(frame.rgb.b);
    const brightness = Math.max(0, Math.min(100, Math.round(frame.brightness)));
    const prev = this.lastSentState;
    const turnedOnNow = on && (prev === null || !prev.on);

    const packets: Buffer[] = [];
    if (prev === null || prev.on !== on) {
      packets.push(buildTurnPacket(on));
    }
    if (on) {
      const colorChanged = prev === null || prev.r !== r || prev.g !== g || prev.b !== b;
      // Re-send colour when (re)turning on — some bulbs reset to white on
      // power-on, so the stored colour must be re-asserted.
      if (turnedOnNow || colorChanged) {
        packets.push(buildColorPacket(r, g, b));
      }
      const brightnessChanged = prev === null || prev.brightness !== brightness;
      if (turnedOnNow || brightnessChanged) {
        packets.push(buildBrightnessPacket(brightness));
      }
    }

    for (const dev of this.devices) {
      for (let i = 0; i < packets.length; i++) {
        await this.sendTo(dev.ip, packets[i]!);
        if (this.interPacketGapMs > 0 && i < packets.length - 1) {
          await this.delay(this.interPacketGapMs);
        }
      }
    }

    this.lastSentState = { on, r, g, b, brightness };
  }

  private sendTo(ip: string, packet: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.socket!.send(packet, 4003, ip, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async getSnapshot(): Promise<LightSnapshot> {
    const snap: GoveeSnapshot = {
      _kind: 'govee',
      capturedAt: this.now(),
      lastFrame: this.lastFrame ? { ...this.lastFrame, rgb: { ...this.lastFrame.rgb } } : null,
    };
    return snap;
  }

  async restore(snapshot: LightSnapshot): Promise<void> {
    if (this.closed) throw new Error('GoveeAdapter is closed');
    const s = snapshot as GoveeSnapshot;
    if (s.lastFrame) {
      // Force a full re-assert of every packet regardless of change-detection
      // — restore exists precisely to re-establish device state.
      this.lastSentState = null;
      this.pendingFrame = s.lastFrame;
      await this.maybeFlush();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.socket) {
      await new Promise<void>((resolve) => {
        this.socket!.close(() => resolve());
      });
      this.socket = null;
    }
  }
}
