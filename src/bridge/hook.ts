import { sendToDaemon } from './client.js';

const KNOWN_EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PreMcpToolCall',
  'PostToolUse',
  'PostToolUseFailure',
  'ErrorOccurred',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PermissionRequest',
  'Notification',
]);

interface HookInput {
  event: string;
  stdin: string;
  socketPath: string;
  now?: () => number;
}

/**
 * Map a `TERM_PROGRAM` / `LC_TERMINAL` value to the macOS bundle identifier of
 * the terminal emulator that set it. Used only as a fallback when
 * `__CFBundleIdentifier` is absent (e.g. a session that was re-parented away
 * from its launching GUI app).
 */
const TERM_PROGRAM_BUNDLE_IDS: Record<string, string> = {
  'iterm.app': 'com.googlecode.iterm2',
  iterm2: 'com.googlecode.iterm2',
  apple_terminal: 'com.apple.Terminal',
  ghostty: 'com.mitchellh.ghostty',
  vscode: 'com.microsoft.VSCode',
  wezterm: 'com.github.wez.wezterm',
  hyper: 'co.zeit.hyper',
  tabby: 'org.tabby',
  kitty: 'net.kovidgoyal.kitty',
  alacritty: 'org.alacritty',
  warpterminal: 'dev.warp.Warp-Stable',
  warp: 'dev.warp.Warp-Stable',
};

/**
 * Resolve the bundle identifier of the GUI application that owns this hook's
 * Copilot session — the terminal emulator (iTerm2, Ghostty, Terminal, …) or
 * the Copilot desktop app. The hook process inherits the Copilot CLI's
 * environment, which in turn inherited the launching app's, so this is
 * captured for free with no process-tree walking.
 *
 * Only an app *identifier* is captured — never prompt text, tool args, file
 * contents, or any session payload — so it stays within the wire privacy
 * contract (the same class of data as `cwd`).
 */
export function resolveOrigin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // 1. macOS sets __CFBundleIdentifier on processes launched (directly or
  //    transitively) by a GUI app via LaunchServices. This is the exact,
  //    focusable owner: com.github.githubapp (Copilot desktop app),
  //    com.googlecode.iterm2, com.mitchellh.ghostty, com.apple.Terminal, etc.
  const cf = env.__CFBundleIdentifier;
  if (cf && cf.trim()) return cf.trim();

  // 2. Fallback: derive the terminal from TERM_PROGRAM / LC_TERMINAL, which
  //    most emulators export even into re-parented (detached) sessions.
  const candidates = [env.TERM_PROGRAM, env.LC_TERMINAL];
  for (const raw of candidates) {
    if (!raw) continue;
    const mapped = TERM_PROGRAM_BUNDLE_IDS[raw.trim().toLowerCase()];
    if (mapped) return mapped;
  }

  return undefined;
}

/**
 * Parse a hook `timestamp` into milliseconds since epoch.
 *
 * The Copilot SDK hook contract (`BaseHookInput.timestamp`) supplies a numeric
 * epoch-millisecond value. We also accept an ISO 8601 string for backward
 * compatibility (older payloads / VS Code-compat surfaces). Falls back to
 * `nowMs` when missing or unparseable.
 */
function parseTimestamp(value: string | number | undefined, nowMs: number): number {
  if (value === undefined || value === null) return nowMs;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? nowMs : ms;
}

/**
 * The `copilot-lights hook <event>` entrypoint. Reads stdin (single JSON object,
 * possibly empty), translates to a daemon event message, fires it, exits 0.
 *
 * Total wall-clock budget: 800ms. Even on hang, returns within budget.
 */
export async function runHook(args: HookInput): Promise<void> {
  const { event, stdin, socketPath, now } = args;
  const nowMs = (now ?? (() => Date.now()))();

  // Unknown event → no-op
  if (!KNOWN_EVENTS.has(event)) {
    return;
  }

  let payload: Record<string, unknown> = {};
  try {
    if (stdin && stdin.trim()) {
      payload = JSON.parse(stdin);
    }
  } catch {
    // Invalid JSON → ignore, continue with empty payload
  }

  // Extract fields from the Copilot SDK hook payload.
  // sessionId resolution order:
  //   1. payload.sessionId  — the SDK's `BaseHookInput.sessionId` (camelCase).
  //   2. payload.session_id — legacy snake_case fallback for older payloads.
  //   3. cwd-derived synthetic id (`_cwd:<path>`) — gives different workspaces
  //      distinct buckets so a busy session in workspace A doesn't keep a
  //      stale "thinking" entry alive for an idle session in workspace B.
  //   4. final fallback `_unknown`.
  const rawSessionId =
    (payload.sessionId as string | undefined) ??
    (payload.session_id as string | undefined) ??
    undefined;
  const timestamp = parseTimestamp(payload.timestamp as string | number | undefined, nowMs);
  const toolName = (payload.tool_name as string | undefined) ?? undefined;
  const notificationType = (payload.notification_type as string | undefined) ?? undefined;
  // Prefer payload.cwd if Copilot supplies it; otherwise capture the hook
  // process's cwd (Copilot CLI runs hook commands in the workspace dir).
  const cwd =
    (payload.cwd as string | undefined) ??
    (payload.workspace as string | undefined) ??
    safeCwd();

  const sessionId =
    (rawSessionId && rawSessionId.length > 0) ? rawSessionId
      : cwd ? `_cwd:${cwd}`
      : '_unknown';

  const origin = resolveOrigin();

  const message = {
    kind: 'event' as const,
    event,
    sessionId,
    ts: timestamp,
    ...(toolName && { toolName }),
    ...(notificationType && { notificationType }),
    ...(cwd && { cwd }),
    ...(origin && { origin }),
  };

  // Send to daemon, always swallow errors
  await sendToDaemon(message, { socketPath, timeoutMs: 200 }).catch(() => null);
}

function safeCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}
