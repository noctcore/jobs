import { defineConfig } from 'tsup';

// Dual ESM and CommonJS output, each with its own declarations (.d.ts and
// .d.cts), because NestJS apps are usually CommonJS builds while ESM tools
// consume the package too.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
});
