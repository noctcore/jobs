/**
 * Writes the Changelog page from packages/jobs/CHANGELOG.md, the file
 * changesets maintains, so the site never drifts from the release notes. The
 * output is gitignored and regenerated before every dev, build and typecheck.
 *
 *   bun scripts/changelog.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(SITE, '..', 'packages', 'jobs', 'CHANGELOG.md');
const OUT = join(SITE, 'src', 'content', 'docs', 'reference', 'changelog.md');

export function changelogPage(source: string): string {
  // Drop the package-name heading (the page has its own title), and the
  // commit link and thank-you that @changesets/changelog-github puts before
  // every entry: on the site they read as noise ahead of the change itself.
  const body = source
    .replace(/^# .*\r?\n+/u, '')
    .replace(/^(- )\[`[0-9a-f]{7,40}`\]\([^)]*\) Thanks \[@[^\]]+\]\([^)]*\)! - /gmu, '$1')
    // A heading inside an entry would land in the page outline under the
    // release; it stays a bold line within the entry instead.
    .replace(/^( {2,})#{3,6} (.+)$/gmu, '$1**$2**');

  return [
    '---',
    'title: Changelog',
    'description: Every release of @noctcore/jobs, from the changesets in the repository.',
    '---',
    '',
    body.trimEnd(),
    '',
  ].join('\n');
}

if (import.meta.main) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, changelogPage(readFileSync(SOURCE, 'utf8')));
  console.log(`changelog: wrote ${OUT}`);
}
