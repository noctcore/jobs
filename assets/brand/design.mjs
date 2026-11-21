// The noctcore/jobs identity: the mark, the logos, the icons and the docs hero.
// The README headers and the social preview are rendered by the shared
// generator in noctcore/.github (brand/specs/jobs.json); see README.md.
// All visible lettering is converted to paths.
import console from 'node:console';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import * as fontkit from 'fontkit';

const directory = new URL('./', import.meta.url);
const font = fontkit.openSync(fileURLToPath(new URL('fonts/Manrope.ttf', directory)));
const sans = font.getVariation({ wght: 550 });
const display = font.getVariation({ wght: 600 });
const mono = fontkit.openSync(fileURLToPath(new URL('fonts/DMMono-Regular.ttf', directory)));

// The noctcore night and paper palettes (noctcore/.github brand/tokens.json).
const palettes = {
  dark: {
    background: '#17212D',
    foreground: '#F0F3F6',
    accent: '#AAC8E2',
    secondary: '#B3BEC9',
    line: '#405367',
    grid: '#253344',
    raised: '#202F40',
    side: '#2C4055',
    stop: '#D9A08E',
    shadow: '#101924',
  },
  light: {
    background: '#F6F5F1',
    foreground: '#202B39',
    accent: '#355E87',
    secondary: '#596773',
    line: '#B9C6D0',
    grid: '#E3E6E6',
    raised: '#EDF0F1',
    side: '#CCD8E1',
    stop: '#92513E',
    shadow: '#DDE2E4',
  },
};
const round = (value) => Number(value.toFixed(3));
const escape = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function lettering(value, x, y, size, color, face = sans, spacing = 0) {
  const run = face.layout(value);
  const scale = size / face.unitsPerEm;
  const preciseScale = Number(scale.toFixed(6));
  let cursor = x;
  const paths = run.glyphs
    .map((glyph, index) => {
      const position = run.positions[index];
      const d = glyph.path.toSVG();
      const out = d
        ? `<path d="${d}" transform="translate(${round(cursor + position.xOffset * scale)} ${round(y - position.yOffset * scale)}) scale(${preciseScale} ${-preciseScale})"/>`
        : '';
      cursor += position.xAdvance * scale + spacing;
      return out;
    })
    .join('');
  return `<g fill="${color}" aria-label="${escape(value)}">${paths}</g>`;
}

function measure(value, size, face = sans, spacing = 0) {
  const run = face.layout(value);
  const scale = size / face.unitsPerEm;
  return run.positions.reduce((sum, position) => sum + position.xAdvance * scale + spacing, 0);
}

/** Text centred on x. */
const centred = (value, x, y, size, color, face = sans, spacing = 0) =>
  lettering(value, x - measure(value, size, face, spacing) / 2, y, size, color, face, spacing);

function document(width, height, title, description, content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc"><title id="title">${escape(title)}</title><desc id="desc">${escape(description)}</desc>${content}</svg>\n`;
}

function rectangle(x, y, width, height, fill, radius = 0, stroke = 'none') {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}"/>`;
}

function line(path, color, width = 1, extra = '') {
  return `<path d="${path}" fill="none" stroke="${color}" stroke-width="${width}" ${extra}/>`;
}

/*
 * The mark: a worker's frame holds one job (the core) deep in its mouth, and
 * the next job waits outside at the entrance. Same parts as every noctcore
 * mark: a 64 unit canvas, occupied area 12..52, a four unit grid, eight unit
 * strokes and an eight unit core. Kept in step with `marks.jobs` in
 * noctcore/.github brand/generator/brand.mjs.
 */
const RECTS = [
  [12, 28, 8, 8],
  [24, 12, 28, 8],
  [44, 20, 8, 24],
  [24, 44, 28, 8],
  [32, 28, 8, 8],
];
const rectPath = (rects, dy = 0) =>
  rects.map(([x, y, w, h]) => `M${x} ${y + dy}h${w}v${h}h${-w}z`).join('');
const geometry = `<path d="${rectPath(RECTS)}"/>`;

function mark(x, y, size, color) {
  return `<g transform="translate(${x} ${y}) scale(${round(size / 64)})" fill="${color}">${geometry}</g>`;
}

function lockup(x, y, scale, palette) {
  return `<g transform="translate(${x} ${y}) scale(${scale})">${mark(0, 0, 64, palette.accent)}${lettering('noctcore/jobs', 72, 47, 43, palette.foreground, display, -0.4)}</g>`;
}

function grid(palette, width, height) {
  return `<defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="${palette.grid}" stroke-width="1"/></pattern></defs>${rectangle(0, 0, width, height, palette.background)}<g opacity=".48">${rectangle(0, 0, width, height, 'url(#grid)')}</g>`;
}

/** The mark as a solid block: side faces below, the face on top, a hairline on its upper edges. */
function block(cx, cy, size, palette) {
  return (
    `<g transform="translate(${round(cx - size / 2)} ${round(cy - size / 2)}) scale(${round(size / 64)})">` +
    `<path d="${rectPath(RECTS, 6)}" fill="${palette.side}"/>` +
    `<path d="${rectPath(RECTS)}" fill="${palette.accent}"/>` +
    line('M12 28h8M24 12h28M32 28h8', palette.foreground, 0.55) +
    '</g>'
  );
}

/** Where the top of the frame sits for a block of `size` centred on cy. */
const blockTop = (cy, size) => cy - size / 2 + (12 * size) / 64;

function tick(x, y, palette, back = false) {
  const d = back ? -1 : 1;
  return line(`M${x - 4 * d} ${y - 5}L${x + 3 * d} ${y}L${x - 4 * d} ${y + 5}`, palette.accent, 2);
}

/** A stopped branch: a copper label, a dashed leader, a perpendicular cap with a dot. */
function stopped(label, lx, ly, capX, capY, palette, bendX = capX) {
  const w = measure(label, 16, mono);
  const sx = lx + w / 2;
  const bendY = Math.max(ly + 22, capY - 40);
  return (
    lettering(label, lx, ly, 16, palette.stop, mono) +
    line(
      `M${round(sx)} ${ly + 12}V${round(bendY)}L${round(bendX)} ${round(bendY + 18)}V${round(capY)}`,
      palette.stop,
      2,
      'stroke-dasharray="5 7"',
    ) +
    line(`M${round(capX - 9)} ${round(capY)}h18`, palette.stop, 3) +
    `<circle cx="${round(capX)}" cy="${round(capY)}" r="3" fill="${palette.stop}"/>`
  );
}

/** A step: block, leader, name and the detail line that says what it does. */
function step(x, y, size, name, detail, palette) {
  return (
    block(x, y, size, palette) +
    line(`M${x} ${y + size / 2 + 10}v16`, palette.line, 1) +
    centred(name, x, y + size / 2 + 50, 22, palette.foreground, display) +
    centred(detail, x, y + size / 2 + 74, 14, palette.secondary, mono)
  );
}

/*
 * The hero: the two paths the package owns, drawn in the banner's language.
 * Top, one job from add() to completed through the producer guard, the
 * dedupe, the queue's policy and a JobHost worker, with a retry going back
 * through the policy's jittered backoff. Bottom, one sweep declared on two
 * replicas: both upsert the same scheduler, and each tick runs once.
 */
function hero(palette) {
  const S = 72;
  const cap = (x) => x + (6 * S) / 64; // the middle of the frame's top bar
  let c = grid(palette, 1040, 680);

  // ONE JOB
  c += lettering('ONE JOB / ADD TO COMPLETED', 52, 46, 14, palette.secondary, mono, 1.2);
  const y = 238;
  const xs = [230, 410, 590, 800];
  c += `<path d="M64 ${y + 14}H986v12H64z" fill="${palette.raised}" stroke="${palette.line}"/>`;
  c += line(`M70 ${y}H980`, palette.accent, 3);
  for (const x of [118, 320, 500, 700, 900]) c += tick(x, y, palette);
  // A failed attempt goes back to the policy, which waits a jittered step.
  c += line(`M786 ${y - 40}C766 ${y - 100} 640 ${y - 100} 612 ${y - 40}`, palette.accent, 2);
  c += line(`M606 ${y - 51}L612 ${y - 40}L622 ${y - 49}`, palette.accent, 2);
  c += centred('retry, jittered', 698, y - 96, 14, palette.accent, mono);
  c += stopped('hung request', 92, 104, cap(xs[0]), blockTop(y, S), palette);
  c += stopped('duplicate job', 270, 134, cap(xs[1]), blockTop(y, S), palette);
  c += stopped('retry storm', 452, 104, cap(xs[2]), blockTop(y, S), palette);
  c += step(xs[0], y, S, 'producer', '3 s bound', palette);
  c += step(xs[1], y, S, 'dedupe', 'sha256 key', palette);
  c += step(xs[2], y, S, 'policy', 'expo, keep 14d', palette);
  c += step(xs[3], y, S, 'JobHost', 'final hook once', palette);
  c += `<circle cx="70" cy="${y}" r="7" fill="${palette.background}" stroke="${palette.accent}" stroke-width="3"/>`;
  c += `<circle cx="980" cy="${y}" r="9" fill="${palette.accent}"/>`;
  c += `<circle cx="980" cy="${y}" r="16" fill="none" stroke="${palette.line}"/>`;
  c += lettering('add()', 52, y + 44, 15, palette.foreground, mono);
  c += lettering(
    'completed',
    988 - measure('completed', 15, mono),
    y - 30,
    15,
    palette.foreground,
    mono,
  );

  // ONE SWEEP, TWO REPLICAS
  const top = 404;
  c += line(`M52 ${top}H988`, palette.line, 1, 'opacity=".7"');
  c += lettering('ONE SWEEP / TWO REPLICAS', 52, top + 42, 14, palette.secondary, mono, 1.2);
  const ry = [top + 106, top + 206];
  const sy = (ry[0] + ry[1]) / 2;
  const sx = 520;
  const wx = 790;
  ['replica a', 'replica b'].forEach((name, i) => {
    c += rectangle(64, ry[i] - 6, 12, 12, palette.accent);
    c += lettering(name, 92, ry[i] - 12, 16, palette.foreground, mono);
    c += lettering("@Sweep('expired-tokens')", 92, ry[i] + 16, 14, palette.secondary, mono);
    c += line(`M320 ${ry[i]}H380L${sx - 60} ${sy}`, palette.accent, 2);
  });
  c += lettering(
    'both upsert',
    436 - measure('both upsert', 13, mono),
    sy + 5,
    13,
    palette.secondary,
    mono,
  );
  c += `<path d="M${sx - 60} ${sy + 14}H986v12H${sx - 60}z" fill="${palette.raised}" stroke="${palette.line}"/>`;
  c += line(`M${sx - 60} ${sy}H980`, palette.accent, 3);
  for (const x of [sx - 46, 660, 900]) c += tick(x, sy, palette);
  c += stopped('run per replica', sx + 54, top + 38, cap(sx), blockTop(sy, S), palette);
  c += step(sx, sy, S, 'scheduler', 'one in Redis', palette);
  c += step(wx, sy, S, 'sweep', 'cron, tz UTC', palette);
  c += `<circle cx="980" cy="${sy}" r="9" fill="${palette.accent}"/>`;
  c += `<circle cx="980" cy="${sy}" r="16" fill="none" stroke="${palette.line}"/>`;
  c += lettering(
    'once per tick',
    988 - measure('once per tick', 15, mono),
    sy - 30,
    15,
    palette.foreground,
    mono,
  );
  return c;
}

const outputs = new Map();
const save = (name, source) => outputs.set(name, source);
const description =
  'A worker frame holds one job, the visible core, and the next job waits outside at the entrance.';
const tile =
  rectangle(0, 0, 64, 64, palettes.dark.background, 12) + mark(0, 0, 64, palettes.dark.accent);
save('icon.svg', document(64, 64, 'noctcore/jobs', description, tile));
save('favicon.svg', document(64, 64, 'noctcore/jobs', description, tile));
save(
  'icon-mono.svg',
  document(64, 64, 'noctcore/jobs', description, mark(0, 0, 64, 'currentColor')),
);

const heroDescription =
  "Top: one job from add() to completed. The producer bounds every enqueue to 3 s and refuses at once while Redis is down, so a request never hangs; the hashed dedupe key drops a repeat of the same job; the queue policy's jittered exponential backoff spaces retries, so a failed attempt goes back through it instead of retrying in a storm; a JobHost worker runs the job and calls its final-failure hook once. Bottom: one sweep declared on two replicas. Both upsert the same scheduler, Redis holds one, and each tick runs once rather than once per replica.";
for (const theme of ['dark', 'light']) {
  const palette = palettes[theme];
  const logo = document(372, 64, 'noctcore/jobs', description, lockup(0, 0, 1, palette));
  save(`logo-${theme}.svg`, logo);
  if (theme === 'light') save('logo.svg', logo);
  save(
    `hero-${theme}.svg`,
    document(1040, 680, 'One job, one sweep', heroDescription, hero(palette)),
  );
}

for (const [name, source] of outputs) writeFileSync(new URL(name, directory), source);
console.log(`Wrote ${outputs.size} outlined SVG sources.`);
