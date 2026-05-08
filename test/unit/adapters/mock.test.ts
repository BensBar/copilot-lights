import { describe, it, expect, beforeEach } from 'vitest';
import { MockAdapter } from '../../../src/adapters/mock.js';
import type { LightFrame } from '../../../src/adapters/adapter.js';

describe('MockAdapter', () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  it('should initialize with empty frames, null lastFrame, and not closed', () => {
    expect(adapter.frames).toEqual([]);
    expect(adapter.lastFrame()).toBeNull();
    expect(adapter.isClosed()).toBe(false);
  });

  it('should record frames and return deep clone via lastFrame', async () => {
    const frame: LightFrame = {
      rgb: { r: 10, g: 20, b: 30 },
      brightness: 50,
    };

    await adapter.applyFrame(frame);

    expect(adapter.frames).toHaveLength(1);
    const last = adapter.lastFrame();
    expect(last).toEqual(frame);
    expect(last).not.toBe(frame); // deep clone, not the same reference
    expect(last?.rgb).not.toBe(frame.rgb); // nested object also cloned
  });

  it('should return snapshot with null frame before any frame applied', async () => {
    const snapshot = await adapter.getSnapshot();

    expect(snapshot._kind).toBe('mock');
    expect(snapshot.capturedAt).toBeGreaterThan(0);
    expect((snapshot as any).frame).toBeNull();
  });

  it('should restore from snapshot with null frame without adding frames', async () => {
    const snapshot = await adapter.getSnapshot();
    await adapter.restore(snapshot);

    expect(adapter.frames).toHaveLength(0);
  });

  it('should capture snapshot after a frame with matching frame value', async () => {
    const frame: LightFrame = {
      rgb: { r: 100, g: 150, b: 200 },
      brightness: 75,
      transitionMs: 300,
    };

    await adapter.applyFrame(frame);
    const snapshot = await adapter.getSnapshot();

    expect((snapshot as any).frame).toEqual(frame);
    expect((snapshot as any).frame).not.toBe(frame); // deep clone
  });

  it('should not mutate adapter state when snapshot is mutated', async () => {
    const frame: LightFrame = {
      rgb: { r: 50, g: 100, b: 150 },
      brightness: 60,
    };

    await adapter.applyFrame(frame);
    const snapshot = await adapter.getSnapshot();

    // Mutate the returned snapshot
    const snapshotFrame = (snapshot as any).frame;
    snapshotFrame.rgb.r = 999;
    snapshotFrame.brightness = 999;

    // Verify adapter state is unchanged
    const lastFrame = adapter.lastFrame();
    expect(lastFrame?.rgb.r).toBe(50);
    expect(lastFrame?.brightness).toBe(60);
  });

  it('should apply frame from snapshot and increase frames count', async () => {
    const frame1: LightFrame = {
      rgb: { r: 10, g: 20, b: 30 },
      brightness: 40,
    };

    await adapter.applyFrame(frame1);
    const snapshot = await adapter.getSnapshot();

    const frame2: LightFrame = {
      rgb: { r: 40, g: 50, b: 60 },
      brightness: 70,
    };

    (snapshot as any).frame = frame2;
    await adapter.restore(snapshot);

    expect(adapter.frames).toHaveLength(2);
    expect(adapter.frames[1]).toEqual(frame2);
  });

  it('should reject applyFrame when failure is set', async () => {
    const error = new Error('Test error');
    adapter.failure = error;

    const frame: LightFrame = {
      rgb: { r: 100, g: 100, b: 100 },
      brightness: 50,
    };

    await expect(adapter.applyFrame(frame)).rejects.toBe(error);
  });

  it('should respect applyDelayMs', async () => {
    adapter.applyDelayMs = 50;

    const frame: LightFrame = {
      rgb: { r: 100, g: 100, b: 100 },
      brightness: 50,
    };

    const start = Date.now();
    await adapter.applyFrame(frame);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some tolerance
  });

  it('should make isClosed return true after close', async () => {
    expect(adapter.isClosed()).toBe(false);
    await adapter.close();
    expect(adapter.isClosed()).toBe(true);
  });

  it('should reject applyFrame after close', async () => {
    await adapter.close();

    const frame: LightFrame = {
      rgb: { r: 100, g: 100, b: 100 },
      brightness: 50,
    };

    await expect(adapter.applyFrame(frame)).rejects.toThrow('MockAdapter is closed');
  });

  it('should reject restore after close', async () => {
    const snapshot = await adapter.getSnapshot();
    await adapter.close();

    await expect(adapter.restore(snapshot)).rejects.toThrow('MockAdapter is closed');
  });

  it('should clear frames on reset', async () => {
    const frame: LightFrame = {
      rgb: { r: 100, g: 100, b: 100 },
      brightness: 50,
    };

    await adapter.applyFrame(frame);
    await adapter.applyFrame(frame);

    expect(adapter.frames).toHaveLength(2);

    adapter.reset();

    expect(adapter.frames).toHaveLength(0);
    expect(adapter.lastFrame()).toBeNull();
  });

  it('should have kind property set to "mock"', () => {
    expect(adapter.kind).toBe('mock');
  });

  it('should connect idempotently', async () => {
    await adapter.connect();
    await adapter.connect();
    expect(adapter.isClosed()).toBe(false);
  });
});
