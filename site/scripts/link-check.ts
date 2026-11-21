/**
 * The link checks behind check-build.ts, kept free of I/O so they can be tested.
 *
 * HTML is read with a small linear scanner over real start tags. A regex over
 * the whole document would also match markup shown as text inside <code>
 * (quotes are not escaped in text nodes), and a nested-quantifier regex risks
 * polynomial backtracking. Text `<` is always emitted as `&lt;`, so a `<`
 * followed by a letter starts a tag; <script> and <style> bodies are skipped.
 */

export interface StartTag {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
}

const RAW_TEXT = new Set(['script', 'style']);
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
};

function isLetter(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z]/u.test(char);
}

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\r' || char === '\f';
}

/** Decodes the character references that appear in attribute values. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));

      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }

    return ENTITIES[ref.toLowerCase()] ?? match;
  });
}

/** Every start tag in the document, in order, with its attributes. */
export function scanStartTags(html: string): StartTag[] {
  const tags: StartTag[] = [];
  const lower = html.toLowerCase();
  let i = 0;

  while (i < html.length) {
    const open = html.indexOf('<', i);

    if (open === -1) break;

    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);

      i = close === -1 ? html.length : close + 3;
      continue;
    }

    if (!isLetter(html[open + 1])) {
      // An end tag, a doctype or a stray `<`: nothing to collect.
      i = open + 1;
      continue;
    }

    let j = open + 1;

    while (j < html.length && !isSpace(html[j]) && html[j] !== '>' && html[j] !== '/') j++;

    const name = html.slice(open + 1, j).toLowerCase();
    const attributes = new Map<string, string>();

    while (j < html.length && html[j] !== '>') {
      if (isSpace(html[j]) || html[j] === '/') {
        j++;
        continue;
      }

      const nameStart = j;

      while (j < html.length && !isSpace(html[j]) && !'=>/'.includes(html[j] ?? '')) j++;

      const attribute = html.slice(nameStart, j).toLowerCase();

      while (isSpace(html[j])) j++;

      let value = '';

      if (html[j] === '=') {
        j++;

        while (isSpace(html[j])) j++;

        const quote = html[j];

        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, j + 1);
          const stop = end === -1 ? html.length : end;

          value = html.slice(j + 1, stop);
          j = stop + 1;
        } else {
          const valueStart = j;

          while (j < html.length && !isSpace(html[j]) && html[j] !== '>') j++;

          value = html.slice(valueStart, j);
        }
      }

      if (attribute !== '' && !attributes.has(attribute))
        attributes.set(attribute, decodeEntities(value));
    }

    tags.push({ name, attributes });
    i = j + 1;

    if (RAW_TEXT.has(name)) {
      const close = lower.indexOf(`</${name}`, i);

      i = close === -1 ? html.length : close;
    }
  }

  return tags;
}

/** The fragment targets a page defines: every `id`, and `name` on anchors. */
export function collectIds(tags: readonly StartTag[]): Set<string> {
  const ids = new Set<string>();

  for (const tag of tags) {
    const id = tag.attributes.get('id');

    if (id) ids.add(id);

    const name = tag.name === 'a' ? tag.attributes.get('name') : undefined;

    if (name) ids.add(name);
  }

  return ids;
}

/** Every `href` and `src` value in the document's start tags. */
export function collectReferences(tags: readonly StartTag[]): string[] {
  const refs: string[] = [];

  for (const tag of tags) {
    for (const attribute of ['href', 'src']) {
      const value = tag.attributes.get(attribute);

      if (value !== undefined) refs.push(value);
    }
  }

  return refs;
}

export interface Page {
  /** The page's path under the base, ending in `/` (for example `/jobs/guides/dedupe/`). */
  readonly path: string;
  readonly html: string;
}

export interface SiteCheckOptions {
  /** The site base, for example `/jobs`. */
  readonly base: string;
  /** Whether a root-relative path (without query or fragment) is an emitted file. */
  readonly exists: (pathname: string) => boolean;
}

export interface SiteCheckResult {
  readonly failures: string[];
  readonly checked: number;
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/**
 * Checks every page: each root-relative reference sits under the base and
 * resolves to an emitted file, and each `#fragment` (same page or another
 * emitted page) names an id that page defines.
 */
export function checkSite(pages: readonly Page[], options: SiteCheckOptions): SiteCheckResult {
  const { base } = options;
  const failures: string[] = [];
  const idsByPath = new Map<string, Set<string>>();
  const refsByPath = new Map<string, string[]>();
  let checked = 0;

  for (const page of pages) {
    const tags = scanStartTags(page.html);

    idsByPath.set(page.path, collectIds(tags));
    refsByPath.set(page.path, collectReferences(tags));
  }

  for (const page of pages) {
    for (const ref of refsByPath.get(page.path) ?? []) {
      const hash = ref.indexOf('#');
      const fragment = hash === -1 ? '' : decodeFragment(ref.slice(hash + 1));
      const beforeHash = hash === -1 ? ref : ref.slice(0, hash);
      const pathname = beforeHash.split('?')[0] ?? '';

      if (pathname === '' && hash !== -1) {
        // A same-page link. `#` alone and `#_top` (Starlight's skip target) always work.
        checked++;
        if (fragment !== '' && fragment !== '_top' && !idsByPath.get(page.path)?.has(fragment)) {
          failures.push(`${page.path}: "#${fragment}" names no id on the page`);
        }

        continue;
      }

      if (!pathname.startsWith('/') || pathname.startsWith('//')) continue;

      checked++;

      if (!pathname.startsWith(`${base}/`) && pathname !== base) {
        failures.push(`${page.path}: "${pathname}" is outside the ${base}/ base`);
        continue;
      }

      if (!options.exists(pathname)) {
        failures.push(`${page.path}: "${pathname}" does not resolve to an emitted file`);
        continue;
      }

      const target = pathname.endsWith('/') ? pathname : `${pathname}/`;
      const targetIds = idsByPath.get(target);

      if (fragment !== '' && fragment !== '_top' && targetIds && !targetIds.has(fragment)) {
        failures.push(`${page.path}: "${pathname}#${fragment}" names no id on that page`);
      }
    }
  }

  return { failures, checked };
}
