import { expect, test } from 'bun:test';

import { changelogPage } from './changelog';

test('drops the package heading and adds frontmatter', () => {
  const page = changelogPage('# @noctcore/jobs\n\n## 0.1.0\n\n- First release.\n');

  expect(page.startsWith('---\ntitle: Changelog\n')).toBe(true);
  expect(page).not.toContain('# @noctcore/jobs');
  expect(page).toContain('## 0.1.0\n\n- First release.\n');
});

test('strips the commit link and thank-you before an entry', () => {
  const page = changelogPage(
    '# @noctcore/jobs\n\n## 0.1.0\n\n- [`92adca5`](https://github.com/noctcore/jobs/commit/92adca5) Thanks [@someone](https://github.com/someone)! - First release.\n',
  );

  expect(page).toContain('\n- First release.\n');
  expect(page).not.toContain('Thanks');
});

test('keeps a heading inside an entry out of the page outline', () => {
  const page = changelogPage('# @noctcore/jobs\n\n## 0.1.0\n\n- First release.\n\n  ### Highlights\n\n  - One.\n');

  expect(page).toContain('\n  **Highlights**\n');
  expect(page).not.toContain('### Highlights');
});
