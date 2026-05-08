import { createConnection, type Socket } from 'node:net';

/**
 * Tiny client for the daemon's Unix socket. Used by the hook bridge and the
 * `status` CLI subcommand. Hard total deadline = opts.timeoutMs; never blocks longer.
 */
export interface ClientMessage {
  kind: 'event' | 'query' | 'follow' | 'reload';
  // For 'event':
  event?: string;
  sessionId?: string | null;
  ts?: number;
  toolName?: string;
  notificationType?: string;
  // For 'query':
  query?: 'status';
}

export interface ClientOptions {
  socketPath: string;
  /** Total budget end-to-end (connect + write + optional reply). Default 200ms. */
  timeoutMs?: number;
  /** If true, reads one line of reply and returns it. */
  expectReply?: boolean;
}

/**
 * Send a message to the daemon. Resolves null on any error or timeout.
 * Never throws, never blocks longer than timeoutMs.
 */
export async function sendToDaemon(
  msg: ClientMessage,
  opts: ClientOptions,
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 200;
  const socketPath = opts.socketPath;
  const expectReply = opts.expectReply ?? false;

  return new Promise((resolve) => {
    let socket: Socket | null = null;
    let timedOut = false;

    const deadline = setTimeout(() => {
      timedOut = true;
      if (socket) {
        socket.destroy();
      }
      resolve(null);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(deadline);
      if (socket) {
        socket.destroy();
      }
    };

    const handleError = () => {
      cleanup();
      resolve(null);
    };

    try {
      socket = createConnection(socketPath);

      socket.on('error', handleError);

      socket.on('connect', () => {
        if (timedOut) {
          socket?.destroy();
          return;
        }

        const line = JSON.stringify(msg) + '\n';
        socket!.write(line, (writeErr) => {
          if (writeErr) {
            handleError();
            return;
          }

          socket!.end();
        });
      });

      if (expectReply) {
        let buffer = '';

        socket.on('data', (chunk) => {
          if (timedOut) return;

          buffer += chunk.toString();
          const nlIndex = buffer.indexOf('\n');

          if (nlIndex >= 0) {
            const reply = buffer.slice(0, nlIndex);
            cleanup();
            resolve(reply);
          }
        });

        socket.on('end', () => {
          if (!timedOut && buffer.length > 0) {
            cleanup();
            resolve(buffer);
          }
        });
      } else {
        socket.on('end', () => {
          if (!timedOut) {
            cleanup();
            resolve(null);
          }
        });
      }
    } catch (error) {
      handleError();
    }
  });
}
