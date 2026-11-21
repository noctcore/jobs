# noctcore/jobs identity

The README header, the social preview, the icons and the docs hero follow the noctcore blueprint
brand ([`noctcore/.github` `brand/BRAND.md`](https://github.com/noctcore/.github/blob/main/brand/BRAND.md)).
Everything here is generated, not hand edited.

**The mark.** A worker's frame holds one job, the visible core, deep in its mouth, and the next job
waits outside at the entrance: one job held, the next in turn. It uses the family's parts (a 64 unit
canvas, a four unit grid, eight unit strokes and an eight unit core) and is stored as rectangles,
both in `design.mjs` and as `marks.jobs` in the shared generator.

**The banner.** One `add()` on its way to `completed`: the producer guard stops a request that would
hang while Redis is down, the required dedupe stops a repeat of the same job, the queue policy's
jittered backoff stops a retry storm, and a `JobHost` worker runs the job. Inside `add()` the guard
runs first and the dedupe is applied by BullMQ as the job is stored, which is the order drawn.

**The docs hero** adds the second path the package owns: one sweep declared on two replicas, both
upserting the same scheduler, so each tick runs once rather than once per replica.

## Sources

| Files | Source |
| --- | --- |
| `readme-header-dark.svg`, `readme-header-light.svg`, `social-preview.svg`, `social-preview.png` | `brand/specs/jobs.json` in `noctcore/.github`, rendered with `node render.mjs ../specs/jobs.json <out>` from `brand/generator` |
| `icon.svg`, `icon-mono.svg`, `favicon.svg`, `logo*.svg`, `hero-dark.svg`, `hero-light.svg` | `design.mjs` in this folder |
| `icon-{16,32,64,180,512}.png`, `social-preview.png` (checked) | `export.mjs` in this folder |

```sh
cd assets/brand
bun install
node design.mjs        # writes the outlined SVGs
node export.mjs        # writes and checks the PNGs; --check verifies they are current
```

The docs site uses copies of `logo-*.svg` and `hero-*.svg` (in `site/src/assets/brand/`) and of
`favicon.svg` (in `site/public/`). Copy them again after a change.

| File | Purpose |
| --- | --- |
| `readme-header-dark.svg`, `readme-header-light.svg` | 1280 x 360 README header for a dark or light surface |
| `social-preview.png` | 1280 x 640 GitHub social preview; upload it in Settings, General, Social preview |
| `icon.svg`, `icon-*.png` | Night tile icon and its exports (favicon, app icon, avatar) |
| `icon-mono.svg` | Transparent single colour mark using `currentColor` |
| `favicon.svg` | The docs site favicon |
| `logo-light.svg`, `logo-dark.svg`, `logo.svg` | Lockups for a light or dark surface |
| `hero-light.svg`, `hero-dark.svg` | 1040 x 680 docs hero |

All lettering is outlined: the SVGs load no fonts, scripts or images. Manrope and DM Mono are used
under the SIL Open Font License 1.1; the fonts are in `fonts/` and the notices in `licenses/`.
