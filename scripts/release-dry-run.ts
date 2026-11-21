/**
 * The release workflow's publish step, in dry-run form.
 *
 * For checking a release locally. The release workflow publishes for real with
 * `bun run release`; this builds, then asks npm what each public package would
 * publish, without contacting the registry for a write.
 *
 * It prints no "New tag:" lines, so it creates no tags and no GitHub releases.
 *
 *   bun run release:dry-run
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PACKAGES = join(ROOT, 'packages');

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status === 0) return;

  console.error(`${command} ${args.join(' ')} failed in ${cwd}`);
  process.exit(result.status ?? 1);
}

run(process.execPath, ['run', 'build'], ROOT);

for (const dir of readdirSync(PACKAGES).sort()) {
  const cwd = join(PACKAGES, dir);

  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    private?: boolean;
  };

  if (manifest.private === true) continue;

  console.log(`\n=== ${manifest.name}@${manifest.version} (dry run)`);
  run('npm', ['publish', '--dry-run', '--provenance=false', '--access', 'public'], cwd);
}
