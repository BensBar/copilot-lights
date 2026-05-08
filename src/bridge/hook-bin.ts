import { defaultSocketPath } from '../config/load.js';
import { runHook } from './hook.js';

/**
 * Read all stdin with a 500ms timeout, then fire the hook.
 * Always returns gracefully, never throws.
 */
export async function mainHook(eventArg: string): Promise<void> {
  let stdin = '';

  try {
    stdin = await readStdinWithTimeout(500);
  } catch {
    // Timeout or error → continue with empty stdin
  }

  try {
    await runHook({
      event: eventArg,
      stdin,
      socketPath: defaultSocketPath(),
    });
    // Optional debug capture: when COPILOT_LIGHTS_LOG_HOOKS is set, append
    // each event's raw stdin to a log file. Used to investigate the
    // session_id field shape (multiple Copilot sessions currently merge
    // into _unknown). Cheap I/O, only on when explicitly enabled.
    if (process.env.COPILOT_LIGHTS_LOG_HOOKS) {
      try {
        const fs = await import('node:fs');
        const line = `${new Date().toISOString()} ${eventArg} ${JSON.stringify({ stdin })}\n`;
        fs.appendFileSync(process.env.COPILOT_LIGHTS_LOG_HOOKS, line);
      } catch {
        // ignore
      }
    }
  } catch {
    // Swallow all errors
  }
}

/**
 * Read all available stdin with a timeout.
 */
function readStdinWithTimeout(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timeout = setTimeout(() => {
      reject(new Error('stdin read timeout'));
    }, timeoutMs);

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });

    process.stdin.on('end', () => {
      clearTimeout(timeout);
      resolve(data);
    });

    process.stdin.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
