import type { RGB } from '../util/color.js';

export interface LightFrame {
  /** Resolved RGB color (0..255 ints). The adapter is responsible for any color-space conversion (e.g. RGB→XY for Hue). */
  rgb: RGB;
  /** 0..100 percent. */
  brightness: number;
  /** Optional fade duration hint (ms). 0 means snap. */
  transitionMs?: number;
}

export interface LightSnapshot {
  /** Opaque per-light state captured by the adapter for later restore. */
  readonly _kind: string;
  readonly capturedAt: number; // epoch ms
}

export interface LightAdapter {
  /** Establish any connection / verify credentials. Idempotent. */
  connect(): Promise<void>;
  /** Render one frame to all configured lights. Adapters MUST coalesce — a slow underlying API should not queue frames. */
  applyFrame(frame: LightFrame): Promise<void>;
  /** Capture current light state for later restore. */
  getSnapshot(): Promise<LightSnapshot>;
  /** Restore from a snapshot returned by getSnapshot. */
  restore(snapshot: LightSnapshot): Promise<void>;
  /** Cleanup connections. After close, no more calls allowed. */
  close(): Promise<void>;
  /** Adapter identity for status output, e.g. 'mock', 'home-assistant', 'hue'. */
  readonly kind: string;
}
