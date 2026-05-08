import type { LightAdapter, LightFrame, LightSnapshot } from './adapter.js';

interface MockLightSnapshot extends LightSnapshot {
  _kind: 'mock';
  capturedAt: number;
  frame: LightFrame | null;
}

export class MockAdapter implements LightAdapter {
  readonly kind = 'mock';
  readonly frames: LightFrame[] = [];
  applyDelayMs: number | null = null;
  failure: Error | null = null;

  private _closed = false;

  async connect(): Promise<void> {
    if (this.failure) {
      throw this.failure;
    }
    // Idempotent no-op
  }

  async applyFrame(frame: LightFrame): Promise<void> {
    if (this._closed) {
      throw new Error('MockAdapter is closed');
    }

    if (this.failure) {
      throw this.failure;
    }

    if (this.applyDelayMs !== null && this.applyDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.applyDelayMs as number));
    }

    this.frames.push(this._deepClone(frame));
  }

  async getSnapshot(): Promise<LightSnapshot> {
    const snapshot: MockLightSnapshot = {
      _kind: 'mock',
      capturedAt: Date.now(),
      frame: this.lastFrame() ? this._deepClone(this.lastFrame()!) : null,
    };
    return snapshot;
  }

  async restore(snapshot: LightSnapshot): Promise<void> {
    if (this._closed) {
      throw new Error('MockAdapter is closed');
    }

    const mockSnapshot = snapshot as MockLightSnapshot;
    if (mockSnapshot.frame) {
      await this.applyFrame(mockSnapshot.frame);
    }
  }

  async close(): Promise<void> {
    this._closed = true;
  }

  reset(): void {
    this.frames.length = 0;
  }

  lastFrame(): LightFrame | null {
    if (this.frames.length === 0) {
      return null;
    }
    return this.frames[this.frames.length - 1]!;
  }

  isClosed(): boolean {
    return this._closed;
  }

  private _deepClone(frame: LightFrame): LightFrame {
    return {
      rgb: { ...frame.rgb },
      brightness: frame.brightness,
      transitionMs: frame.transitionMs,
    };
  }
}
