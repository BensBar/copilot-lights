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

  it('follows several concurrently-active logs at once', async () => {
    const dir = tmp();
    const a = join(dir, 'process-a.log');
    const b = join(dir, 'process-b.log');
    writeFileSync(a, '');
    writeFileSync(b, '');

    const lines: string[] = [];
    const f = followSdkLogs({
      logsDir: dir,
      pollMs: 20,
      fromStart: true,
      onLine: (l) => lines.push(l),
    });
    followers.push(f);

    appendFileSync(a, 'from-a\n');
    appendFileSync(b, 'from-b\n');

    await waitFor(() => lines.includes('from-a') && lines.includes('from-b'));
    expect(lines).toContain('from-a');
    expect(lines).toContain('from-b');
  });

  it('does not re-read a tracked file when another log becomes newest', async () => {
    const dir = tmp();
    const first = join(dir, 'process-1.log');
    writeFileSync(first, 'a\n');

    const lines: string[] = [];
    const f = followSdkLogs({
      logsDir: dir,
      pollMs: 20,
      fromStart: true,
      onLine: (l) => lines.push(l),
    });
    followers.push(f);

    await waitFor(() => lines.includes('a'));

    // A second log overtakes the first on mtime. Previously this reset the
    // follower's offset to 0 and replayed the whole file.
    const second = join(dir, 'process-2.log');
    writeFileSync(second, 'b\n');
    const { utimesSync } = await import('node:fs');
    const future = Date.now() / 1000 + 5;
    utimesSync(second, future, future);

    await waitFor(() => lines.includes('b'));

    // The original file keeps streaming from where it left off.
    appendFileSync(first, 'c\n');
    await waitFor(() => lines.includes('c'));

    expect(lines.filter((l) => l === 'a')).toHaveLength(1);
    expect(lines.filter((l) => l === 'b')).toHaveLength(1);
  });

  it('bounds catch-up on a large newly-discovered log', async () => {
    const dir = tmp();

    const lines: string[] = [];
    const f = followSdkLogs({
      logsDir: dir,
      pollMs: 20,
      maxCatchupBytes: 100,
      onLine: (l) => lines.push(l),
    });
    followers.push(f);

    // Let the first (empty) scan settle so the file below counts as a
    // post-startup discovery.
    await new Promise((r) => setTimeout(r, 80));

    // 50 lines x 9 bytes = 450 bytes, well over maxCatchupBytes.
    const body = Array.from({ length: 50 }, (_, i) => `line-${String(i).padStart(3, '0')}`).join('\n') + '\n';
    writeFileSync(join(dir, 'process-big.log'), body);

    await waitFor(() => lines.length > 0);
    await new Promise((r) => setTimeout(r, 80));

    // Only the bounded tail is replayed, never the whole file.
    expect(lines).not.toContain('line-000');
    expect(lines).toContain('line-049');
    expect(lines.length).toBeLessThan(20);
    // No partial fragment leaked through as a line.
    for (const l of lines) expect(l).toMatch(/^line-\d{3}$/);
  });

  it('ignores logs outside the active window', async () => {
    const dir = tmp();
    const stale = join(dir, 'process-stale.log');
    const live = join(dir, 'process-live.log');
    // Content is written before the mtime is backdated, so if the stale file
    // were tracked at all (fromStart=true) its line would surface.
    writeFileSync(stale, 'stale-line\n');
    writeFileSync(live, '');

    const { utimesSync } = await import('node:fs');
    const longAgo = Date.now() / 1000 - 3600;
    utimesSync(stale, longAgo, longAgo);

    const lines: string[] = [];
    const f = followSdkLogs({
      logsDir: dir,
      pollMs: 20,
      activeWindowMs: 60_000,
      fromStart: true,
      onLine: (l) => lines.push(l),
    });
    followers.push(f);

    appendFileSync(live, 'live-line\n');

    await waitFor(() => lines.includes('live-line'));
    await new Promise((r) => setTimeout(r, 80));
    expect(lines).not.toContain('stale-line');
  });
});
