import { describe, it, expect, afterEach } from 'vitest';
import { createServer, Server } from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runStatusline } from '../../../src/bridge/statusline.js';

function makeServer(reply: object): Promise<{ socketPath: string; server: Server }> {
  const socketsDir = path.join(process.cwd(), '.test-sockets');
  if (!fs.existsSync(socketsDir)) fs.mkdirSync(socketsDir, { recursive: true });
  const socketPath = path.join(socketsDir, `statusline-${randomBytes(8).toString('hex')}.sock`);
  const server = createServer((socket) => {
    let buf = '';
    socket.on('data', (c) => {
      buf += c.toString();
      if (buf.includes('\n')) {
        socket.end(JSON.stringify(reply) + '\n');
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(socketPath, () => resolve({ socketPath, server }));
    server.once('error', reject);
  });
}

describe('runStatusline', () => {
  let server: Server | null = null;
  let socketPath = '';

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    try {
      if (socketPath && fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    } catch {
      // ignore
    }
  });

  it('returns an offline marker when the daemon socket does not exist', async () => {
    const r = await runStatusline({
      socketPath: path.join(process.cwd(), '.test-sockets', 'never-exists.sock'),
      timeoutMs: 100,
      color: false,
    });
    expect(r.daemonReachable).toBe(false);
    expect(r.text).toContain('offline');
  });

  it('renders glyph + label for the ready state', async () => {
    ({ socketPath, server } = await makeServer({
      kind: 'status',
      state: 'ready',
      sessions: 1,
      adapter: { kind: 'mock', ok: true, lastError: null },
    }));
    const r = await runStatusline({ socketPath, timeoutMs: 1000, color: false });
    expect(r.daemonReachable).toBe(true);
    expect(r.text.toLowerCase()).toContain('ready');
  });

  it('renders an adapter-warning suffix when adapter.ok is false', async () => {
    ({ socketPath, server } = await makeServer({
      kind: 'status',
      state: 'thinking',
      sessions: 1,
      adapter: { kind: 'mock', ok: false, lastError: 'boom' },
    }));
    const r = await runStatusline({ socketPath, timeoutMs: 1000, color: false });
    expect(r.text).toMatch(/⚠/);
  });

  it('emits ANSI when color is enabled', async () => {
    ({ socketPath, server } = await makeServer({
      kind: 'status',
      state: 'thinking',
      sessions: 1,
      adapter: { kind: 'mock', ok: true, lastError: null },
    }));
    const r = await runStatusline({ socketPath, timeoutMs: 1000, color: true });
    // eslint-disable-next-line no-control-regex
    expect(r.text).toMatch(/\u001b\[/);
  });
});
