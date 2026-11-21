/**
 * Guards the public API of every published package against accidental change.
 *
 * A refactor that moves files around must not change what consumers can
 * import. This reads what consumers actually get, the built `dist/` output,
 * and writes one report per package entry point: every runtime export name
 * (from the ESM and the CommonJS build) and, from the emitted declarations,
 * every exported symbol with its kind and its full type (the members of
 * interfaces and classes, the shape behind type aliases). The report does not
 * depend on how the source or the declaration chunks are laid out.
 *
 *   bun scripts/api-snapshot.ts           writes api/<package>.<entry>.api.txt
 *   bun scripts/api-snapshot.ts --check   fails if a report differs from the committed one
 *
 * Run it after `bun run build`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(ROOT, 'api');
const check = process.argv.includes('--check');
const require = createRequire(import.meta.url);

interface Entry {
  readonly pkg: string;
  readonly name: string;
  readonly base: string;
}

const ENTRIES: readonly Entry[] = [
  { pkg: 'jobs', name: 'index', base: 'packages/jobs/dist/index' },
];

const FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseFullyQualifiedType |
  ts.TypeFormatFlags.WriteArrayAsGenericType;

function kindOf(symbol: ts.Symbol): string {
  const f = symbol.flags;

  if (f & ts.SymbolFlags.Class) return 'class';
  if (f & ts.SymbolFlags.Interface) return 'interface';
  if (f & ts.SymbolFlags.TypeAlias) return 'type';
  if (f & ts.SymbolFlags.Enum) return 'enum';
  if (f & ts.SymbolFlags.Function) return 'function';
  if (f & ts.SymbolFlags.Variable) return 'const';

  return `flags:${f}`;
}

function typeParams(checker: ts.TypeChecker, symbol: ts.Symbol): string {
  const decl = symbol.declarations?.[0];

  const params =
    decl &&
    (ts.isInterfaceDeclaration(decl) ||
      ts.isTypeAliasDeclaration(decl) ||
      ts.isClassDeclaration(decl))
      ? decl.typeParameters
      : undefined;

  if (!params) return '';

  const printed = params.map((p) => {
    const constraint = p.constraint ? ` extends ${p.constraint.getText()}` : '';
    const fallback = p.default ? ` = ${p.default.getText()}` : '';

    return `${p.name.text}${constraint}${fallback}`;
  });

  return `<${printed.join(', ')}>`;
}

function members(checker: ts.TypeChecker, type: ts.Type, at: ts.Node): string[] {
  const lines = checker.getPropertiesOfType(type).map((prop) => {
    // The member as declared (modifiers included), so a type is printed by the
    // name the author wrote: the checker would print the short alias a
    // declaration chunk exports it under, which changes from build to build.
    const declaration = prop.declarations?.[0];

    if (
      declaration &&
      (ts.isPropertySignature(declaration) ||
        ts.isMethodSignature(declaration) ||
        ts.isPropertyDeclaration(declaration) ||
        ts.isMethodDeclaration(declaration))
    ) {
      return `    ${declaration.getText().replace(/\s+/gu, ' ').replace(/;$/u, '')}`;
    }

    const optional = prop.flags & ts.SymbolFlags.Optional ? '?' : '';
    const propType = checker.typeToString(checker.getTypeOfSymbolAtLocation(prop, at), at, FLAGS);

    return `    ${prop.name}${optional}: ${propType}`;
  });

  const calls = type
    .getCallSignatures()
    .map((s) => `    (call) ${checker.signatureToString(s, at, FLAGS)}`);

  return [...lines.sort(), ...calls];
}

function describe(checker: ts.TypeChecker, exported: ts.Symbol, file: ts.SourceFile): string[] {
  const symbol =
    exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;

  // Types print as seen from the file that declares the symbol, where every
  // name is the declared one. Seen from the entry file, a type that lives in a
  // shared declaration chunk would print under the chunk's minified export
  // name (`z` for PasswordPolicy).
  const home = symbol.declarations?.[0]?.getSourceFile() ?? file;
  const kind = kindOf(symbol);
  const head = `${exported.name} [${kind}]${typeParams(checker, symbol)}`;

  if (kind === 'interface') {
    return [head, ...members(checker, checker.getDeclaredTypeOfSymbol(symbol), home)];
  }

  if (kind === 'type') {
    const decl = symbol.declarations?.[0];
    const text = decl && ts.isTypeAliasDeclaration(decl) ? decl.type.getText() : '';

    return [`${head} = ${text.replace(/\s+/gu, ' ')}`];
  }

  if (kind === 'class') {
    const instance = members(checker, checker.getDeclaredTypeOfSymbol(symbol), home);
    const ctorType = checker.getTypeOfSymbolAtLocation(symbol, home);

    const ctors = ctorType
      .getConstructSignatures()
      .map((s) => `    (new) ${checker.signatureToString(s, home, FLAGS)}`);

    const statics = members(checker, ctorType, home)
      .filter((l) => !l.trimStart().startsWith('prototype:'))
      .map((l) => `    static ${l.trimStart()}`);

    return [head, ...ctors, ...instance, ...statics];
  }

  return [
    `${head}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, home), home, FLAGS)}`,
  ];
}

// The same environment the packages compile against (tsconfig.base.json), so
// the report depends on the declarations only, not on what happens to be
// installed at the repo root.
const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  types: ['node'],
  typeRoots: [join(ROOT, 'packages/jobs/node_modules/@types')],
};

/**
 * Named types an export reaches without exporting them (a parameter object, an
 * option bag): every type reference in the declarations, followed until no new
 * one turns up. Only the package's own declarations count, not the standard
 * library or a dependency.
 */
function reachedTypes(checker: ts.TypeChecker, roots: readonly ts.Symbol[]): ts.Symbol[] {
  const seen = new Set<ts.Symbol>(roots);
  const found: ts.Symbol[] = [];
  const queue = [...roots];

  const visit = (node: ts.Node): void => {
    const name = ts.isTypeReferenceNode(node)
      ? node.typeName
      : ts.isExpressionWithTypeArguments(node)
        ? node.expression
        : ts.isTypeQueryNode(node)
          ? node.exprName
          : undefined;

    const referenced = name ? checker.getSymbolAtLocation(name) : undefined;

    if (referenced) {
      const target =
        referenced.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(referenced) : referenced;

      const named =
        (target.flags &
          (ts.SymbolFlags.Interface |
            ts.SymbolFlags.TypeAlias |
            ts.SymbolFlags.Class |
            ts.SymbolFlags.Enum)) !==
        0;

      const own =
        named && target.declarations?.some((d) => d.getSourceFile().fileName.includes('/dist/'));

      if (own && !seen.has(target)) {
        seen.add(target);
        found.push(target);
        queue.push(target);
      }
    }

    ts.forEachChild(node, visit);
  };

  while (queue.length > 0) {
    const next = queue.shift();

    const symbol =
      next && next.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(next) : next;

    for (const declaration of symbol?.declarations ?? []) visit(declaration);
  }

  return found;
}

function declarationReport(path: string): string[] {
  const program = ts.createProgram([path], COMPILER_OPTIONS);
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(path);

  if (!file) throw new Error(`cannot read ${path}`);

  const moduleSymbol = checker.getSymbolAtLocation(file);
  const exports = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];

  const exportedTargets = exports.map((s) =>
    s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s,
  );

  const reached = reachedTypes(checker, exportedTargets);

  const print = (symbols: readonly ts.Symbol[]): string[] =>
    symbols
      .map((s) => describe(checker, s, file).join('\n'))
      .sort((a, b) => a.localeCompare(b, 'en'))
      // Declaration chunks are named after a content hash; their names are not API.
      .map((s) => s.replace(/import\("[^"]*"\)\./gu, ''));

  return [
    ...print(exports),
    '',
    '## types reached through the exports (not exported by name)',
    ...print(reached),
  ];
}

async function runtimeNames(base: string): Promise<{ esm: string[]; cjs: string[] }> {
  const esmModule = (await import(pathToFileURL(join(ROOT, `${base}.js`)).href)) as object;
  const esm = Object.keys(esmModule).sort();

  const cjs = Object.keys(require(join(ROOT, `${base}.cjs`)) as object)
    .filter((k) => k !== '__esModule')
    .sort();

  return { esm, cjs };
}

let drift = false;

mkdirSync(OUT, { recursive: true });

for (const entry of ENTRIES) {
  const { esm, cjs } = await runtimeNames(entry.base);
  const dts = declarationReport(join(ROOT, `${entry.base}.d.ts`));
  const dcts = declarationReport(join(ROOT, `${entry.base}.d.cts`));

  if (dts.join('\n') !== dcts.join('\n')) {
    console.error(`${entry.pkg}/${entry.name}: .d.ts and .d.cts declare different APIs`);
    drift = true;
  }

  if (esm.join() !== cjs.join()) {
    console.error(`${entry.pkg}/${entry.name}: ESM and CommonJS export different names`);
    drift = true;
  }

  const manifest = JSON.parse(
    readFileSync(join(ROOT, `packages/${entry.pkg}/package.json`), 'utf8'),
  ) as {
    exports: unknown;
  };

  const exportsMap =
    entry.name === 'index'
      ? ['## package.json exports', JSON.stringify(manifest.exports, null, 2), '']
      : [];

  const report = [
    `# @noctcore/${entry.pkg} ${entry.name === 'index' ? '(root)' : `/${entry.name}`}`,
    '',
    ...exportsMap,
    '## runtime exports',
    ...esm,
    '',
    '## declarations',
    ...dts,
    '',
  ].join('\n');

  const file = join(OUT, `${entry.pkg}.${entry.name}.api.txt`);

  if (!check) {
    writeFileSync(file, report);
    continue;
  }

  const committed = existsSync(file) ? readFileSync(file, 'utf8') : '';

  if (committed !== report) {
    console.error(
      `${entry.pkg}/${entry.name}: public API differs from ${file}; run bun scripts/api-snapshot.ts and review the diff`,
    );

    drift = true;
  }
}

if (drift) process.exit(1);
