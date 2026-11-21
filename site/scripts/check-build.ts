/**
 * Post-build check of dist/. A wrong `base` builds green and 404s every asset,
 * so this reads the emitted HTML: the overview exists, every root-relative
 * href/src sits under /jobs/ and resolves to an emitted file, and every
 * `#fragment` names an id on its target page. The checks are in link-check.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSite, type Page } from './link-check';

const BASE = '/jobs';
const DIST = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'dist');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function emitted(pathname: string): boolean {
  const rel = decodeURIComponent(pathname.slice(BASE.length + 1));

  const candidates =
    rel === '' || rel.endsWith('/')
      ? [join(DIST, rel, 'index.html')]
      : [join(DIST, rel), join(DIST, rel, 'index.html')];

  return candidates.some((c) => existsSync(c));
}

/** `dist/guides/baselines/index.html` is served as `/jobs/guides/baselines/`. */
function pagePath(file: string): string {
  const rel = relative(DIST, file).split(sep).join('/');
  const dir = rel.endsWith('index.html') ? rel.slice(0, -'index.html'.length) : rel;

  return `${BASE}/${dir}`;
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('check-build: dist/index.html was not emitted');
  process.exit(1);
}

const pages: Page[] = walk(DIST)
  .filter((f) => f.endsWith('.html'))
  .map((file) => ({ path: pagePath(file), html: readFileSync(file, 'utf8') }));

const { failures, checked } = checkSite(pages, { base: BASE, exists: emitted });

console.log(`check-build: ${pages.length} HTML pages, ${checked} references checked`);

if (failures.length > 0) {
  const unique = [...new Set(failures)];

  console.error(`check-build: ${unique.length} failure(s)\n  ${unique.slice(0, 50).join('\n  ')}`);
  process.exit(1);
}
