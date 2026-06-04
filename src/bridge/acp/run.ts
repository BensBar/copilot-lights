/**
 * `copilot-lights acp-run` implementation: launch Copilot CLI in ACP mode as a
 * subprocess and drive an interactive session, forwarding authoritative
 * lifecycle events to the daemon.
 *
 * This is the opt-in, high-fidelity event source. The transparent hook
 * pipeline remains the zero-config default; ACP applies only when the user
 * chooses to launch their session *through* copilot-lights.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { sendToDaemon } from '../client.js';
import { AcpSession, type AcpPermissionOutcome, type AcpPermissionRequest } from './client.js';
import { NdjsonDecoder } from './jsonrpc.js';
import type { WireEvent } from './translate.js';

/** Minimal structural view of the spawned agent process we depend on. */
export interface AcpChild {
  stdin: NodeJS.WritableStream & { writable: boolean };
  stdout: NodeJS.ReadableStream;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'exit', cb: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  killed: boolean;
}

export interface AcpAvailability {
  available: boolean;
  detail: string;
}

/**
 * Best-effort detection of whether `copilot` exists and advertises `--acp`.
 * Runs `copilot --help` with a short timeout and looks for the flag. Never
 * throws; returns a structured result for `doctor` to render.
 */
export function detectCopilotAcp(command = 'copilot'): AcpAvailability {
  let res;
  try {
    res = spawnSync(command, ['--help'], {
      timeout: 4000,
      encoding: 'utf8',
    });
  } catch (err) {
    return {
      available: false,
      detail: `could not run \`${command} --help\`: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { available: false, detail: `\`${command}\` not found on PATH` };
    }
    return { available: false, detail: `\`${command} --help\` failed: ${res.error.message}` };
  }
  const help = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (help.includes('--acp')) {
    return { available: true, detail: `\`${command}\` supports --acp` };
  }
  return {
    available: false,
    detail: `\`${command}\` found but does not advertise --acp (update Copilot CLI; ACP is public preview)`,
  };
}

export interface RunAcpOptions {
  socketPath: string;
  cwd?: string;
  /** The Copilot executable name/path. Default `copilot`. */
  command?: string;
  /** Extra args passed through to `copilot --acp --stdio <args...>`. */
  extraArgs?: string[];
  /** Test seam: inject a child process instead of spawning. */
  spawnChild?: () => AcpChild;
  /** Test seam for stdin/stdout. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * Run an interactive ACP session to completion. Resolves when the user ends
 * the session (EOF / Ctrl-D) or the agent process exits.
 */
export async function runAcp(opts: RunAcpOptions): Promise<number> {
  const command = opts.command ?? 'copilot';
  const cwd = opts.cwd ?? process.cwd();
  const output = opts.output ?? process.stdout;
  const input = opts.input ?? process.stdin;

  const child: AcpChild = opts.spawnChild
    ? opts.spawnChild()
    : (spawn(command, ['--acp', '--stdio', ...(opts.extraArgs ?? [])], {
        cwd,
        stdio: ['pipe', 'pipe', 'inherit'],
      }) as unknown as AcpChild);

  const write = (line: string): void => {
    if (child.stdin.writable) child.stdin.write(line);
  };
  const log = (msg: string): void => {
    output.write(msg.endsWith('\n') ? msg : `${msg}\n`);
  };

  // Forward translated events to the daemon (fire-and-forget, like hooks).
  const emit = (event: WireEvent): void => {
    void sendToDaemon(
      { kind: 'event', ...event },
      { socketPath: opts.socketPath, timeoutMs: 200 },
    ).catch(() => null);
  };

  const rl: Interface = createInterface({ input, output, terminal: false });

  const session = new AcpSession({
    send: write,
    emit,
    cwd,
    requestTimeoutMs: 0,
    onAgentText: (text) => output.write(text),
    permissionResponder: (req) => promptPermission(rl, output, req),
    logError: (m) => log(`[acp] ${m}`),
  });

  const decoder = new NdjsonDecoder((bad) => log(`[acp] dropping malformed line: ${bad.slice(0, 120)}`));
  child.stdout.on('data', (chunk: Buffer) => {
    for (const msg of decoder.push(chunk)) session.receive(msg);
  });

  const exitCode = await new Promise<number>((resolve) => {
    let resolved = false;
    const finish = (code: number): void => {
      if (resolved) return;
      resolved = true;
      resolve(code);
    };

    child.on('error', (err) => {
      log(`[acp] failed to launch ${command}: ${err.message}`);
      finish(127);
    });
    child.on('exit', (code) => finish(code ?? 0));

    (async () => {
      try {
        await session.initialize();
        log('[acp] session ready — type a prompt, Ctrl-D to end.');
        for await (const line of rl) {
          const text = line.trim();
          if (text.length === 0) continue;
          await session.prompt(text);
        }
      } catch (err) {
        log(`[acp] ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        session.end();
        rl.close();
        if (!child.killed) child.kill('SIGTERM');
        finish(0);
      }
    })();
  });

  return exitCode;
}

/** Ask the user to resolve a permission request on the shared readline. */
async function promptPermission(
  rl: Interface,
  output: NodeJS.WritableStream,
  req: AcpPermissionRequest,
): Promise<AcpPermissionOutcome> {
  if (req.options.length === 0) {
    return { outcome: 'cancelled' };
  }
  output.write(`\n[acp] permission requested${req.toolName ? ` for ${req.toolName}` : ''}:\n`);
  req.options.forEach((o, i) => {
    output.write(`  ${i + 1}) ${o.name ?? o.optionId}\n`);
  });
  const answer = await new Promise<string>((resolve) => {
    rl.question('[acp] choose [1] / (c)ancel: ', resolve);
  });
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === '') {
    return { outcome: 'selected', optionId: req.options[0]!.optionId };
  }
  if (trimmed === 'c' || trimmed === 'cancel') {
    return { outcome: 'cancelled' };
  }
  const idx = Number.parseInt(trimmed, 10);
  if (Number.isInteger(idx) && idx >= 1 && idx <= req.options.length) {
    return { outcome: 'selected', optionId: req.options[idx - 1]!.optionId };
  }
  return { outcome: 'cancelled' };
}
