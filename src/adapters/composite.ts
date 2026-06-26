import type { LightAdapter, LightFrame, LightSnapshot } from './adapter.js';

/** Snapshot wrapper that carries one child snapshot per wrapped adapter,
 *  aligned by index. A child that failed to snapshot stores `null`. */
interface CompositeSnapshot extends LightSnapshot {
  readonly _kind: 'composite';
  readonly snaps: ReadonlyArray<LightSnapshot | null>;
}

/**
 * Fans a single resolved frame out to several real adapters at once, so the
 * daemon can drive Govee + Hue + Home Assistant simultaneously rather than
 * being limited to one backend.
 *
 * Failures are isolated: one offline backend must not blank the others. Each
 * lifecycle method uses `Promise.allSettled` and only surfaces an error when
 * *every* child fails (so the scheduler's `adapterOk` reflects a true outage,
 * not a single flaky bulb).
 */
export class CompositeAdapter implements LightAdapter {
  readonly kind = 'composite';
  private readonly children: LightAdapter[];

  constructor(children: LightAdapter[]) {
    if (children.length === 0) {
      throw new Error('CompositeAdapter requires at least one child adapter');
    }
    this.children = children;
  }

  /** Kinds of the wrapped adapters, e.g. ['govee','hue'] — used for status. */
  get childKinds(): string[] {
    return this.children.map((c) => c.kind);
  }

  async connect(): Promise<void> {
    const results = await Promise.allSettled(this.children.map((c) => c.connect()));
    this.throwIfAllRejected(results, 'connect');
  }

  async applyFrame(frame: LightFrame): Promise<void> {
    const results = await Promise.allSettled(this.children.map((c) => c.applyFrame(frame)));
    this.throwIfAllRejected(results, 'apply frame');
  }

  async getSnapshot(): Promise<LightSnapshot> {
    const snaps = await Promise.all(
      this.children.map(async (c) => {
        try {
          return await c.getSnapshot();
        } catch {
          return null;
        }
      })
    );
    const snap: CompositeSnapshot = { _kind: 'composite', capturedAt: Date.now(), snaps };
    return snap;
  }

  async restore(snapshot: LightSnapshot): Promise<void> {
    const snaps = (snapshot as CompositeSnapshot).snaps ?? [];
    await Promise.allSettled(
      this.children.map((c, i) => {
        const s = snaps[i];
        return s ? c.restore(s) : Promise.resolve();
      })
    );
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.children.map((c) => c.close()));
  }

  private throwIfAllRejected(results: PromiseSettledResult<unknown>[], action: string): void {
    const failures = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected'
    );
    if (failures.length === this.children.length) {
      const reasons = failures
        .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
        .join('; ');
      throw new Error(`all child adapters failed to ${action}: ${reasons}`);
    }
  }
}
