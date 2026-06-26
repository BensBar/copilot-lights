import type { LightAdapter, LightFrame, LightSnapshot } from './adapter.js';
import type { HueConfigSchema } from '../config/schema.js';
import { rgbToXy } from '../util/color.js';
import { request, Agent } from 'undici';
import type { Dispatcher } from 'undici';
import type { z } from 'zod';

export interface HueSnapshot extends LightSnapshot {
  _kind: 'hue';
  capturedAt: number;
  lights: Array<{
    id: string;
    on: boolean;
    brightness?: number;
    color?: { x: number; y: number };
  }>;
}

export class HueAdapter implements LightAdapter {
  readonly kind = 'hue';
  private readonly bridgeIp: string;
  private readonly applicationKey: string;
  private readonly lightIds: string[];
  private readonly dispatcher: Dispatcher;
  private closed = false;
  private inFlight = false;
  private pendingFrame: LightFrame | null = null;

  constructor(cfg: z.infer<typeof HueConfigSchema>, opts?: { dispatcher?: Dispatcher }) {
    this.bridgeIp = cfg.bridgeIp;
    this.applicationKey = cfg.applicationKey;
    this.lightIds = cfg.lightIds;

    // Hue bridges ship with self-signed certificates.
    // Standard workaround on LAN: disable cert verification.
    // TODO: For production, consider pinning by fingerprint.
    this.dispatcher =
      opts?.dispatcher ??
      new Agent({
        connect: {
          rejectUnauthorized: false,
        },
      });
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('HueAdapter is closed');
    }

    try {
      const response = await request(`https://${this.bridgeIp}/clip/v2/resource`, {
        method: 'GET',
        headers: {
          'hue-application-key': this.applicationKey,
        },
        dispatcher: this.dispatcher,
        headersTimeout: 5000,
        bodyTimeout: 5000,
      });

      if (response.statusCode === 403) {
        throw new Error(
          `Hue bridge authentication failed (403). The application key may be invalid or not paired. ` +
            `Run "copilot-lights install --hue" and press the bridge button to pair.`
        );
      }

      if (response.statusCode !== 200) {
        throw new Error(`Hue bridge returned status ${response.statusCode}`);
      }

      // Consume response body
      await response.body.text();
    } catch (err: any) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        throw new Error(
          `Cannot connect to Hue bridge at ${this.bridgeIp}. ` +
            `Check the bridgeIp in your config and ensure the bridge is reachable on your network.`
        );
      }
      if (err.message?.includes('certificate')) {
        throw new Error(
          `TLS/certificate error connecting to Hue bridge at ${this.bridgeIp}. ` +
            `Ensure the bridge is reachable and the dispatcher is configured to accept self-signed certificates.`
        );
      }
      throw err;
    }
  }

  async applyFrame(frame: LightFrame): Promise<void> {
    if (this.closed) {
      throw new Error('HueAdapter is closed');
    }

    // Coalescing: if already in flight, just update pending and return
    if (this.inFlight) {
      this.pendingFrame = frame;
      return;
    }

    // Mark in flight and apply
    this.inFlight = true;
    this.pendingFrame = null;

    try {
      await this._applyFrameInternal(frame);

      // If a new frame arrived while we were applying, apply it now
      while (this.pendingFrame !== null) {
        const nextFrame = this.pendingFrame;
        this.pendingFrame = null;
        await this._applyFrameInternal(nextFrame);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async _applyFrameInternal(frame: LightFrame): Promise<void> {
    const xy = rgbToXy(frame.rgb);
    const body = {
      on: { on: true },
      dimming: { brightness: frame.brightness },
      color: { xy: { x: xy.x, y: xy.y } },
      dynamics: { duration: frame.transitionMs ?? 0 },
    };

    const results = await Promise.allSettled(
      this.lightIds.map(async (lightId) => {
        const response = await request(
          `https://${this.bridgeIp}/clip/v2/resource/light/${lightId}`,
          {
            method: 'PUT',
            headers: {
              'hue-application-key': this.applicationKey,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            dispatcher: this.dispatcher,
            headersTimeout: 5000,
            bodyTimeout: 5000,
          }
        );

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const responseBody = await response.body.text();
          throw new Error(
            `Light ${lightId} returned status ${response.statusCode}: ${responseBody}`
          );
        }

        // Consume response body
        await response.body.text();
      })
    );

    // Check for failures
    const failures = results
      .map((result, idx) => ({ result, lightId: this.lightIds[idx]! }))
      .filter((item) => item.result.status === 'rejected');

    if (failures.length > 0) {
      const failedIds = failures.map((f) => f.lightId).join(', ');
      throw new Error(`Failed to apply frame to lights: ${failedIds}`);
    }
  }

  async getSnapshot(): Promise<HueSnapshot> {
    if (this.closed) {
      throw new Error('HueAdapter is closed');
    }

    const results = await Promise.all(
      this.lightIds.map(async (lightId) => {
        const response = await request(
          `https://${this.bridgeIp}/clip/v2/resource/light/${lightId}`,
          {
            method: 'GET',
            headers: {
              'hue-application-key': this.applicationKey,
            },
            dispatcher: this.dispatcher,
            headersTimeout: 5000,
            bodyTimeout: 5000,
          }
        );

        if (response.statusCode !== 200) {
          throw new Error(`Failed to get light ${lightId}: status ${response.statusCode}`);
        }

        const data = await response.body.json();
        const lightData = (data as any).data[0];

        return {
          id: lightId,
          on: lightData.on?.on ?? false,
          brightness: lightData.dimming?.brightness,
          color: lightData.color?.xy
            ? { x: lightData.color.xy.x, y: lightData.color.xy.y }
            : undefined,
        };
      })
    );

    return {
      _kind: 'hue',
      capturedAt: Date.now(),
      lights: results,
    };
  }

  async restore(snapshot: LightSnapshot): Promise<void> {
    if (this.closed) {
      throw new Error('HueAdapter is closed');
    }

    if (snapshot._kind !== 'hue') {
      throw new Error(
        `Cannot restore snapshot of kind "${snapshot._kind}" to HueAdapter (expected "hue")`
      );
    }

    const hueSnapshot = snapshot as HueSnapshot;

    const results = await Promise.allSettled(
      hueSnapshot.lights.map(async (light) => {
        let body: any;

        if (!light.on) {
          body = { on: { on: false } };
        } else {
          body = {
            on: { on: true },
            dimming: { brightness: light.brightness ?? 100 },
          };
          if (light.color) {
            body.color = { xy: { x: light.color.x, y: light.color.y } };
          }
        }

        const response = await request(
          `https://${this.bridgeIp}/clip/v2/resource/light/${light.id}`,
          {
            method: 'PUT',
            headers: {
              'hue-application-key': this.applicationKey,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            dispatcher: this.dispatcher,
            headersTimeout: 5000,
            bodyTimeout: 5000,
          }
        );

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const responseBody = await response.body.text();
          throw new Error(
            `Light ${light.id} returned status ${response.statusCode}: ${responseBody}`
          );
        }

        // Consume response body
        await response.body.text();
      })
    );

    // Check for failures
    const failures = results
      .map((result, idx) => ({ result, light: hueSnapshot.lights[idx]! }))
      .filter((item) => item.result.status === 'rejected');

    if (failures.length > 0) {
      const failedIds = failures.map((f) => f.light.id).join(', ');
      throw new Error(`Failed to restore lights: ${failedIds}`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * Performs the Hue v1 button-press pairing flow against the bridge.
 * The user must press the round button on the bridge within ~30 seconds before calling.
 *
 * On success, returns the assigned application key. On link-button-not-pressed,
 * throws Error with message instructing the user to press it.
 *
 * Endpoint (v1, HTTP not HTTPS for pairing): POST http://<bridgeIp>/api
 * Body: {"devicetype":"copilot-lights#<hostname>"}
 * Response: [{"success":{"username":"<key>"}}] or [{"error":{...,"description":"link button not pressed"}}]
 */
export async function pairWithBridge(
  bridgeIp: string,
  opts?: { dispatcher?: Dispatcher; deviceLabel?: string }
): Promise<{ applicationKey: string }> {
  const hostname = opts?.deviceLabel ?? 'copilot-lights';
  const devicetype = `copilot-lights#${hostname}`;

  const response = await request(`http://${bridgeIp}/api`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ devicetype }),
    dispatcher: opts?.dispatcher,
    headersTimeout: 5000,
    bodyTimeout: 5000,
  });

  if (response.statusCode !== 200) {
    throw new Error(`Pairing request failed with status ${response.statusCode}`);
  }

  const data = await response.body.json();
  const result = (data as any)[0];

  if (result.error) {
    const description = result.error.description || '';
    if (description.toLowerCase().includes('link button')) {
      throw new Error(
        'Link button not pressed. Press the round button on the Hue bridge and try again within 30 seconds.'
      );
    }
    throw new Error(`Pairing failed: ${description}`);
  }

  if (result.success && result.success.username) {
    return { applicationKey: result.success.username };
  }

  throw new Error('Unexpected response from bridge during pairing');
}

// ---------- Discovery + identify (setup helpers) ----------

/** Minimal connection params for setup-time Hue operations (before any
 *  `lightIds` are chosen, so it deliberately does not require a full config). */
export interface HueConnection {
  bridgeIp: string;
  applicationKey: string;
}

/** A light resource as surfaced to the setup UI. */
export interface HueDiscoveredLight {
  /** CLIP v2 light resource id (the value persisted in config.hue.lightIds). */
  id: string;
  /** Friendly name from the bridge (room/device label). */
  name: string;
  /** Optional archetype hint (e.g. "table_shade", "hue_go"), useful for icons. */
  archetype?: string;
}

function hueDispatcher(opts?: { dispatcher?: Dispatcher }): Dispatcher {
  // Hue bridges use self-signed certificates on the LAN.
  return opts?.dispatcher ?? new Agent({ connect: { rejectUnauthorized: false } });
}

/**
 * List every light the Hue bridge exposes so the user can pick which ones
 * Copilot Lights should drive. Requires only the bridge IP + application key.
 * Never returns partial junk — throws with a clear message on auth/HTTP errors.
 */
export async function discoverHueLights(
  conn: HueConnection | undefined,
  opts?: { dispatcher?: Dispatcher }
): Promise<HueDiscoveredLight[]> {
  if (!conn?.bridgeIp || !conn?.applicationKey) {
    throw new Error('Hue is not configured — set the bridge IP and pair to get an application key first.');
  }
  const dispatcher = hueDispatcher(opts);
  const response = await request(`https://${conn.bridgeIp}/clip/v2/resource/light`, {
    method: 'GET',
    headers: { 'hue-application-key': conn.applicationKey },
    dispatcher,
    headersTimeout: 5000,
    bodyTimeout: 5000,
  });
  if (response.statusCode === 403) {
    throw new Error('Hue bridge rejected the application key (403). Re-pair the bridge.');
  }
  if (response.statusCode !== 200) {
    throw new Error(`Hue bridge returned status ${response.statusCode} listing lights.`);
  }
  const data = (await response.body.json()) as { data?: unknown };
  const list = Array.isArray(data.data) ? data.data : [];
  const lights: HueDiscoveredLight[] = [];
  for (const item of list) {
    const l = item as {
      id?: unknown;
      metadata?: { name?: unknown; archetype?: unknown };
    };
    if (typeof l.id !== 'string') continue;
    lights.push({
      id: l.id,
      name: typeof l.metadata?.name === 'string' ? l.metadata.name : 'Hue light',
      archetype: typeof l.metadata?.archetype === 'string' ? l.metadata.archetype : undefined,
    });
  }
  return lights;
}

/**
 * Make a single Hue light visibly blink so the user can locate it. Uses the
 * bridge's native `identify` action (a gentle breathe) which automatically
 * returns the light to its prior state — no manual restore needed.
 */
export async function blinkHueLight(
  conn: HueConnection | undefined,
  lightId: string,
  opts?: { dispatcher?: Dispatcher }
): Promise<void> {
  if (!conn?.bridgeIp || !conn?.applicationKey) {
    throw new Error('Hue is not configured — set the bridge IP and pair first.');
  }
  const dispatcher = hueDispatcher(opts);
  const response = await request(`https://${conn.bridgeIp}/clip/v2/resource/light/${lightId}`, {
    method: 'PUT',
    headers: {
      'hue-application-key': conn.applicationKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ identify: { action: 'identify' } }),
    dispatcher,
    headersTimeout: 5000,
    bodyTimeout: 5000,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const text = await response.body.text();
    throw new Error(`Hue identify failed for ${lightId}: status ${response.statusCode} ${text}`);
  }
  await response.body.text();
}
