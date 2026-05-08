import { sendToDaemon } from './client.js';

const STATE_GLYPHS: Record<string, { glyph: string; label: string; ansiColor: number }> = {
  ready: { glyph: '●', label: 'ready', ansiColor: 32 },          // green
  thinking: { glyph: '◐', label: 'thinking', ansiColor: 34 },    // blue
  awaiting_input: { glyph: '◉', label: 'needs input', ansiColor: 33 }, // yellow
  error: { glyph: '✖', label: 'error', ansiColor: 31 },          // red
  done: { glyph: '✓', label: 'done', ansiColor: 32 },            // green
  off: { glyph: '○', label: 'off', ansiColor: 90 },              // gray
};

export interface StatuslineResult {
  text: string;
  daemonReachable: boolean;
}

/**
 * Reads the running daemon's state and returns a one-line indicator suitable
 * for Copilot CLI's `experimental` statusLine.command output.
 *
 * Always resolves; never throws and never blocks longer than `timeoutMs`
 * (default 200ms) so it can't slow down the Copilot CLI footer.
 *
 * If the daemon is unreachable, returns a dim "○ offline" string so the
 * statusline still shows something useful.
 */
export async function runStatusline(opts: {
  socketPath: string;
  timeoutMs?: number;
  /** When true, emit ANSI color codes. Defaults to true if stdout is a TTY-like context. */
  color?: boolean;
}): Promise<StatuslineResult> {
  const reply = await sendToDaemon(
    { kind: 'query', query: 'status' },
    { socketPath: opts.socketPath, timeoutMs: opts.timeoutMs ?? 200, expectReply: true }
  );

  const useColor = opts.color ?? true;

  if (!reply) {
    return { text: paint('○ offline', 90, useColor), daemonReachable: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    return { text: paint('○ offline', 90, useColor), daemonReachable: false };
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { kind?: string }).kind !== 'status'
  ) {
    return { text: paint('○ offline', 90, useColor), daemonReachable: false };
  }

  const status = parsed as { state: string; sessions?: number; adapter?: { ok?: boolean } };
  const meta = STATE_GLYPHS[status.state] ?? STATE_GLYPHS.off!;
  const adapterBad = status.adapter?.ok === false;
  const suffix = adapterBad ? ' ⚠' : '';
  const text = paint(`${meta.glyph} ${meta.label}${suffix}`, meta.ansiColor, useColor);
  return { text, daemonReachable: true };
}

function paint(s: string, code: number, useColor: boolean): string {
  if (!useColor) return s;
  return `\u001b[${code}m${s}\u001b[0m`;
}
