import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { followSdkLogs, type Follower } from '../../../../src/bridge/sdklog/tail.js';

const dirs: string[] = [];
const followers: Follower[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cl-sdklog-'));
  dirs.push(d);
  return d;
}

async function waitFor(
  pred: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(async () => {
  for (const f of followers.splice(0)) {
    f.stop();
    await f.done().catch(() => {});
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('followSdkLogs', () => {
  it('emits lines appended after start (tail from end)', async () => {
    const dir = tmp();
    const file = join(dir, 'process-1.log');
    writeFileSync(file, 'old line that should be skipped\n');

    const lines: string[] = [];
    const f = followSdkLogs({ logsDir: dir, pollMs: 20, onLine: (l) => lines.push(l) });
    followers.push(f);

    // Give the poller a moment to lock onto the file at its end.
    await new Promise((r) => setTimeout(r, 60));
    appendFileSync(file, 'fresh-1\nfresh-2\n');

    await waitFor(() => lines.length >= 2);
    expect(lines).toEqual(['fresh-1', 'fresh-2']);
  });

  it('replays from the beginning when fromStart=true', async () => {
    const dir = tmp();
    const file = join(dir, 'process-1.log');
    writeFileSync(file, 'a\nb\n');

    const lines: string[] = [];
    const f = followSdkLogs({
      logsDir: dir,
      pollMs: 20,
      fromStart: true,
      onLine: (l) => lines.push(l),
    });
    followers.push(f);

    await waitFor(() => lines.length >= 2);
    expect(lines).toEqual(['a', 'b']);
  });

  it('buffers partial lines until a newline arrives', async () => {
    const dir = tmp();
    const file = join(dir, 'process-1.log');
    writeFileSync(file, '');

    const lines: string[] = [];
    const f = followSdkLogs({
      logsDir: dir,
      pollMs: 20,
      fromStart: true,
      onLine: (l) => lines.push(l),
    });
    followers.push(f);

    appendFileSync(file, 'partial');
    await new Promise((r) => setTimeout(r, 80));
    expect(lines).toEqual([]);

    appendFileSync(file, '-rest\n');
    await waitFor(() => lines.length >= 1);
    expect(lines).toEqual(['partial-rest']);
  });

  it('switches to a newer file on rotation (read from start)', async () => {
    const dir = tmp();
    const first = join(dir, 'process-1.log');
    writeFileSync(first, 'first-old\n');

    const lines: string[] = [];
    const f = followSdkLogs({ logsDir: dir, pollMs: 20, onLine: (l) => lines.push(l) });
    followers.push(f);

    await new Promise((r) => setTimeout(r, 60));

    // A newer process log appears; ensure a strictly greater mtime.
    const second = join(dir, 'process-2.log');
    const future = Date.now() / 1000 + 5;
    writeFileSync(second, 'rotated-1\nrotated-2\n');
    // Bump mtime to guarantee it's newest even on coarse filesystems.
    const { utimesSync } = await import('node:fs');
    utimesSync(second, future, future);

    await waitFor(() => lines.includes('rotated-1') && lines.includes('rotated-2'));
    expect(lines).not.toContain('first-old');
  });

  it('restarts from the top when the current file is truncated', async () => {
    const dir = tmp();
    const file = join(dir, 'process-1.log');
    writeFileSync(file, 'line-1\n');

    const lines: string[] = [];
    const f = followSdkLogs({
      logsDir: dir,
      pollMs: 20,
      fromStart: true,
      onLine: (l) => lines.push(l),
    });
    followers.push(f);

    await waitFor(() => lines.includes('line-1'));

    // Truncate in place (file shrinks), let the poller observe it, then write
    // new content — this is how a log clear/rotate-in-place looks.
    writeFileSync(file, '');
    await new Promise((r) => setTimeout(r, 80));
    appendFileSync(file, 'after-truncate\n');
    await waitFor(() => lines.includes('after-truncate'));
  });

  it('tolerates a missing logs directory', async () => {
    const f = followSdkLogs({
      logsDir: join(tmpdir(), 'cl-sdklog-does-not-exist-xyz'),
      pollMs: 20,
      onLine: () => {},
    });
    followers.push(f);
    // Should not throw; just idle.
    await new Promise((r) => setTimeout(r, 60));
    expect(true).toBe(true);
  });
});
