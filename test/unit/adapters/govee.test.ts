import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  GoveeAdapter,
  buildDiscoveryPacket,
  buildTurnPacket,
  buildBrightnessPacket,
  buildColorPacket,
  parseDiscoveryResponse,
  blinkGoveeDevice,
} from '../../../src/adapters/govee.js';
import type { LightFrame } from '../../../src/adapters/adapter.js';

interface SentPacket {
  msg: Buffer;
  port: number;
  ip: string;
}

class FakeSocket extends EventEmitter {
  sent: SentPacket[] = [];
  closed = false;

  bind(_port: number, cb?: () => void): void {
    if (cb) setImmediate(cb);
  }
  setBroadcast(_b: boolean): void {}
  setMulticastLoopback(_b: boolean): void {}
  send(msg: Buffer, port: number, ip: string, cb?: (err: Error | null) => void): void {
    this.sent.push({ msg: Buffer.from(msg), port, ip });
    if (cb) setImmediate(() => cb(null));
  }
  close(cb?: () => void): void {
    this.closed = true;
    if (cb) setImmediate(cb);
  }
  // dgram.Socket signatures we use:
  on(event: 'message', listener: (msg: Buffer, rinfo: any) => void): this;
  on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  removeListener(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.removeListener(event, listener as (...args: unknown[]) => void);
  }
}

describe('Govee adapter', () => {
  describe('packet builders', () => {
    it('discovery packet has the documented multicast scan shape', () => {
      const buf = buildDiscoveryPacket();
      const obj = JSON.parse(buf.toString('utf8'));
      expect(obj).toEqual({ msg: { cmd: 'scan', data: { account_topic: 'reserve' } } });
    });

    it('turn packet maps boolean to 1/0', () => {
      expect(JSON.parse(buildTurnPacket(true).toString())).toEqual({
        msg: { cmd: 'turn', data: { value: 1 } },
      });
      expect(JSON.parse(buildTurnPacket(false).toString())).toEqual({
        msg: { cmd: 'turn', data: { value: 0 } },
      });
    });

    it('brightness packet clamps and rounds to integer 0..100', () => {
      expect(JSON.parse(buildBrightnessPacket(-50).toString())).toEqual({
        msg: { cmd: 'brightness', data: { value: 0 } },
      });
      expect(JSON.parse(buildBrightnessPacket(150).toString())).toEqual({
        msg: { cmd: 'brightness', data: { value: 100 } },
      });
      expect(JSON.parse(buildBrightnessPacket(33.6).toString())).toEqual({
        msg: { cmd: 'brightness', data: { value: 34 } },
      });
    });

    it('color packet clamps RGB and uses colorwc cmd', () => {
      const packet = buildColorPacket(255, 100, -10);
      expect(JSON.parse(packet.toString())).toEqual({
        msg: {
          cmd: 'colorwc',
          data: {
            color: { r: 255, g: 100, b: 0 },
            colorTemInKelvin: 0,
          },
        },
      });
    });
  });

  describe('parseDiscoveryResponse', () => {
    it('extracts ip/sku/mac from a well-formed reply', () => {
      const buf = Buffer.from(JSON.stringify({
        msg: {
          cmd: 'scan',
          data: { ip: '192.168.1.50', sku: 'H6008', device: 'AA:BB:CC:DD:EE:FF' },
        },
      }));
      expect(parseDiscoveryResponse(buf)).toEqual({
        ip: '192.168.1.50',
        sku: 'H6008',
        mac: 'AA:BB:CC:DD:EE:FF',
      });
    });

    it('returns null for malformed JSON', () => {
      expect(parseDiscoveryResponse(Buffer.from('garbage'))).toBeNull();
    });

    it('returns null when cmd is not "scan"', () => {
      const buf = Buffer.from(JSON.stringify({ msg: { cmd: 'turn', data: { ip: '1.2.3.4' } } }));
      expect(parseDiscoveryResponse(buf)).toBeNull();
    });

    it('returns null when ip is missing', () => {
      const buf = Buffer.from(JSON.stringify({ msg: { cmd: 'scan', data: {} } }));
      expect(parseDiscoveryResponse(buf)).toBeNull();
    });
  });

  describe('GoveeAdapter', () => {
    let socket: FakeSocket;
    let adapter: GoveeAdapter;

    beforeEach(() => {
      socket = new FakeSocket();
    });

    it('connect() seeds devices from config and binds the socket', async () => {
      adapter = new GoveeAdapter(
        { devices: [{ ip: '10.0.0.5', sku: 'H6160' }], discoveryTimeoutMs: 0 },
        { socketFactory: () => socket as any }
      );
      await adapter.connect();
      // Discovery was disabled (timeout=0) so no discovery packet sent.
      expect(socket.sent).toHaveLength(0);
      await adapter.close();
      expect(socket.closed).toBe(true);
    });

    it('applyFrame sends turn → color → brightness to each device', async () => {
      adapter = new GoveeAdapter(
        { devices: [{ ip: '10.0.0.5' }, { ip: '10.0.0.6' }], discoveryTimeoutMs: 0 },
        { socketFactory: () => socket as any, minSendIntervalMs: 0, interPacketGapMs: 0 }
      );
      await adapter.connect();
      const frame: LightFrame = { rgb: { r: 255, g: 0, b: 128 }, brightness: 60 };
      await adapter.applyFrame(frame);

      // 3 packets per device × 2 devices = 6
      expect(socket.sent).toHaveLength(6);
      // First packet to first device should be the "turn on" packet.
      const first = JSON.parse(socket.sent[0]!.msg.toString());
      expect(first).toEqual({ msg: { cmd: 'turn', data: { value: 1 } } });
      expect(socket.sent[0]!.ip).toBe('10.0.0.5');
      expect(socket.sent[0]!.port).toBe(4003);
      // Second is colour.
      const second = JSON.parse(socket.sent[1]!.msg.toString());
      expect(second.msg.cmd).toBe('colorwc');
      // Third is brightness.
      const third = JSON.parse(socket.sent[2]!.msg.toString());
      expect(third.msg.cmd).toBe('brightness');
      // Fourth wraps around to second device.
      expect(socket.sent[3]!.ip).toBe('10.0.0.6');
    });

    it('applyFrame with brightness 0 only sends turn-off (no color/brightness)', async () => {
      adapter = new GoveeAdapter(
        { devices: [{ ip: '10.0.0.5' }], discoveryTimeoutMs: 0 },
        { socketFactory: () => socket as any, minSendIntervalMs: 0, interPacketGapMs: 0 }
      );
      await adapter.connect();
      await adapter.applyFrame({ rgb: { r: 0, g: 255, b: 0 }, brightness: 0 });
      expect(socket.sent).toHaveLength(1);
      const obj = JSON.parse(socket.sent[0]!.msg.toString());
      expect(obj.msg.cmd).toBe('turn');
      expect(obj.msg.data.value).toBe(0);
    });

    it('only re-sends the packets that changed between frames', async () => {
      adapter = new GoveeAdapter(
        { devices: [{ ip: '10.0.0.5' }], discoveryTimeoutMs: 0 },
        { socketFactory: () => socket as any, minSendIntervalMs: 0, interPacketGapMs: 0 }
      );
      await adapter.connect();
      const cmds = () => socket.sent.map((p) => JSON.parse(p.msg.toString()).msg.cmd);

      // First frame: full burst (turn + colorwc + brightness).
      await adapter.applyFrame({ rgb: { r: 255, g: 0, b: 0 }, brightness: 50 });
      expect(cmds()).toEqual(['turn', 'colorwc', 'brightness']);

      // Identical frame: nothing changes → no packets.
      socket.sent.length = 0;
      await adapter.applyFrame({ rgb: { r: 255, g: 0, b: 0 }, brightness: 50 });
      expect(cmds()).toEqual([]);

      // Brightness-only change (the breathe case): just a brightness packet,
      // no re-sent turn (which makes some bulbs flicker) and no colour.
      socket.sent.length = 0;
      await adapter.applyFrame({ rgb: { r: 255, g: 0, b: 0 }, brightness: 80 });
      expect(cmds()).toEqual(['brightness']);

      // Colour-only change: just a colorwc packet.
      socket.sent.length = 0;
      await adapter.applyFrame({ rgb: { r: 0, g: 255, b: 0 }, brightness: 80 });
      expect(cmds()).toEqual(['colorwc']);

      // Turn off: single turn-off packet.
      socket.sent.length = 0;
      await adapter.applyFrame({ rgb: { r: 0, g: 255, b: 0 }, brightness: 0 });
      expect(cmds()).toEqual(['turn']);

      // Turn back on: full burst again (colour re-asserted on power-on).
      socket.sent.length = 0;
      await adapter.applyFrame({ rgb: { r: 0, g: 255, b: 0 }, brightness: 80 });
      expect(cmds()).toEqual(['turn', 'colorwc', 'brightness']);
    });

    it('throttles a burst of frames to one send + a trailing flush of the latest', async () => {
      adapter = new GoveeAdapter(
        { devices: [{ ip: '10.0.0.5' }], discoveryTimeoutMs: 0 },
        { socketFactory: () => socket as any, minSendIntervalMs: 50, interPacketGapMs: 0 }
      );
      await adapter.connect();

      const colorsSent = () =>
        socket.sent
          .map((p) => JSON.parse(p.msg.toString()))
          .filter((o) => o.msg.cmd === 'colorwc')
          .map((o) => o.msg.data.color);

      // First frame sends immediately.
      await adapter.applyFrame({ rgb: { r: 255, g: 0, b: 0 }, brightness: 50 });
      // Two more within the throttle window — these coalesce; only the last
      // (blue) should survive to the trailing flush. Green is dropped.
      await adapter.applyFrame({ rgb: { r: 0, g: 255, b: 0 }, brightness: 50 });
      await adapter.applyFrame({ rgb: { r: 0, g: 0, b: 255 }, brightness: 50 });

      // Before the window elapses, only red has been sent.
      expect(colorsSent()).toEqual([{ r: 255, g: 0, b: 0 }]);

      // After the window, the trailing flush sends the latest (blue) only.
      await new Promise((r) => setTimeout(r, 80));
      expect(colorsSent()).toEqual([
        { r: 255, g: 0, b: 0 },
        { r: 0, g: 0, b: 255 },
      ]);
    });

    it('spaces packets within a burst by interPacketGapMs', async () => {
      const gaps: number[] = [];
      adapter = new GoveeAdapter(
        { devices: [{ ip: '10.0.0.5' }], discoveryTimeoutMs: 0 },
        {
          socketFactory: () => socket as any,
          minSendIntervalMs: 0,
          interPacketGapMs: 40,
          delay: async (ms: number) => { gaps.push(ms); },
        }
      );
      await adapter.connect();
      // Full burst = 3 packets → 2 inter-packet gaps.
      await adapter.applyFrame({ rgb: { r: 1, g: 2, b: 3 }, brightness: 50 });
      expect(gaps).toEqual([40, 40]);
    });

    it('discover() collects responses received during the timeout window', async () => {
      adapter = new GoveeAdapter(
        { devices: [], discoveryTimeoutMs: 0 },
        { socketFactory: () => socket as any }
      );
      await adapter.connect();
      // Fire a fake response shortly after discover() starts.
      const response = Buffer.from(JSON.stringify({
        msg: { cmd: 'scan', data: { ip: '10.0.0.99', sku: 'H6008', device: 'AA:BB:CC:00:11:22' } },
      }));
      setTimeout(() => socket.emit('message', response, { address: '10.0.0.99', port: 4002 } as any), 20);
      const found = await adapter.discover(80);
      expect(found).toEqual([{ ip: '10.0.0.99', sku: 'H6008', mac: 'AA:BB:CC:00:11:22' }]);
    });

    it('snapshot/restore round-trips the most recent frame', async () => {
      adapter = new GoveeAdapter(
        { devices: [{ ip: '10.0.0.5' }], discoveryTimeoutMs: 0 },
        { socketFactory: () => socket as any, minSendIntervalMs: 0, interPacketGapMs: 0 }
      );
      await adapter.connect();
      const f: LightFrame = { rgb: { r: 10, g: 20, b: 30 }, brightness: 40 };
      await adapter.applyFrame(f);
      const snap = await adapter.getSnapshot();
      socket.sent.length = 0;
      await adapter.restore(snap);
      // Restore should re-send the same frame
      const colorSent = socket.sent
        .map((p) => JSON.parse(p.msg.toString()))
        .find((o) => o.msg.cmd === 'colorwc');
      expect(colorSent.msg.data.color).toEqual({ r: 10, g: 20, b: 30 });
    });

    it('applyFrame after close throws', async () => {
      adapter = new GoveeAdapter(
        { devices: [{ ip: '10.0.0.5' }], discoveryTimeoutMs: 0 },
        { socketFactory: () => socket as any }
      );
      await adapter.connect();
      await adapter.close();
      await expect(adapter.applyFrame({ rgb: { r: 1, g: 2, b: 3 }, brightness: 50 })).rejects.toThrow();
    });
  });

  describe('blinkGoveeDevice', () => {
    it('flashes the target IP and ends bright, then closes the socket', async () => {
      const socket = new FakeSocket();
      await blinkGoveeDevice('10.0.0.9', {
        cycles: 2,
        socketFactory: () => socket as any,
        delay: async () => {},
      });
      // All packets went to the one target on the control port 4003.
      expect(socket.sent.length).toBeGreaterThan(0);
      expect(socket.sent.every((p) => p.ip === '10.0.0.9' && p.port === 4003)).toBe(true);
      // Two cycles => two "turn off" packets.
      const offs = socket.sent.filter(
        (p) => JSON.parse(p.msg.toString()).msg.cmd === 'turn' && JSON.parse(p.msg.toString()).msg.data.value === 0
      );
      expect(offs.length).toBe(2);
      // Final packet leaves it on (turn=1) so it's easy to find.
      const last3 = socket.sent.slice(-3).map((p) => JSON.parse(p.msg.toString()).msg);
      expect(last3.some((m) => m.cmd === 'turn' && m.data.value === 1)).toBe(true);
      expect(socket.closed).toBe(true);
    });
  });
});
