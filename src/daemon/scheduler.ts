import type { LightAdapter, LightFrame } from '../adapters/adapter.js';
import type { CopilotLightsConfig } from '../config/schema.js';
import type { LightState } from './state.js';
import { resolveStateStyle } from '../config/schema.js';
import { hexToRgb } from '../util/color.js';

export interface SchedulerOptions {
  /** Frames per second. Default 10. */
  fps?: number;
  /** Time source (injected for tests). Default Date.now. */
  now?: () => number;
  /** Logger callback for adapter errors (default: console.warn). */
  onError?: (err: unknown) => void;
  /**
   * "Done coalescing window": when the resolver flips `thinking` →
   * `done`, hold `thinking` for this long instead of applying `done`
   * immediately. If a subsequent `setState('thinking')` arrives within
   * the window (which happens mid agent-loop: Stop fires between tool
   * batches and the next PreToolUse re-primes within tens of ms), the
   * pending `done` is cancelled and the light never flashes green.
   * If no contradicting state arrives, the `done` is applied when the
   * window expires. Set to 0 to disable. Default 3000ms.
   */
  doneCoalesceMs?: number;
  /**
   * "Keepalive re-send interval": steady-effect states (ready/thinking/
   * awaiting_input/done) normally emit exactly one frame on state change
   * and then coalesce every subsequent tick. With a fire-and-forget UDP
   * adapter (e.g. Govee LAN) a single dropped packet would then freeze
   * the lamp on a stale colour until the next state change, while the
   * widget (reliable socket poll) shows the true state. Re-emitting the
   * current steady frame every `keepaliveMs` lets a dropped packet
   * self-heal on the next re-send. Set to 0 to disable. Default 5000ms.
   */
  keepaliveMs?: number;
}

/**
 * Drives the adapter at a fixed frame rate, computing the current frame from
 * the resolved LightState and the user's effect config. Coalesces fast state
 * changes through a transition fade. Off-by-default until start() is called.
 *
 * Adapter failures are caught + logged + retried with exponential backoff.
 * Adapter failures NEVER block setState() (the only public input).
 */
export class Scheduler {
  private readonly adapter: LightAdapter;
  private readonly cfg: CopilotLightsConfig;
  private readonly fps: number;
  private readonly now: () => number;
  private readonly onError: (err: unknown) => void;
  private readonly doneCoalesceMs: number;
  private readonly keepaliveMs: number;

  private state: LightState = 'off';
  private stateChangedAt: number = 0;
  private previousState: LightState = 'off';

  /**
   * When set, a `done` state is being held back because we recently
   * transitioned away from `thinking`. The scheduler stays on
   * `thinking` until `pendingDoneAt` is reached, at which point `done`
   * is applied. Any non-`done` `setState` clears this.
   */
  private pendingDoneAt: number | null = null;
  
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  
  private consecutiveFailures: number = 0;
  private nextRetryAt: number = 0;
  private readonly maxBackoffMs = 30000;

  private lastEmittedFrame: LightFrame | null = null;
  private lastEmittedState: LightState = 'off';
  private lastEmittedAt: number = 0;
  private transitionPending: boolean = false;

  constructor(adapter: LightAdapter, cfg: CopilotLightsConfig, opts?: SchedulerOptions) {
    this.adapter = adapter;
    this.cfg = cfg;
    this.fps = opts?.fps ?? 10;
    this.now = opts?.now ?? (() => Date.now());
    this.onError = opts?.onError ?? ((err) => console.warn('Scheduler adapter error:', err));
    this.doneCoalesceMs = opts?.doneCoalesceMs ?? 3000;
    this.keepaliveMs = opts?.keepaliveMs ?? 5000;
  }

  /** Begin emitting frames. Idempotent. */
  start(): void {
    if (this.intervalId !== null) {
      return;
    }

    const intervalMs = 1000 / this.fps;
    this.intervalId = setInterval(() => {
      this.tick();
    }, intervalMs);

    // unref so scheduler doesn't keep event loop alive
    if (typeof (this.intervalId as any).unref === 'function') {
      (this.intervalId as any).unref();
    }
  }

  /** Stop emitting frames. Does NOT call adapter.restore — that's owned by the daemon shutdown path. */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    // Clear emission tracking so a restart will emit fresh frames
    this.lastEmittedFrame = null;
    this.lastEmittedState = 'off';
    this.lastEmittedAt = 0;
    this.transitionPending = false;
  }

  /** Set the desired light state. The next frame will start fading toward it. */
  setState(state: LightState): void {
    // Done-coalescing: an agent loop fires Stop between tool batches and
    // re-primes thinking ~tens of ms later via the next PreToolUse. The
    // gap between those two events resolves to `done` and would flash
    // green for a single frame mid-loop. Hold `done` for
    // `doneCoalesceMs` after a thinking→done transition; if a non-done
    // state arrives in that window (typically thinking), discard the
    // pending done entirely.
    if (this.doneCoalesceMs > 0) {
      if (state === 'done' && this.state === 'thinking') {
        if (this.pendingDoneAt === null) {
          this.pendingDoneAt = this.now() + this.doneCoalesceMs;
        }
        // Already parked — ignore repeat done calls from the 4Hz
        // resolve ticker until either the window expires (tick()
        // releases) or a non-done state cancels it.
        return;
      }
      if (state !== 'done' && this.pendingDoneAt !== null) {
        // Loop continued — cancel the pending done flash.
        this.pendingDoneAt = null;
      }
    }

    if (this.state !== state) {
      this.state = state;
      this.stateChangedAt = this.now();
      this.transitionPending = true;
    }
  }

  /** Current resolved frame computed for now(). Useful for tests + status command. */
  computeFrame(now?: number): LightFrame | null {
    const timestamp = now ?? this.now();

    if (this.state === 'off') {
      return null;
    }

    const style = resolveStateStyle(this.state, this.cfg);
    const rgb = hexToRgb(style.color);
    const elapsedMs = timestamp - this.stateChangedAt;

    // Use transitionMs if we have a pending transition
    const useTransitionMs = this.transitionPending;

    if (style.effect === 'steady') {
      return {
        rgb,
        brightness: style.brightness,
        transitionMs: this.cfg.transitionMs,
      };
    }

    if (style.effect === 'breathe') {
      const periodMs = style.periodMs;
      const phase = (elapsedMs % periodMs) / periodMs;
      const sineWave = Math.sin(phase * 2 * Math.PI);
      // Oscillate between 0.4 * brightness and 1.0 * brightness
      const minBrightness = style.brightness * 0.4;
      const maxBrightness = style.brightness;
      const brightness = minBrightness + (maxBrightness - minBrightness) * (sineWave * 0.5 + 0.5);

      return {
        rgb,
        brightness,
        transitionMs: useTransitionMs ? this.cfg.transitionMs : Math.max(50, 1000 / this.fps),
      };
    }

    if (style.effect === 'pulse') {
      const periodMs = style.periodMs;
      const count = style.count;
      const ttlMs = style.ttlMs;

      // Check if effect has ended
      let effectEnded = false;
      if (count !== undefined) {
        const totalDuration = count * periodMs;
        if (elapsedMs >= totalDuration) {
          effectEnded = true;
        }
      }
      if (ttlMs !== undefined && elapsedMs >= ttlMs) {
        effectEnded = true;
      }

      if (effectEnded) {
        // Hold steady
        return {
          rgb,
          brightness: style.brightness,
          transitionMs: this.cfg.transitionMs,
        };
      }

      // Triangle wave (or cosine-based pulse)
      const phase = (elapsedMs % periodMs) / periodMs;
      const waveValue = (1 - Math.cos(2 * Math.PI * phase)) / 2;
      const brightness = style.brightness * waveValue;

      return {
        rgb,
        brightness,
        transitionMs: useTransitionMs ? this.cfg.transitionMs : Math.max(50, 1000 / this.fps),
      };
    }

    if (style.effect === 'flash') {
      const count = style.count;
      const ttlMs = style.ttlMs ?? 4000;
      const flashDuration = 1500;

      if (elapsedMs >= ttlMs) {
        // Effect expired, hold steady
        return {
          rgb,
          brightness: style.brightness,
          transitionMs: this.cfg.transitionMs,
        };
      }

      if (elapsedMs >= flashDuration) {
        // Flash pattern done, hold steady
        return {
          rgb,
          brightness: style.brightness,
          transitionMs: this.cfg.transitionMs,
        };
      }

      // Flash pattern: count=2 means on/off/on/off/on/off (6 toggles total)
      const toggleCount = count * 3; // count flashes = count on + count off + final on
      const toggleDuration = flashDuration / toggleCount;
      const toggleIndex = Math.floor(elapsedMs / toggleDuration);
      const isOn = toggleIndex % 2 === 0;

      return {
        rgb,
        brightness: isOn ? style.brightness : 0,
        transitionMs: Math.max(50, 1000 / this.fps),
      };
    }

    // Exhaustive: each effect branch above returns. If a new effect is added
    // to the schema, this assignment fails to typecheck — surfacing the gap
    // at build time instead of silently returning an arbitrary frame.
    const _exhaustive: never = style;
    throw new Error(`Unhandled effect: ${JSON.stringify(_exhaustive)}`);
  }

  private tick(): void {
    const timestamp = this.now();

    // Release any pending coalesced `done` whose window has expired
    // without a contradicting state arriving.
    if (this.pendingDoneAt !== null && timestamp >= this.pendingDoneAt) {
      this.pendingDoneAt = null;
      if (this.state !== 'done') {
        this.state = 'done';
        this.stateChangedAt = timestamp;
        this.transitionPending = true;
      }
    }

    // If adapter is in backoff, don't emit
    if (timestamp < this.nextRetryAt) {
      return;
    }

    // If adapter call is in flight, drop this tick (coalesce)
    if (this.inFlight !== null) {
      return;
    }

    const frame = this.computeFrame(timestamp);

    // If state is 'off', don't call adapter
    if (frame === null) {
      this.lastEmittedFrame = null;
      this.lastEmittedState = 'off';
      return;
    }

    // For steady effect, coalesce: only emit on state change — but still
    // re-emit periodically (keepaliveMs) so a dropped fire-and-forget
    // frame self-heals instead of freezing the lamp on a stale colour.
    if (this.state !== 'off') {
      const style = resolveStateStyle(this.state, this.cfg);
      if (style.effect === 'steady') {
        // If we already emitted a frame for this steady state, skip —
        // unless the keepalive interval has elapsed since the last emit.
        if (this.lastEmittedState === this.state && this.lastEmittedFrame !== null) {
          const keepaliveDue =
            this.keepaliveMs > 0 && timestamp - this.lastEmittedAt >= this.keepaliveMs;
          if (!keepaliveDue) {
            return;
          }
        }
      }
    }

    this.lastEmittedFrame = frame;
    this.lastEmittedState = this.state;
    this.lastEmittedAt = timestamp;

    // Fire and forget with error handling
    const pendingTransition = this.transitionPending;
    if (pendingTransition) {
      // Clear transition flag now that we've computed and are emitting the transition frame
      this.transitionPending = false;
    }

    this.inFlight = this.adapter
      .applyFrame(frame)
      .then(() => {
        this.consecutiveFailures = 0;
        this.nextRetryAt = 0;
      })
      .catch((err) => {
        this.consecutiveFailures++;
        const backoffMs = Math.min(
          this.maxBackoffMs,
          100 * Math.pow(2, this.consecutiveFailures - 1)
        );
        this.nextRetryAt = this.now() + backoffMs;
        this.onError(err);
      })
      .finally(() => {
        this.inFlight = null;
      });
  }
}
