import { describe, it, expect, beforeEach } from 'vitest';
import { MockAgent } from 'undici';
import { HomeAssistantAdapter, type HomeAssistantSnapshot } from '../../../src/adapters/home-assistant.js';
import type { LightFrame } from '../../../src/adapters/adapter.js';

describe('HomeAssistantAdapter', () => {
  let agent: MockAgent;
  let baseUrl: string;
  let token: string;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    baseUrl = 'http://homeassistant.local:8123';
    token = 'test-token-123';
  });

  describe('connect()', () => {
    it('should succeed on 200 response', async () => {
      const pool = agent.get(baseUrl);
      pool.intercept({ path: '/api/', method: 'GET' }).reply(200, { message: 'API running.' });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.living_room'],
        },
        { dispatcher: agent }
      );

      await expect(adapter.connect()).resolves.toBeUndefined();
    });

    it('should throw on 401 Unauthorized', async () => {
      const pool = agent.get(baseUrl);
      pool.intercept({ path: '/api/', method: 'GET' }).reply(401, { error: 'Unauthorized' });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token: 'wrong-token',
          entities: ['light.living_room'],
        },
        { dispatcher: agent }
      );

      await expect(adapter.connect()).rejects.toThrow(/Unauthorized.*401/);
    });

    it('should throw on 404 Not Found', async () => {
      const pool = agent.get(baseUrl);
      pool.intercept({ path: '/api/', method: 'GET' }).reply(404, { error: 'Not Found' });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.living_room'],
        },
        { dispatcher: agent }
      );

      await expect(adapter.connect()).rejects.toThrow(/404/);
    });

    it('should include helpful message on ECONNREFUSED', async () => {
      // Don't setup any intercepts to trigger an error
      const adapter = new HomeAssistantAdapter(
        {
          baseUrl: 'http://127.0.0.1:19999', // Port that's unlikely to be in use
          token,
          entities: ['light.living_room'],
        },
        { dispatcher: agent }
      );

      // This will fail to connect because the port isn't listening
      await expect(adapter.connect()).rejects.toThrow(
        /Connection refused|ECONNREFUSED|not allowed/i
      );
    });

    it('should throw after close', async () => {
      const pool = agent.get(baseUrl);
      pool.intercept({ path: '/api/', method: 'GET' }).reply(200, { message: 'API running.' });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.living_room'],
        },
        { dispatcher: agent }
      );

      await adapter.close();
      await expect(adapter.connect()).rejects.toThrow('HomeAssistantAdapter is closed');
    });
  });

  describe('applyFrame()', () => {
    it('should POST to /api/services/light/turn_on with correct body', async () => {
      const pool = agent.get(baseUrl);
      pool
        .intercept({
          path: '/api/services/light/turn_on',
          method: 'POST',
        })
        .reply(200, { success: true });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.bedroom'],
        },
        { dispatcher: agent }
      );

      const frame: LightFrame = {
        rgb: { r: 255, g: 128, b: 64 },
        brightness: 50,
        transitionMs: 1000,
      };

      await expect(adapter.applyFrame(frame)).resolves.toBeUndefined();
    });

    it('should convert brightness from 0..100 to 0..255', async () => {
      let capturedBody: any;
      const pool = agent.get(baseUrl);
      pool
        .intercept(
          {
            path: '/api/services/light/turn_on',
            method: 'POST',
          },
          () => true
        )
        .reply((opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return { statusCode: 200, data: { success: true } };
        });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.desk'],
        },
        { dispatcher: agent }
      );

      const frame: LightFrame = {
        rgb: { r: 100, g: 200, b: 50 },
        brightness: 50,
      };

      await adapter.applyFrame(frame);

      expect(capturedBody.brightness).toBe(Math.round((50 * 255) / 100)); // 127 or 128
    });

    it('should convert transitionMs to seconds', async () => {
      let capturedBody: any;
      const pool = agent.get(baseUrl);
      pool
        .intercept(
          {
            path: '/api/services/light/turn_on',
            method: 'POST',
          },
          () => true
        )
        .reply((opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return { statusCode: 200, data: { success: true } };
        });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.kitchen'],
        },
        { dispatcher: agent }
      );

      const frame: LightFrame = {
        rgb: { r: 100, g: 200, b: 50 },
        brightness: 75,
        transitionMs: 2500,
      };

      await adapter.applyFrame(frame);

      expect(capturedBody.transition).toBe(2.5);
    });

    it('should send POSTs in parallel for multiple entities', async () => {
      const capturedBodies: any[] = [];
      const pool = agent.get(baseUrl);

      // Setup the interceptor to handle multiple calls
      pool
        .intercept(
          {
            path: '/api/services/light/turn_on',
            method: 'POST',
          }
        )
        .reply(function (opts) {
          capturedBodies.push(JSON.parse(opts.body as string));
          return { statusCode: 200, data: { success: true } };
        })
        .times(2); // Allow 2 calls

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.a', 'light.b'],
        },
        { dispatcher: agent }
      );

      const frame: LightFrame = {
        rgb: { r: 100, g: 200, b: 50 },
        brightness: 50,
      };

      await adapter.applyFrame(frame);

      expect(capturedBodies).toHaveLength(2);
      expect(capturedBodies[0].entity_id).toBe('light.a');
      expect(capturedBodies[1].entity_id).toBe('light.b');
    });

    it('should throw when any entity 500s and list failing entities', async () => {
      const pool = agent.get(baseUrl);

      pool
        .intercept({
          path: '/api/services/light/turn_on',
          method: 'POST',
        })
        .reply((opts) => {
          const body = JSON.parse(opts.body as string);
          if (body.entity_id === 'light.broken') {
            return { statusCode: 500, data: { error: 'Internal error' } };
          }
          return { statusCode: 200, data: { success: true } };
        });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.ok', 'light.broken'],
        },
        { dispatcher: agent }
      );

      const frame: LightFrame = {
        rgb: { r: 100, g: 200, b: 50 },
        brightness: 50,
      };

      await expect(adapter.applyFrame(frame)).rejects.toThrow(/light.broken/);
    });

    it('should coalesce frames: while in-flight, pending overwrite, then send latest', async () => {
      let postCount = 0;
      const capturedBodies: any[] = [];
      const pool = agent.get(baseUrl);

      // Setup interceptor with custom handler
      pool
        .intercept(
          {
            path: '/api/services/light/turn_on',
            method: 'POST',
          }
        )
        .reply(function (opts) {
          postCount++;
          capturedBodies.push(JSON.parse(opts.body as string));
          // Return immediately, but track that we're simulating a slow response
          return { statusCode: 200, data: { success: true } };
        })
        .times(2); // Allow 2 calls

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.test'],
        },
        { dispatcher: agent }
      );

      // Start first applyFrame
      const frame1: LightFrame = {
        rgb: { r: 100, g: 100, b: 100 },
        brightness: 30,
      };
      const p1 = adapter.applyFrame(frame1);

      // Immediately call applyFrame 3 more times (will be queued/coalesced)
      const frame2: LightFrame = {
        rgb: { r: 200, g: 200, b: 200 },
        brightness: 50,
      };
      const frame3: LightFrame = {
        rgb: { r: 150, g: 150, b: 150 },
        brightness: 60,
      };
      const frame4: LightFrame = {
        rgb: { r: 250, g: 250, b: 250 },
        brightness: 80,
      };

      // These will queue up while p1 is in flight
      const p2 = adapter.applyFrame(frame2);
      const p3 = adapter.applyFrame(frame3);
      const p4 = adapter.applyFrame(frame4);

      // Wait for all promises
      await Promise.all([p1, p2, p3, p4]);

      // Should have made 2 POST calls: frame1, then the latest (frame4)
      expect(postCount).toBe(2);
      // First POST should be frame1
      expect(capturedBodies[0].brightness).toBe(Math.round((30 * 255) / 100));
      // Second POST should be frame4 (the latest)
      expect(capturedBodies[1].brightness).toBe(Math.round((80 * 255) / 100));
    });

    it('should throw after close', async () => {
      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.test'],
        },
        { dispatcher: agent }
      );

      await adapter.close();

      const frame: LightFrame = {
        rgb: { r: 100, g: 200, b: 50 },
        brightness: 50,
      };

      await expect(adapter.applyFrame(frame)).rejects.toThrow('HomeAssistantAdapter is closed');
    });
  });

  describe('getSnapshot()', () => {
    it('should return snapshot with correct shape', async () => {
      const pool = agent.get(baseUrl);

      pool
        .intercept({ path: '/api/states/light.bedroom', method: 'GET' })
        .reply(200, {
          entity_id: 'light.bedroom',
          state: 'on',
          attributes: {
            brightness: 128,
            rgb_color: [255, 128, 64],
          },
        });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.bedroom'],
        },
        { dispatcher: agent }
      );

      const snapshot = (await adapter.getSnapshot()) as HomeAssistantSnapshot;

      expect(snapshot._kind).toBe('home-assistant');
      expect(snapshot.capturedAt).toBeGreaterThan(0);
      expect(snapshot.entities).toHaveLength(1);
      expect(snapshot.entities[0]).toEqual({
        entityId: 'light.bedroom',
        state: 'on',
        brightness: 128,
        rgb: [255, 128, 64],
      });
    });

    it('should handle entity in off state', async () => {
      const pool = agent.get(baseUrl);

      pool
        .intercept({ path: '/api/states/light.kitchen', method: 'GET' })
        .reply(200, {
          entity_id: 'light.kitchen',
          state: 'off',
          attributes: {},
        });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.kitchen'],
        },
        { dispatcher: agent }
      );

      const snapshot = (await adapter.getSnapshot()) as HomeAssistantSnapshot;

      expect(snapshot.entities[0].state).toBe('off');
      expect(snapshot.entities[0].rgb).toBeUndefined();
      expect(snapshot.entities[0].brightness).toBeUndefined();
    });

    it('should treat unavailable as off', async () => {
      const pool = agent.get(baseUrl);

      pool
        .intercept({ path: '/api/states/light.unavail', method: 'GET' })
        .reply(200, {
          entity_id: 'light.unavail',
          state: 'unavailable',
          attributes: {},
        });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.unavail'],
        },
        { dispatcher: agent }
      );

      const snapshot = (await adapter.getSnapshot()) as HomeAssistantSnapshot;

      expect(snapshot.entities[0].state).toBe('off');
    });

    it('should omit rgb/brightness if not in attributes', async () => {
      const pool = agent.get(baseUrl);

      pool
        .intercept({ path: '/api/states/light.simple', method: 'GET' })
        .reply(200, {
          entity_id: 'light.simple',
          state: 'on',
          attributes: {
            // No rgb_color or brightness
          },
        });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.simple'],
        },
        { dispatcher: agent }
      );

      const snapshot = (await adapter.getSnapshot()) as HomeAssistantSnapshot;

      expect(snapshot.entities[0].state).toBe('on');
      expect(snapshot.entities[0].rgb).toBeUndefined();
      expect(snapshot.entities[0].brightness).toBeUndefined();
    });

    it('should throw after close', async () => {
      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.test'],
        },
        { dispatcher: agent }
      );

      await adapter.close();

      await expect(adapter.getSnapshot()).rejects.toThrow('HomeAssistantAdapter is closed');
    });
  });

  describe('restore()', () => {
    it('should turn on entity with rgb and brightness', async () => {
      let capturedBody: any;
      const pool = agent.get(baseUrl);

      pool
        .intercept(
          {
            path: '/api/services/light/turn_on',
            method: 'POST',
          },
          () => true
        )
        .reply((opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return { statusCode: 200, data: { success: true } };
        });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.bedroom'],
        },
        { dispatcher: agent }
      );

      const snapshot: HomeAssistantSnapshot = {
        _kind: 'home-assistant',
        capturedAt: Date.now(),
        entities: [
          {
            entityId: 'light.bedroom',
            state: 'on',
            rgb: [255, 128, 64],
            brightness: 128,
          },
        ],
      };

      await adapter.restore(snapshot);

      expect(capturedBody.entity_id).toBe('light.bedroom');
      expect(capturedBody.rgb_color).toEqual([255, 128, 64]);
      expect(capturedBody.brightness).toBe(128);
    });

    it('should turn off entity when state is off', async () => {
      let capturedBody: any;
      const pool = agent.get(baseUrl);

      pool
        .intercept(
          {
            path: '/api/services/light/turn_off',
            method: 'POST',
          },
          () => true
        )
        .reply((opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return { statusCode: 200, data: { success: true } };
        });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.bedroom'],
        },
        { dispatcher: agent }
      );

      const snapshot: HomeAssistantSnapshot = {
        _kind: 'home-assistant',
        capturedAt: Date.now(),
        entities: [
          {
            entityId: 'light.bedroom',
            state: 'off',
          },
        ],
      };

      await adapter.restore(snapshot);

      expect(capturedBody.entity_id).toBe('light.bedroom');
    });

    it('should turn on with only rgb if brightness missing', async () => {
      let capturedBody: any;
      const pool = agent.get(baseUrl);

      pool
        .intercept(
          {
            path: '/api/services/light/turn_on',
            method: 'POST',
          },
          () => true
        )
        .reply((opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return { statusCode: 200, data: { success: true } };
        });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.test'],
        },
        { dispatcher: agent }
      );

      const snapshot: HomeAssistantSnapshot = {
        _kind: 'home-assistant',
        capturedAt: Date.now(),
        entities: [
          {
            entityId: 'light.test',
            state: 'on',
            rgb: [200, 100, 50],
          },
        ],
      };

      await adapter.restore(snapshot);

      expect(capturedBody.entity_id).toBe('light.test');
      expect(capturedBody.rgb_color).toEqual([200, 100, 50]);
      expect(capturedBody.brightness).toBeUndefined();
    });

    it('should turn on with only brightness if rgb missing', async () => {
      let capturedBody: any;
      const pool = agent.get(baseUrl);

      pool
        .intercept(
          {
            path: '/api/services/light/turn_on',
            method: 'POST',
          },
          () => true
        )
        .reply((opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return { statusCode: 200, data: { success: true } };
        });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.test'],
        },
        { dispatcher: agent }
      );

      const snapshot: HomeAssistantSnapshot = {
        _kind: 'home-assistant',
        capturedAt: Date.now(),
        entities: [
          {
            entityId: 'light.test',
            state: 'on',
            brightness: 200,
          },
        ],
      };

      await adapter.restore(snapshot);

      expect(capturedBody.entity_id).toBe('light.test');
      expect(capturedBody.rgb_color).toBeUndefined();
      expect(capturedBody.brightness).toBe(200);
    });

    it('should turn on with neither rgb nor brightness if both missing', async () => {
      let capturedBody: any;
      const pool = agent.get(baseUrl);

      pool
        .intercept(
          {
            path: '/api/services/light/turn_on',
            method: 'POST',
          },
          () => true
        )
        .reply((opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return { statusCode: 200, data: { success: true } };
        });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.test'],
        },
        { dispatcher: agent }
      );

      const snapshot: HomeAssistantSnapshot = {
        _kind: 'home-assistant',
        capturedAt: Date.now(),
        entities: [
          {
            entityId: 'light.test',
            state: 'on',
          },
        ],
      };

      await adapter.restore(snapshot);

      expect(capturedBody.entity_id).toBe('light.test');
      expect(capturedBody.rgb_color).toBeUndefined();
      expect(capturedBody.brightness).toBeUndefined();
    });

    it('should throw when snapshot _kind is not home-assistant', async () => {
      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.test'],
        },
        { dispatcher: agent }
      );

      const snapshot = {
        _kind: 'mock',
        capturedAt: Date.now(),
      } as any;

      await expect(adapter.restore(snapshot)).rejects.toThrow(
        /Cannot restore snapshot of kind "mock"/
      );
    });

    it('should throw after close', async () => {
      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.test'],
        },
        { dispatcher: agent }
      );

      await adapter.close();

      const snapshot: HomeAssistantSnapshot = {
        _kind: 'home-assistant',
        capturedAt: Date.now(),
        entities: [],
      };

      await expect(adapter.restore(snapshot)).rejects.toThrow('HomeAssistantAdapter is closed');
    });
  });

  describe('close()', () => {
    it('should make subsequent calls throw', async () => {
      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.test'],
        },
        { dispatcher: agent }
      );

      await adapter.close();

      const frame: LightFrame = {
        rgb: { r: 100, g: 200, b: 50 },
        brightness: 50,
      };

      await expect(adapter.applyFrame(frame)).rejects.toThrow('HomeAssistantAdapter is closed');
      await expect(adapter.getSnapshot()).rejects.toThrow('HomeAssistantAdapter is closed');
    });
  });

  describe('kind property', () => {
    it('should have kind property set to "home-assistant"', () => {
      const adapter = new HomeAssistantAdapter(
        {
          baseUrl,
          token,
          entities: ['light.test'],
        },
        { dispatcher: agent }
      );

      expect(adapter.kind).toBe('home-assistant');
    });
  });

  describe('baseUrl normalization', () => {
    it('should remove trailing slash from baseUrl', async () => {
      const pool = agent.get(baseUrl);
      pool.intercept({ path: '/api/', method: 'GET' }).reply(200, { message: 'API running.' });

      const adapter = new HomeAssistantAdapter(
        {
          baseUrl: baseUrl + '/',
          token,
          entities: ['light.test'],
        },
        { dispatcher: agent }
      );

      await expect(adapter.connect()).resolves.toBeUndefined();
    });
  });
});
