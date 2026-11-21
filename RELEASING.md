# Releasing

Releases are made by the `release` workflow (`.github/workflows/release.yml`) with
[changesets](https://github.com/changesets/changesets). Publishing goes through npm trusted
publishing (GitHub OIDC), so there is no npm token anywhere, and every version carries provenance.

## The flow

1. **Pull requests carry a changeset.** A PR that changes the package runs `bun run changeset`; a
   PR that releases nothing runs `bun run changeset --empty`. The `changeset status` check
   enforces it.
2. **Merging to `main` opens or updates the "Version Packages" PR.** The workflow runs
   `changeset version` (through `bun run version-packages`), which bumps the version and writes the
   CHANGELOG, then refreshes `bun.lock`.
3. **Review the Version Packages PR.** Check the version and the changelog text. Edit a changeset on
   `main` if the wording is wrong, and the PR updates itself.
4. **Merging the Version Packages PR publishes.** With no changesets pending, the workflow builds
   and tests, then runs `bun run release` (`changeset publish`). The new version goes to npm with
   provenance, and the workflow pushes a `@noctcore/jobs@<version>` tag and creates a GitHub
   release for it.

The release job runs only on `main`. Never run `npm publish` by hand for a real version and never
push release tags by hand. If a run fails halfway, re-run the failed workflow: `changeset publish`
skips versions that already exist on npm.

## Checks before a release

`bun run check:package` (publint and arethetypeswrong) and `bun run release:dry-run` (build, then
`npm publish --dry-run`) show what would be published. The package ships only `dist`, `README.md`,
`LICENSE` and `package.json`.

## Owner-only steps

### Once, to set up the repository

1. Create the public repository `noctcore/jobs` and push `main`.
2. Copy the settings of `noctcore/auth`:
   - the `main` ruleset: pull request required, the required checks
     `build · lint · typecheck · package shape`, `test`, `test · windows`, `integration · redis`,
     `peer range floor (nest 11.0.0, bullmq 6.3.0, ioredis 5.4.0)` and `changeset status`, no force
     push, no deletion;
   - Actions: "Allow GitHub Actions to create and approve pull requests" on (the Version Packages
     PR), and workflow permissions read-only by default (each workflow asks for what it needs);
   - private vulnerability reporting, Dependabot alerts and security updates, secret scanning and
     push protection on; Discussions as on auth.
3. Create the labels the workflows and templates use (the labeler never creates one):
   `release`, `dependencies`, `ci`, `bug`, `enhancement`, `pkg: jobs`, `area: testing`,
   `area: docs`.

### Once, for the first publish

npm only lets you register a trusted publisher on a package that exists, so the name is created
first, then the workflow publishes 0.1.0.

1. Create the package with a placeholder, from a clean directory outside the repository, logged in
   with 2FA:

   ```sh
   mkdir jobs-placeholder && cd jobs-placeholder
   printf '{ "name": "@noctcore/jobs", "version": "0.0.1", "description": "Placeholder; the first release is 0.1.0.", "license": "MIT", "repository": { "type": "git", "url": "git+https://github.com/noctcore/jobs.git" } }\n' > package.json
   printf '# @noctcore/jobs\n\nPlaceholder. See https://github.com/noctcore/jobs\n' > README.md
   npm publish --access public
   npm deprecate @noctcore/jobs@0.0.1 "Placeholder, use 0.1.0 or later."
   ```

2. Register the trusted publisher, either on npmjs.com (package, Settings, Trusted publisher,
   GitHub Actions: organization or user `noctcore`, repository `jobs`, workflow `release.yml`, no
   environment) or from the command line:

   ```sh
   npx npm@12 trust github @noctcore/jobs --repo noctcore/jobs --file release.yml --allow-publish
   ```

   Run the first CI publish soon after: a trust configuration that has never been used can expire
   (about two days at the time of writing), and then it has to be registered again.
3. On the package's npm settings, set publishing access to "Require two-factor authentication and
   disallow tokens", so trusted publishing is the only way in.
4. Merge the first pull request into `main` (it carries `.changeset/first-release.md`). The release
   workflow opens the Version Packages PR for `0.1.0`; review the changelog and merge it. The
   workflow publishes `@noctcore/jobs@0.1.0` with provenance, tags it and creates the GitHub
   release.
5. Check the result: `npm view @noctcore/jobs@0.1.0 dist.attestations` shows the provenance, and
   the npm page shows the "Built and signed on GitHub Actions" badge.

### Every release

- Merge the Version Packages PR. Nothing else publishes.
- Moving dist-tags needs an interactive npm login with 2FA (trusted publishing only covers
  `npm publish`).
