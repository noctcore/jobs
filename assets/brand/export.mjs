// Regenerate PNG files directly from the outlined vector artwork.
import console from 'node:console';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

import { Resvg } from '@resvg/resvg-js';

const directory = new URL('./', import.meta.url);
const check = process.argv.includes('--check');
const render = (source, width) =>
  new Resvg(source, {
    font: { loadSystemFonts: false },
    ...(width ? { fitTo: { mode: 'width', value: width } } : {}),
  })
    .render()
    .asPng();

for (const name of readdirSync(directory).filter((name) => name.endsWith('.svg'))) {
  const source = readFileSync(new URL(name, directory));
  if (/<(?:image|text|script|foreignObject)\b/i.test(source.toString())) {
    throw new Error(`${name}: use self contained, outlined SVG geometry`);
  }
  // resvg parses all SVG sources, including theme variants without a PNG export.
  new Resvg(source, { font: { loadSystemFonts: false } });
  if (name.startsWith('hero-') && source.length >= 150_000) {
    throw new Error(`${name} must be smaller than 150 KB`);
  }
}

const outputs = [
  ...[16, 32, 64, 180, 512].map((size) => ({
    source: 'icon.svg',
    output: `icon-${size}.png`,
    width: size,
    height: size,
  })),
  { source: 'social-preview.svg', output: 'social-preview.png', width: 1280, height: 640 },
];

for (const { source, output, width, height } of outputs) {
  const png = render(readFileSync(new URL(source, directory)), width);
  const actualWidth = png.readUInt32BE(16);
  const actualHeight = png.readUInt32BE(20);
  if (actualWidth !== width || actualHeight !== height) {
    throw new Error(`${output}: expected ${width}x${height}, got ${actualWidth}x${actualHeight}`);
  }
  if (output === 'social-preview.png' && png.length >= 1_000_000) {
    throw new Error('Social preview must be smaller than 1 MB');
  }
  if (check) {
    if (!readFileSync(new URL(output, directory)).equals(png)) {
      throw new Error(`${output}: stale export; run npm run export`);
    }
  } else {
    writeFileSync(new URL(output, directory), png);
  }
  console.log(
    `${output}: ${actualWidth}x${actualHeight}, ${png.length} bytes${check ? ' (verified)' : ''}`,
  );
}
console.log('Validated every SVG with resvg; both heroes are below 150 KB.');
