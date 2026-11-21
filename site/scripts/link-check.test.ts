import { describe, expect, it } from 'bun:test';
import { checkSite, collectIds, decodeEntities, scanStartTags, type Page } from './link-check';

const BASE = '/jobs';

function check(pages: Page[], emitted: string[] = pages.map((p) => p.path)) {
  const files = new Set(emitted);

  return checkSite(pages, {
    base: BASE,
    exists: (pathname) => files.has(pathname) || files.has(`${pathname}/`),
  });
}

describe('scanStartTags', () => {
  it('reads attributes in double, single and no quotes', () => {
    const [tag] = scanStartTags(`<a href="/jobs/x/" data-a='1' id=top hidden>`);

    expect(tag?.name).toBe('a');
    expect(Object.fromEntries(tag?.attributes ?? [])).toEqual({
      href: '/jobs/x/',
      'data-a': '1',
      id: 'top',
      hidden: '',
    });
  });

  it('ignores markup shown as text inside code', () => {
    const html = '<p><code>&lt;img src="assets/x.webp"&gt;</code></p><img src="/jobs/a.png">';
    const srcs = scanStartTags(html).flatMap((t) => t.attributes.get('src') ?? []);

    expect(srcs).toEqual(['/jobs/a.png']);
  });

  it('skips script and style bodies and comments', () => {
    const html = [
      '<script>const s = "<a href=\'/nope/\'>";</script>',
      '<style>a[href="/nope/"]{}</style>',
      '<!-- <a href="/nope/"> -->',
      '<a href="/jobs/yes/">',
    ].join('');

    const hrefs = scanStartTags(html).flatMap((t) => t.attributes.get('href') ?? []);

    expect(hrefs).toEqual(['/jobs/yes/']);
  });

  it('decodes entities in attribute values', () => {
    expect(decodeEntities('a&amp;b&#39;c&#x22;')).toBe('a&b\'c"');
    expect(scanStartTags('<a href="/jobs/?a=1&amp;b=2">')[0]?.attributes.get('href')).toBe(
      '/jobs/?a=1&b=2',
    );
  });

  it('finishes on a truncated tag without looping', () => {
    expect(scanStartTags('<a href="/jobs/x/').length).toBe(1);
    expect(scanStartTags('a < b and <').length).toBe(0);
  });
});

describe('collectIds', () => {
  it('collects ids and anchor names', () => {
    const ids = collectIds(scanStartTags('<h2 id="setup">x</h2><a name="old"></a><p name="no">'));

    expect([...ids].sort()).toEqual(['old', 'setup']);
  });
});

describe('checkSite', () => {
  it('passes links that resolve and anchors that exist', () => {
    const pages: Page[] = [
      { path: '/jobs/', html: '<a href="/jobs/b/#part">b</a><a href="#top">t</a><i id="top"></i>' },
      { path: '/jobs/b/', html: '<h2 id="part">Part</h2><a href="#_top">skip</a>' },
    ];

    expect(check(pages).failures).toEqual([]);
  });

  it('reports a path outside the base and a missing file', () => {
    const pages: Page[] = [
      { path: '/jobs/', html: '<a href="/learn/"></a><a href="/jobs/gone/"></a>' },
    ];

    expect(check(pages).failures).toEqual([
      '/jobs/: "/learn/" is outside the /jobs/ base',
      '/jobs/: "/jobs/gone/" does not resolve to an emitted file',
    ]);
  });

  it('reports a same-page anchor with no id', () => {
    const pages: Page[] = [{ path: '/jobs/', html: '<a href="#missing"></a>' }];

    expect(check(pages).failures).toEqual(['/jobs/: "#missing" names no id on the page']);
  });

  it('reports an anchor missing on another page', () => {
    const pages: Page[] = [
      { path: '/jobs/', html: '<a href="/jobs/b/#nope"></a>' },
      { path: '/jobs/b/', html: '<h2 id="yes"></h2>' },
    ];

    expect(check(pages).failures).toEqual(['/jobs/: "/jobs/b/#nope" names no id on that page']);
  });

  it('ignores external, protocol-relative and relative links', () => {
    const html =
      '<a href="https://example.com/#x"></a><a href="//cdn.example.com/a.js"></a><a href="other/"></a>';

    expect(check([{ path: '/jobs/', html }])).toEqual({ failures: [], checked: 0 });
  });

  it('checks assets by file and decodes percent-encoded fragments', () => {
    const pages: Page[] = [
      {
        path: '/jobs/',
        html: '<img src="/jobs/logo.svg"><a href="#caf%C3%A9"></a><b id="café"></b>',
      },
    ];

    expect(check(pages, ['/jobs/', '/jobs/logo.svg']).failures).toEqual([]);
  });
});
