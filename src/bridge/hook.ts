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
 * Parse a timestamp (ISO 8601) into milliseconds since epoch.
 * Fallback to now() if missing or invalid.
 */
function parseTimestamp(isoString: string | undefined, nowMs: number): number {
  if (!isoString) return nowMs;
  try {
    return new Date(isoString).getTime();
  } catch {
    return nowMs;
  }
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

  // Extract fields (snake_case from stdin, converted to camelCase)
  // sessionId resolution order:
  //   1. payload.session_id (if Copilot supplies it — current shape unknown)
  //   2. payload.sessionId (camelCase variant)
  //   3. cwd-derived synthetic id (`_cwd:<path>`) — gives different workspaces
  //      distinct buckets so a busy session in workspace A doesn't keep a
  //      stale "thinking" entry alive for an idle session in workspace B.
  //   4. final fallback `_unknown`.
  const rawSessionId =
    (payload.session_id as string | undefined) ??
    (payload.sessionId as string | undefined) ??
    undefined;
  const timestamp = parseTimestamp(payload.timestamp as string | undefined, nowMs);
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

  const message = {
    kind: 'event' as const,
    event,
    sessionId,
    ts: timestamp,
    ...(toolName && { toolName }),
    ...(notificationType && { notificationType }),
    ...(cwd && { cwd }),
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
