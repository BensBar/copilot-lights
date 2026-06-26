import { describe, it, expect, beforeEach } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { HueAdapter, pairWithBridge, discoverHueLights, blinkHueLight } from '../../../src/adapters/hue.js';
import type { HueSnapshot } from '../../../src/adapters/hue.js';
import type { LightFrame } from '../../../src/adapters/adapter.js';
import { rgbToXy } from '../../../src/util/color.js';

describe('HueAdapter', () => {
  let agent: MockAgent;
  let adapter: HueAdapter;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  describe('connect', () => {
    it('should connect successfully on 200 response', async () => {
      const pool = agent.get('https://192.168.1.42');
      pool
        .intercept({ path: '/clip/v2/resource', method: 'GET' })
        .reply(200, { data: [] });

      adapter = new HueAdapter(
        {
          bridgeIp: '192.168.1.42',
          applicationKey: 'test-key',
          lightIds: ['uuid-a'],
        },
        { dispatcher: agent }
      );

      await expect(adapter.connect()).resolves.toBeUndefined();
    });

    it('should throw helpful error on 403 (invalid application key)', async () => {
      const pool = agent.get('https://192.168.1.42');
      pool
        .intercept({ path: '/clip/v2/resource', method: 'GET' })
        .reply(403, { errors: [] });

      adapter = new HueAdapter(
        {
          bridgeIp: '192.168.1.42',
          applicationKey: 'invalid-key',
          lightIds: ['uuid-a'],
        },
        { dispatcher: agent }
      );

      await expect(adapter.connect()).rejects.toThrow(/authentication failed.*403.*pair/i);
    });

    it('should throw helpful error on connection refused', async () => {
      const pool = agent.get('https://192.168.1.99');
      pool
        .intercept({ path: '/clip/v2/resource', method: 'GET' })
        .replyWithError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

      adapter = new HueAdapter(
        {
          bridgeIp: '192.168.1.99',
          applicationKey: 'test-key',
          lightIds: ['uuid-a'],
        },
        { dispatcher: agent }
      );

      await expect(adapter.connect()).rejects.toThrow(/cannot connect.*192\.168\.1\.99.*bridgeIp/i);
    });
  });

  describe('applyFrame', () => {
    beforeEach(() => {
      const pool = agent.get('https://192.168.1.42');
      pool
        .intercept({ path: '/clip/v2/resource', method: 'GET' })
        .reply(200, { data: [] });

      adapter = new HueAdapter(
        {
          bridgeIp: '192.168.1.42',
          applicationKey: 'test-key',
          lightIds: ['uuid-a'],
        },
        { dispatcher: agent }
      );
    });

    it('should PUT correct body with brightness 0..100, xy color, and transition', async () => {
      const pool = agent.get('https://192.168.1.42');

      const frame: LightFrame = {
        rgb: { r: 255, g: 0, b: 0 },
        brightness: 75,
        transitionMs: 500,
      };

      const expectedXy = rgbToXy({ r: 255, g: 0, b: 0 });

      pool
        .intercept({ path: '/clip/v2/resource/light/uuid-a', method: 'PUT' })
        .reply(200, (opts) => {
          const body = JSON.parse(opts.body as string);
          expect(body.on.on).toBe(true);
          expect(body.dimming.brightness).toBe(75);
          expect(body.color.xy.x).toBeCloseTo(expectedXy.x, 3);
          expect(body.color.xy.y).toBeCloseTo(expectedXy.y, 3);
          expect(body.dynamics.duration).toBe(500);
          return { data: [] };
        });

      await adapter.applyFrame(frame);
    });

    it('should apply frame to two lights in parallel', async () => {
      const pool = agent.get('https://192.168.1.42');
      pool
        .intercept({ path: '/clip/v2/resource', method: 'GET' })
        .reply(200, { data: [] });

      adapter = new HueAdapter(
        {
          bridgeIp: '192.168.1.42',
          applicationKey: 'test-key',
          lightIds: ['uuid-a', 'uuid-b'],
        },
        { dispatcher: agent }
      );

      const frame: LightFrame = {
        rgb: { r: 0, g: 255, b: 0 },
        brightness: 50,
      };

      let aHit = false;
      let bHit = false;

      pool
        .intercept({ path: '/clip/v2/resource/light/uuid-a', method: 'PUT' })
        .reply(200, () => {
          aHit = true;
          return { data: [] };
        });

      pool
        .intercept({ path: '/clip/v2/resource/light/uuid-b', method: 'PUT' })
        .reply(200, () => {
          bHit = true;
          return { data: [] };
        });

      await adapter.applyFrame(frame);

      expect(aHit).toBe(true);
      expect(bHit).toBe(true);
    });

    it('should throw when one light returns 500, listing the failing ID', async () => {
      const pool = agent.get('https://192.168.1.42');
      pool
        .intercept({ path: '/clip/v2/resource', method: 'GET' })
        .reply(200, { data: [] });

      adapter = new HueAdapter(
        {
          bridgeIp: '192.168.1.42',
          applicationKey: 'test-key',
          lightIds: ['uuid-a', 'uuid-b'],
        },
        { dispatcher: agent }
      );

      const frame: LightFrame = {
        rgb: { r: 100, g: 100, b: 100 },
        brightness: 50,
      };

      pool
        .intercept({ path: '/clip/v2/resource/light/uuid-a', method: 'PUT' })
        .reply(200, { data: [] });

      pool
        .intercept({ path: '/clip/v2/resource/light/uuid-b', method: 'PUT' })
        .reply(500, { error: 'Internal error' });

      await expect(adapter.applyFrame(frame)).rejects.toThrow(/failed.*uuid-b/i);
    });

    it('should coalesce rapid applyFrame calls (first + last pending)', async () => {
      const pool = agent.get('https://192.168.1.42');

      const appliedFrames: number[] = [];

      // First call - slow (100ms)
      pool
        .intercept({ path: '/clip/v2/resource/light/uuid-a', method: 'PUT' })
        .reply(200, async (opts) => {
          const body = JSON.parse(opts.body as string);
          appliedFrames.push(body.dimming.brightness);
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { data: [] };
        });

      // Subsequent calls
      pool
        .intercept({ path: '/clip/v2/resource/light/uuid-a', method: 'PUT' })
        .reply(200, (opts) => {
          const body = JSON.parse(opts.body as string);
          appliedFrames.push(body.dimming.brightness);
          return { data: [] };
        })
        .times(10);

      const frame1: LightFrame = { rgb: { r: 255, g: 0, b: 0 }, brightness: 10 };
      const frame2: LightFrame = { rgb: { r: 255, g: 0, b: 0 }, brightness: 20 };
      const frame3: LightFrame = { rgb: { r: 255, g: 0, b: 0 }, brightness: 30 };
      const frame4: LightFrame = { rgb: { r: 255, g: 0, b: 0 }, brightness: 40 };

      // Fire all rapidly
      const p1 = adapter.applyFrame(frame1);
      const p2 = adapter.applyFrame(frame2);
      const p3 = adapter.applyFrame(frame3);
      const p4 = adapter.applyFrame(frame4);

      await Promise.all([p1, p2, p3, p4]);

      // Should have applied first (10) + last pending (40), intermediate dropped
      expect(appliedFrames).toEqual([10, 40]);
    });
  });

  describe('getSnapshot', () => {
    beforeEach(() => {
      const pool = agent.get('https://192.168.1.42');
      pool
        .intercept({ path: '/clip/v2/resource', method: 'GET' })
        .reply(200, { data: [] });

      adapter = new HueAdapter(
        {
          bridgeIp: '192.168.1.42',
          applicationKey: 'test-key',
          lightIds: ['uuid-a'],
        },
        { dispatcher: agent }
      );
    });

    it('should return snapshot with correct shape from CLIP v2 response', async () => {
      const pool = agent.get('https://192.168.1.42');

      pool
        .intercept({ path: '/clip/v2/resource/light/uuid-a', method: 'GET' })
        .reply(200, {
          data: [
            {
              id: 'uuid-a',
              on: { on: true },
              dimming: { brightness: 50 },
              color: { xy: { x: 0.3, y: 0.4 } },
            },
          ],
        });

      const snapshot = (await adapter.getSnapshot()) as HueSnapshot;

      expect(snapshot._kind).toBe('hue');
      expect(snapshot.capturedAt).toBeGreaterThan(0);
      expect(snapshot.lights).toHaveLength(1);
      expect(snapshot.lights[0]).toEqual({
        id: 'uuid-a',
        on: true,
        brightness: 50,
        color: { x: 0.3, y: 0.4 },
      });
    });

    it('should handle light that is off', async () => {
      const pool = agent.get('https://192.168.1.42');

      pool
        .intercept({ path: '/clip/v2/resource/light/uuid-a', method: 'GET' })
        .reply(200, {
          data: [
            {
              id: 'uuid-a',
              on: { on: false },
            },
          ],
        });

      const snapshot = (await adapter.getSnapshot()) as HueSnapshot;

      expect(snapshot.lights[0]).toEqual({
        id: 'uuid-a',
        on: false,
        brightness: undefined,
        color: undefined,
      });
    });
  });

  describe('restore', () => {
    beforeEach(() => {
      const pool = agent.get('https://192.168.1.42');
      pool
        .intercept({ path: '/clip/v2/resource', method: 'GET' })
        .reply(200, { data: [] });

      adapter = new HueAdapter(
        {
          bridgeIp: '192.168.1.42',
          applicationKey: 'test-key',
          lightIds: ['uuid-a'],
        },
        { dispatcher: agent }
      );
    });

    it('should restore on:true light with correct body', async () => {
      const pool = agent.get('https://192.168.1.42');

      const snapshot: HueSnapshot = {
        _kind: 'hue',
        capturedAt: Date.now(),
        lights: [
          {
            id: 'uuid-a',
            on: true,
            brightness: 80,
            color: { x: 0.5, y: 0.5 },
          },
        ],
      };

      pool
        .intercept({ path: '/clip/v2/resource/light/uuid-a', method: 'PUT' })
        .reply(200, (opts) => {
          const body = JSON.parse(opts.body as string);
          expect(body.on.on).toBe(true);
          expect(body.dimming.brightness).toBe(80);
          expect(body.color.xy.x).toBe(0.5);
          expect(body.color.xy.y).toBe(0.5);
          return { data: [] };
        });

      await adapter.restore(snapshot);
    });

    it('should restore on:false light with correct body', async () => {
      const pool = agent.get('https://192.168.1.42');

      const snapshot: HueSnapshot = {
        _kind: 'hue',
        capturedAt: Date.now(),
        lights: [
          {
            id: 'uuid-a',
            on: false,
          },
        ],
      };

      pool
        .intercept({ path: '/clip/v2/resource/light/uuid-a', method: 'PUT' })
        .reply(200, (opts) => {
          const body = JSON.parse(opts.body as string);
          expect(body.on.on).toBe(false);
          expect(body.dimming).toBeUndefined();
          expect(body.color).toBeUndefined();
          return { data: [] };
        });

      await adapter.restore(snapshot);
    });

    it('should throw when snapshot _kind is wrong', async () => {
      const wrongSnapshot = {
        _kind: 'mock',
        capturedAt: Date.now(),
      };

      await expect(adapter.restore(wrongSnapshot)).rejects.toThrow(
        /cannot restore.*mock.*expected.*hue/i
      );
    });
  });

  describe('close', () => {
    beforeEach(() => {
      const pool = agent.get('https://192.168.1.42');
      pool
        .intercept({ path: '/clip/v2/resource', method: 'GET' })
        .reply(200, { data: [] });

      adapter = new HueAdapter(
        {
          bridgeIp: '192.168.1.42',
          applicationKey: 'test-key',
          lightIds: ['uuid-a'],
        },
        { dispatcher: agent }
      );
    });

    it('should make subsequent calls throw', async () => {
      await adapter.close();

      await expect(adapter.connect()).rejects.toThrow(/closed/i);
      await expect(
        adapter.applyFrame({ rgb: { r: 0, g: 0, b: 0 }, brightness: 0 })
      ).rejects.toThrow(/closed/i);
      await expect(adapter.getSnapshot()).rejects.toThrow(/closed/i);
      
      const emptySnapshot: HueSnapshot = { _kind: 'hue', capturedAt: 0, lights: [] };
      await expect(adapter.restore(emptySnapshot)).rejects.toThrow(/closed/i);
    });
  });
});

describe('pairWithBridge', () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  it('should return application key on success', async () => {
    const pool = agent.get('http://192.168.1.42');

    pool
      .intercept({ path: '/api', method: 'POST' })
      .reply(200, [{ success: { username: 'my-app-key-12345' } }]);

    const result = await pairWithBridge('192.168.1.42', { dispatcher: agent });

    expect(result.applicationKey).toBe('my-app-key-12345');
  });

  it('should throw with instruction when link button not pressed', async () => {
    const pool = agent.get('http://192.168.1.42');

    pool
      .intercept({ path: '/api', method: 'POST' })
      .reply(200, [{ error: { type: 101, description: 'link button not pressed' } }]);

    await expect(pairWithBridge('192.168.1.42', { dispatcher: agent })).rejects.toThrow(
      /link button not pressed.*press.*bridge/i
    );
  });

  it('should use custom deviceLabel in devicetype', async () => {
    const pool = agent.get('http://192.168.1.42');

    pool
      .intercept({ path: '/api', method: 'POST' })
      .reply(200, (opts) => {
        const body = JSON.parse(opts.body as string);
        expect(body.devicetype).toBe('copilot-lights#my-hostname');
        return [{ success: { username: 'key' } }];
      });

    await pairWithBridge('192.168.1.42', {
      dispatcher: agent,
      deviceLabel: 'my-hostname',
    });
  });
});

describe('registry integration', () => {
  it('should create HueAdapter from registry', async () => {
    const { createAdapter } = await import('../../../src/adapters/registry.js');

    const adapter = createAdapter({
      adapter: 'hue',
      hue: {
        bridgeIp: '192.168.1.42',
        applicationKey: 'test-key',
        lightIds: ['uuid-a'],
      },
      states: {},
      transitionMs: 600,
      restoreOnExit: true,
      errorTtlMs: 4000,
      doneTtlMs: 1500,
    });

    expect(adapter.kind).toBe('hue');
    expect(adapter).toBeInstanceOf(HueAdapter);

    await adapter.close();
  });
});

describe('discoverHueLights', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  it('lists lights with id, name and archetype', async () => {
    agent
      .get('https://192.168.1.42')
      .intercept({ path: '/clip/v2/resource/light', method: 'GET' })
      .reply(200, {
        data: [
          { id: 'uuid-a', metadata: { name: 'Desk', archetype: 'table_shade' } },
          { id: 'uuid-b', metadata: { name: 'Ceiling' } },
          { notALight: true },
        ],
      });
    const lights = await discoverHueLights(
      { bridgeIp: '192.168.1.42', applicationKey: 'k' },
      { dispatcher: agent }
    );
    expect(lights).toEqual([
      { id: 'uuid-a', name: 'Desk', archetype: 'table_shade' },
      { id: 'uuid-b', name: 'Ceiling', archetype: undefined },
    ]);
  });

  it('throws a clear error when not configured', async () => {
    await expect(discoverHueLights(undefined)).rejects.toThrow(/not configured/i);
  });

  it('throws on a 403 from the bridge', async () => {
    agent
      .get('https://192.168.1.42')
      .intercept({ path: '/clip/v2/resource/light', method: 'GET' })
      .reply(403, {});
    await expect(
      discoverHueLights({ bridgeIp: '192.168.1.42', applicationKey: 'bad' }, { dispatcher: agent })
    ).rejects.toThrow(/403|re-pair/i);
  });
});

describe('blinkHueLight', () => {
  let agent: MockAgent;
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  it('PUTs the native identify action to the light', async () => {
    let sawBody: any;
    agent
      .get('https://192.168.1.42')
      .intercept({ path: '/clip/v2/resource/light/uuid-a', method: 'PUT' })
      .reply(200, (opts) => {
        sawBody = JSON.parse(opts.body as string);
        return { data: [] };
      });
    await blinkHueLight({ bridgeIp: '192.168.1.42', applicationKey: 'k' }, 'uuid-a', {
      dispatcher: agent,
    });
    expect(sawBody).toEqual({ identify: { action: 'identify' } });
  });
});
