/**
 * Holds every GitHub Actions workflow to two rules:
 *
 * - each `uses:` names a full 40-character commit SHA followed by its version
 *   as a `# vX.Y.Z` comment. A tag or branch can be moved to new code after
 *   review (a compromised action retagged); a SHA cannot, and the comment is
 *   what Dependabot updates and a reviewer reads;
 * - each workflow sets `permissions:` at the top level, so a job that forgets
 *   its own block gets what the workflow granted, not the repository default.
 *
 * Local actions (`uses: ./path`) are allowed as they are.
 *
 *   bun scripts/check-workflows.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const USES = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/u;
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/u;
const VERSION_COMMENT = /^\s+#\s+v\d+(?:\.\d+){0,2}\b/u;

const problems: string[] = [];
const files = readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/u.test(file));

for (const file of files.sort()) {
  const lines = readFileSync(join(WORKFLOWS, file), 'utf8').split(/\r?\n/u);

  if (!lines.some((line) => /^permissions:/u.test(line)))
    problems.push(`${file}: no top-level permissions block`);

  lines.forEach((line, index) => {
    const match = USES.exec(line);

    if (!match) return;

    const [, target = '', rest = ''] = match;

    if (target.startsWith('./')) return;
    if (!PINNED.test(target))
      problems.push(`${file}:${index + 1}: ${target} is not pinned to a SHA`);
    else if (!VERSION_COMMENT.test(rest))
      problems.push(`${file}:${index + 1}: ${target} has no "# vX.Y.Z" comment`);
  });
}

if (problems.length > 0) {
  console.error(`workflow check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

console.log(`workflows ok: ${files.length} file(s)`);
