import { describe, it, expect } from 'vitest';
import { CompositeAdapter } from '../../../src/adapters/composite.js';
import type { LightAdapter, LightFrame, LightSnapshot } from '../../../src/adapters/adapter.js';

class FakeAdapter implements LightAdapter {
  readonly kind: string;
  connected = 0;
  closed = 0;
  applied: LightFrame[] = [];
  restored: LightSnapshot[] = [];
  private failOn: Set<string>;

  constructor(kind: string, failOn: string[] = []) {
    this.kind = kind;
    this.failOn = new Set(failOn);
  }

  private maybeFail(op: string): void {
    if (this.failOn.has(op)) {
      throw new Error(`${this.kind} failed to ${op}`);
    }
  }

  async connect(): Promise<void> {
    this.maybeFail('connect');
    this.connected++;
  }

  async applyFrame(frame: LightFrame): Promise<void> {
    this.maybeFail('apply');
    this.applied.push(frame);
  }

  async getSnapshot(): Promise<LightSnapshot> {
    this.maybeFail('snapshot');
    return { _kind: this.kind, capturedAt: 1 };
  }

  async restore(snapshot: LightSnapshot): Promise<void> {
    this.maybeFail('restore');
    this.restored.push(snapshot);
  }

  async close(): Promise<void> {
    this.closed++;
  }
}

const frame: LightFrame = { rgb: { r: 1, g: 2, b: 3 }, brightness: 50 };

describe('CompositeAdapter', () => {
  it('requires at least one child', () => {
    expect(() => new CompositeAdapter([])).toThrow(/at least one child/);
  });

  it('reports child kinds and a composite kind', () => {
    const c = new CompositeAdapter([new FakeAdapter('govee'), new FakeAdapter('hue')]);
    expect(c.kind).toBe('composite');
    expect(c.childKinds).toEqual(['govee', 'hue']);
  });

  it('fans connect/applyFrame/close out to every child', async () => {
    const a = new FakeAdapter('govee');
    const b = new FakeAdapter('hue');
    const c = new CompositeAdapter([a, b]);

    await c.connect();
    await c.applyFrame(frame);
    await c.close();

    expect(a.connected).toBe(1);
    expect(b.connected).toBe(1);
    expect(a.applied).toEqual([frame]);
    expect(b.applied).toEqual([frame]);
    expect(a.closed).toBe(1);
    expect(b.closed).toBe(1);
  });

  it('isolates a single child failure on applyFrame (does not throw)', async () => {
    const ok = new FakeAdapter('hue');
    const bad = new FakeAdapter('govee', ['apply']);
    const c = new CompositeAdapter([bad, ok]);

    await expect(c.applyFrame(frame)).resolves.toBeUndefined();
    expect(ok.applied).toEqual([frame]);
  });

  it('throws only when ALL children fail', async () => {
    const bad1 = new FakeAdapter('govee', ['apply']);
    const bad2 = new FakeAdapter('hue', ['apply']);
    const c = new CompositeAdapter([bad1, bad2]);

    await expect(c.applyFrame(frame)).rejects.toThrow(/all child adapters failed to apply frame/);
  });

  it('aggregates snapshots aligned by child index, null for failures', async () => {
    const a = new FakeAdapter('govee');
    const bad = new FakeAdapter('hue', ['snapshot']);
    const c = new CompositeAdapter([a, bad]);

    const snap = (await c.getSnapshot()) as LightSnapshot & { snaps: (LightSnapshot | null)[] };
    expect(snap._kind).toBe('composite');
    expect(snap.snaps).toHaveLength(2);
    expect(snap.snaps[0]?._kind).toBe('govee');
    expect(snap.snaps[1]).toBeNull();
  });

  it('restores each child from its aligned snapshot, skipping nulls', async () => {
    const a = new FakeAdapter('govee');
    const b = new FakeAdapter('hue');
    const c = new CompositeAdapter([a, b]);

    const snap = await c.getSnapshot();
    await c.restore(snap);

    expect(a.restored).toHaveLength(1);
    expect(b.restored).toHaveLength(1);
    expect(a.restored[0]?._kind).toBe('govee');
    expect(b.restored[0]?._kind).toBe('hue');
  });
});
