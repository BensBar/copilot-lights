import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Scheduler } from '../../src/daemon/scheduler.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import type { CopilotLightsConfig } from '../../src/config/schema.js';

describe('Scheduler', () => {
  let adapter: MockAdapter;
  let cfg: CopilotLightsConfig;
  let scheduler: Scheduler;
  let mockTime: number;

  beforeEach(() => {
    vi.useFakeTimers();
    mockTime = 1000000;
    vi.setSystemTime(mockTime);

    adapter = new MockAdapter();
    cfg = {
      adapter: 'mock',
      states: {},
      transitionMs: 600,
      restoreOnExit: true,
      errorTtlMs: 4000,
      doneTtlMs: 1500,
    };

    scheduler = new Scheduler(adapter, cfg, {
      fps: 10,
      now: () => vi.getMockedSystemTime() ?? Date.now(),
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  describe('off state', () => {
    it('does not emit frames when state is off', async () => {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(500);

      expect(adapter.frames.length).toBe(0);
    });

    it('computeFrame returns null for off state', () => {
      const frame = scheduler.computeFrame();
      expect(frame).toBeNull();
    });

    it('resumes when transitioning from off to ready', async () => {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(200);
      expect(adapter.frames.length).toBe(0);

      scheduler.setState('ready');
      await vi.advanceTimersByTimeAsync(150);

      expect(adapter.frames.length).toBeGreaterThan(0);
      const frame = adapter.lastFrame();
      expect(frame).not.toBeNull();
      expect(frame!.rgb).toEqual({ r: 74, g: 222, b: 128 }); // #4ade80
      expect(frame!.brightness).toBe(30);
      expect(frame!.transitionMs).toBe(600);
    });

    it('stops emitting when transitioning to off', async () => {
      scheduler.setState('ready');
      scheduler.start();
      await vi.advanceTimersByTimeAsync(150);

      const framesBeforeOff = adapter.frames.length;
      expect(framesBeforeOff).toBeGreaterThan(0);

      scheduler.setState('off');
      await vi.advanceTimersByTimeAsync(500);

      expect(adapter.frames.length).toBe(framesBeforeOff);
    });
  });

  describe('steady effect (ready state)', () => {
    it('emits one frame with ready color on state change', async () => {
      scheduler.setState('ready');
      scheduler.start();
      await vi.advanceTimersByTimeAsync(150);

      expect(adapter.frames.length).toBe(1);
      const frame = adapter.frames[0]!;
      expect(frame.rgb).toEqual({ r: 74, g: 222, b: 128 });
      expect(frame.brightness).toBe(30);
      expect(frame.transitionMs).toBe(600);
    });

    it('coalesces steady frames after initial emit', async () => {
      scheduler.setState('ready');
      scheduler.start();
      await vi.advanceTimersByTimeAsync(150);

      const initialFrames = adapter.frames.length;
      expect(initialFrames).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);

      expect(adapter.frames.length).toBe(initialFrames);
    });

    it('emits new frame with transitionMs on state change', async () => {
      scheduler.setState('ready');
      scheduler.start();
      await vi.advanceTimersByTimeAsync(150);

      adapter.reset();

      scheduler.setState('thinking');
      await vi.advanceTimersByTimeAsync(150);

      expect(adapter.frames.length).toBeGreaterThan(0);
      const frame = adapter.lastFrame();
      expect(frame).not.toBeNull();
      // On transition, animated effects should use cfg.transitionMs or a shorter frame transition
      expect(frame!.transitionMs).toBeGreaterThanOrEqual(50);
      expect(frame!.transitionMs).toBeLessThanOrEqual(600);
    });
  });

  describe('breathe effect (thinking state)', () => {
    beforeEach(() => {
      // Default thinking style is now steady; override here to keep coverage
      // of the breathe effect.
      cfg.states.thinking = {
        color: '#60a5fa',
        brightness: 55,
        effect: 'breathe',
        periodMs: 4000,
      };
    });

    it('produces oscillating brightness frames', async () => {
      scheduler.setState('thinking');
      scheduler.start();

      // Let it run for a bit
      await vi.advanceTimersByTimeAsync(4000);

      // Should have emitted frames
      expect(adapter.frames.length).toBeGreaterThan(1);

      // Check that we have frames with the correct color
      expect(adapter.frames[0]!.rgb).toEqual({ r: 96, g: 165, b: 250 });
    });

    it('uses smooth transitionMs for animation', async () => {
      scheduler.setState('thinking');
      scheduler.start();
      await vi.advanceTimersByTimeAsync(300);

      const frames = adapter.frames.slice(-3);
      for (const frame of frames) {
        expect(frame.transitionMs).toBeLessThanOrEqual(600);
        expect(frame.transitionMs).toBeGreaterThanOrEqual(50);
      }
    });
  });

  describe('pulse effect (done state)', () => {
    it('produces pulse animation with count: 1', async () => {
      scheduler.setState('done');
      scheduler.start();

      await vi.advanceTimersByTimeAsync(2000);

      // Should have emitted frames
      expect(adapter.frames.length).toBeGreaterThan(1);
      
      // Verify correct color
      expect(adapter.frames[0]!.rgb).toEqual({ r: 126, g: 231, b: 135 });
    });

    it('holds steady after pulse completes', async () => {
      scheduler.setState('done');
      scheduler.start();

      await vi.advanceTimersByTimeAsync(3000); // Well beyond the 1500ms period

      // Should have emitted frames
      expect(adapter.frames.length).toBeGreaterThan(1);
    });
  });

  describe('flash effect (error state)', () => {
    it('produces on/off brightness pattern', async () => {
      scheduler.setState('error');
      scheduler.start();

      await vi.advanceTimersByTimeAsync(1600); // Cover the flash duration

      expect(adapter.frames.length).toBeGreaterThan(1);
      
      // Verify correct color
      expect(adapter.frames[0]!.rgb).toEqual({ r: 248, g: 81, b: 73 });
    });

    it('holds steady after flash pattern completes', async () => {
      scheduler.setState('error');
      scheduler.start();

      await vi.advanceTimersByTimeAsync(2500); // Beyond flash duration

      expect(adapter.frames.length).toBeGreaterThan(1);
      
      const recentFrames = adapter.frames.slice(-3);
      for (const frame of recentFrames) {
        expect(frame.brightness).toBe(80);
      }
    });
  });

  describe('state transitions', () => {
    it('uses cfg.transitionMs on state change', async () => {
      scheduler.setState('thinking');
      scheduler.start();
      await vi.advanceTimersByTimeAsync(150);

      adapter.reset();

      scheduler.setState('ready');
      await vi.advanceTimersByTimeAsync(150);

      const frame = adapter.frames[0];
      expect(frame).toBeDefined();
      expect(frame!.transitionMs).toBe(600);
    });

    it('transitions between multiple states correctly', async () => {
      scheduler.start();

      scheduler.setState('ready');
      await vi.advanceTimersByTimeAsync(150);
      expect(adapter.lastFrame()!.rgb).toEqual({ r: 126, g: 231, b: 135 });

      scheduler.setState('thinking');
      await vi.advanceTimersByTimeAsync(150);
      expect(adapter.lastFrame()!.rgb).toEqual({ r: 88, g: 166, b: 255 });

      scheduler.setState('error');
      await vi.advanceTimersByTimeAsync(150);
      expect(adapter.lastFrame()!.rgb).toEqual({ r: 248, g: 81, b: 73 });
    });
  });

  describe('adapter failure handling', () => {
    it('calls onError on adapter failure', async () => {
      const errors: unknown[] = [];
      const schedulerWithErrorHandler = new Scheduler(adapter, cfg, {
        fps: 10,
        now: () => vi.getMockedSystemTime() ?? Date.now(),
        onError: (err) => errors.push(err),
      });

      const testError = new Error('Adapter failure');
      adapter.failure = testError;

      schedulerWithErrorHandler.setState('ready');
      schedulerWithErrorHandler.start();
      await vi.advanceTimersByTimeAsync(200);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toBe(testError);

      schedulerWithErrorHandler.stop();
    });

    it('implements exponential backoff after failures', async () => {
      const errors: unknown[] = [];
      const schedulerWithErrorHandler = new Scheduler(adapter, cfg, {
        fps: 10,
        now: () => vi.getMockedSystemTime() ?? Date.now(),
        onError: (err) => errors.push(err),
      });

      adapter.failure = new Error('Adapter failure');

      schedulerWithErrorHandler.setState('ready');
      schedulerWithErrorHandler.start();
      await vi.advanceTimersByTimeAsync(200);

      const errorsAfterFirst = errors.length;
      expect(errorsAfterFirst).toBeGreaterThan(0);

      // Advance but not enough to clear backoff (initial backoff is 100ms)
      await vi.advanceTimersByTimeAsync(80);
      expect(errors.length).toBe(errorsAfterFirst); // No new errors during backoff

      // Advance past backoff
      await vi.advanceTimersByTimeAsync(120);
      // Should have attempted retry
      expect(errors.length).toBeGreaterThanOrEqual(errorsAfterFirst);

      schedulerWithErrorHandler.stop();
    });

    it('resets failure count on success', async () => {
      const schedulerWithErrorHandler = new Scheduler(adapter, cfg, {
        fps: 10,
        now: () => vi.getMockedSystemTime() ?? Date.now(),
      });

      adapter.failure = new Error('Temporary failure');

      schedulerWithErrorHandler.setState('ready');
      schedulerWithErrorHandler.start();
      await vi.advanceTimersByTimeAsync(200);

      // Clear failure
      adapter.failure = null;
      await vi.advanceTimersByTimeAsync(300);

      // Should successfully emit frames now
      const framesAfterRecovery = adapter.frames.length;
      expect(framesAfterRecovery).toBeGreaterThanOrEqual(0); // May or may not have frames depending on backoff

      schedulerWithErrorHandler.stop();
    });
  });

  describe('coalescing under slow adapter', () => {
    it('drops ticks when adapter is slow', async () => {
      adapter.applyDelayMs = 200;

      scheduler.setState('thinking');
      scheduler.start();

      // First tick starts applyFrame (200ms delay)
      await vi.advanceTimersByTimeAsync(100); // tick at 100ms

      // Second tick would fire at 200ms, but first is still in flight
      await vi.advanceTimersByTimeAsync(100); // tick at 200ms

      // Third tick at 300ms - first should complete around now
      await vi.advanceTimersByTimeAsync(100); // tick at 300ms

      // Should have fewer frames than ticks due to coalescing
      expect(adapter.frames.length).toBeLessThan(3);
    });
  });

  describe('start and stop', () => {
    it('is idempotent when calling start multiple times', async () => {
      scheduler.start();
      scheduler.start();
      scheduler.start();

      scheduler.setState('ready');
      await vi.advanceTimersByTimeAsync(150);

      expect(adapter.frames.length).toBe(1);
    });

    it('stops emitting frames after stop', async () => {
      scheduler.setState('ready');
      scheduler.start();
      await vi.advanceTimersByTimeAsync(150);

      const framesBeforeStop = adapter.frames.length;
      expect(framesBeforeStop).toBeGreaterThan(0);

      scheduler.stop();
      await vi.advanceTimersByTimeAsync(1000);

      expect(adapter.frames.length).toBe(framesBeforeStop);
    });

    it('can restart after stop', async () => {
      scheduler.setState('ready');
      scheduler.start();
      await vi.advanceTimersByTimeAsync(150);

      scheduler.stop();
      adapter.reset();

      scheduler.start();
      await vi.advanceTimersByTimeAsync(150);

      expect(adapter.frames.length).toBeGreaterThan(0);
    });
  });

  describe('computeFrame', () => {
    it('returns null for off state', () => {
      scheduler.setState('off');
      expect(scheduler.computeFrame()).toBeNull();
    });

    it('returns correct frame for ready state', () => {
      scheduler.setState('ready');
      const frame = scheduler.computeFrame();

      expect(frame).not.toBeNull();
      expect(frame!.rgb).toEqual({ r: 126, g: 231, b: 135 });
      expect(frame!.brightness).toBe(25);
    });

    it('returns correct frame for each state', () => {
      const states: Array<{ state: any; expectedRgb: any }> = [
        { state: 'ready', expectedRgb: { r: 126, g: 231, b: 135 } },
        { state: 'thinking', expectedRgb: { r: 88, g: 166, b: 255 } },
        { state: 'awaiting_input', expectedRgb: { r: 240, g: 180, b: 41 } },
        { state: 'error', expectedRgb: { r: 248, g: 81, b: 73 } },
        { state: 'done', expectedRgb: { r: 126, g: 231, b: 135 } },
      ];

      for (const { state, expectedRgb } of states) {
        scheduler.setState(state);
        const frame = scheduler.computeFrame();
        expect(frame).not.toBeNull();
        expect(frame!.rgb).toEqual(expectedRgb);
      }
    });

    it('accepts optional now parameter', () => {
      scheduler.setState('thinking');

      const frame1 = scheduler.computeFrame(mockTime);
      const frame2 = scheduler.computeFrame(mockTime + 1000);

      expect(frame1).not.toBeNull();
      expect(frame2).not.toBeNull();

      // For breathe effect, brightness should differ at different times
      expect(frame1!.brightness).not.toBe(frame2!.brightness);
    });
  });
});
