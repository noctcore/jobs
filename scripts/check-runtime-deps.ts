/**
 * Keeps every published package's runtime dependency list to what was decided.
 *
 * Whatever a package lists in `dependencies`, `optionalDependencies` or
 * `peerDependencies` is installed (or asked for) in every consumer's app, next
 * to their sessions and password hashes. A new entry is a new party that can
 * ship code into that app, so it must be an explicit decision, not a side
 * effect of a refactor: this fails when a manifest names a package the
 * allowlist in `scripts/runtime-dependencies.json` does not, and also when the
 * allowlist names one the manifest no longer has, so the list never goes stale.
 *
 * To add a runtime dependency, add it to the allowlist in the same pull
 * request and say why in its description.
 *
 *   bun scripts/check-runtime-deps.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES = fileURLToPath(new URL('../packages/', import.meta.url));
const ALLOWLIST = fileURLToPath(new URL('./runtime-dependencies.json', import.meta.url));
const FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

type Field = (typeof FIELDS)[number];
type Manifest = { readonly name: string; readonly private?: boolean } & {
  readonly [F in Field]?: Readonly<Record<string, string>>;
};
type Allowlist = Readonly<Record<string, Readonly<Record<Field, readonly string[]>>>>;

const allowlist = JSON.parse(readFileSync(ALLOWLIST, 'utf8')) as Allowlist;
const problems: string[] = [];

const published = readdirSync(PACKAGES)
  .sort()
  .map((dir) => JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8')) as Manifest)
  .filter((manifest) => manifest.private !== true);

for (const manifest of published) {
  const allowed = allowlist[manifest.name];

  if (!allowed) {
    problems.push(`${manifest.name}: not in scripts/runtime-dependencies.json`);
    continue;
  }

  for (const field of FIELDS) {
    const actual = Object.keys(manifest[field] ?? {});
    const expected = allowed[field] ?? [];

    for (const name of actual.filter((dep) => !expected.includes(dep)))
      problems.push(`${manifest.name}: ${field} has "${name}", which the allowlist does not`);

    for (const name of expected.filter((dep) => !actual.includes(dep)))
      problems.push(
        `${manifest.name}: the allowlist names "${name}" in ${field}, the manifest does not`,
      );
  }
}

for (const name of Object.keys(allowlist).filter((n) => !published.some((m) => m.name === n)))
  problems.push(`${name}: in the allowlist but not a published package`);

if (problems.length > 0) {
  console.error(
    `runtime dependency check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}\n\n` +
      'A runtime dependency ships into every consumer. Add it to scripts/runtime-dependencies.json ' +
      'in the same pull request, and say why in its description.',
  );

  process.exit(1);
}

console.log(`runtime dependencies ok: ${published.length} package(s)`);
