import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Atomically write a JSON-serialized config to the given path. Writes to a
 * sibling temp file and renames into place, with mode 0600 on the final file.
 * The caller is responsible for validating the config object before passing it
 * here — `save.ts` does not import zod to keep it dependency-light and
 * symmetrical with `load.ts`'s separation of concerns.
 */
export function saveConfigFile(path: string, config: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify(config, null, 2) + '\n';
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
}
