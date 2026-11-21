// Lints the package sources, their tests and the repo scripts.
//
// - typescript-eslint's type-checked rules, so a promise nobody awaits (a job
//   that was never enqueued, a worker that was never closed) fails lint
//   instead of failing silently in production. Type information comes from
//   each package's tsconfig through `projectService`; never run this with
//   `--cache`, because the cache does not notice when an imported function's
//   type changes.
// - The noctcore plugins that fit a TypeScript library: code quality, async
//   safety, security, observability, contracts and monorepo boundaries.
// - Blank lines between logical steps (`@stylistic/padding-line-between-statements`)
//   so a function reads as a sequence of steps, not a wall of statements.
//   Formatting itself is Prettier's job (`bun run format`).
import js from '@eslint/js';
import asyncSafety from '@noctcore/eslint-plugin-async-safety';
import codeQuality from '@noctcore/eslint-plugin-code-quality';
import contracts from '@noctcore/eslint-plugin-contracts';
import monorepo from '@noctcore/eslint-plugin-monorepo';
import observability from '@noctcore/eslint-plugin-observability';
import security from '@noctcore/eslint-plugin-security';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

const TS = ['**/*.ts'];
const TESTS = ['**/tests/**/*.ts'];
const SCRIPTS = ['scripts/**/*.ts', '**/*.config.ts'];

// The statement kinds `padding-line-between-statements` treats as one step.
const DECLARATIONS = ['const', 'let', 'var'];
const MULTILINE = [
  'multiline-block-like',
  'multiline-expression',
  'multiline-const',
  'multiline-let',
  'multiline-var',
];

const padding = [
  // A return is the result of the steps above it, so it stands apart.
  { blankLine: 'always', prev: '*', next: 'return' },
  // Declarations are gathered first, then used.
  { blankLine: 'always', prev: DECLARATIONS, next: '*' },
  { blankLine: 'any', prev: DECLARATIONS, next: DECLARATIONS },
  // A guard is set apart from the work around it, but a run of one-line
  // guards reads as one checklist.
  { blankLine: 'always', prev: '*', next: 'if' },
  { blankLine: 'always', prev: 'if', next: '*' },
  { blankLine: 'any', prev: 'if', next: 'if' },
  // Anything spanning several lines is its own step.
  { blankLine: 'always', prev: '*', next: MULTILINE },
  { blankLine: 'always', prev: MULTILINE, next: '*' },
  { blankLine: 'always', prev: '*', next: ['block-like', 'try', 'for', 'while', 'switch'] },
  { blankLine: 'always', prev: ['block-like', 'try', 'for', 'while', 'switch'], next: '*' },
];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', 'site/**'],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: TS })),
  {
    files: TS,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@stylistic': stylistic },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always'],
      '@stylistic/padding-line-between-statements': ['error', ...padding],
    },
  },
  { ...codeQuality.configs.strict, files: TS },
  { ...asyncSafety.configs.recommended, files: TS },
  { ...security.configs.recommended, files: TS },
  { ...observability.configs.recommended, files: TS },
  { ...contracts.configs.recommended, files: TS },
  {
    ...monorepo.configs.recommended,
    files: TS,
    rules: {
      ...monorepo.configs.recommended.rules,
      'noctcore-monorepo/no-unexported-subpath-import': ['error', { scopes: ['@noctcore'] }],
    },
  },
  {
    // Library code never writes to the console: logging goes through Nest's
    // Logger, so the app decides where it lands.
    files: ['packages/*/src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    // The one module that reads the wall clock (see its header).
    files: ['packages/jobs/src/clock.ts'],
    rules: { 'noctcore-code-quality/no-bare-date-now': 'off' },
  },
  {
    // The graceful shutdown helper IS the shutdown path: after the app closed
    // it ends the process with the signal, or with exit code 1 when the close
    // failed, exactly as Nest's own shutdown hooks do. The exit is injectable
    // and the unit tests replace it.
    files: ['packages/jobs/src/shutdown.ts'],
    rules: { 'noctcore-code-quality/no-process-exit': 'off' },
  },
  {
    // Scripts and configs are the processes that own the environment, so they
    // read it directly.
    files: SCRIPTS,
    rules: { 'noctcore-contracts/no-direct-process-env': 'off' },
  },
  {
    // The integration suites read REDIS_URL from the environment the same way;
    // a test helper has no config module to go through.
    files: ['packages/*/tests/support/**/*.ts'],
    rules: { 'noctcore-contracts/no-direct-process-env': 'off' },
  },
  {
    // Command-line scripts print for a person reading a terminal, not for a
    // log pipeline, so a sentence with the value in it is the right output.
    files: ['scripts/**/*.ts'],
    rules: { 'noctcore-observability/structured-log-arguments': 'off' },
  },
  {
    files: TESTS,
    rules: {
      // Tests build hosts and fakes inline and hand them across as doubles.
      '@typescript-eslint/unbound-method': 'off',
      // Fakes implement Promise-returning contracts without doing any I/O.
      '@typescript-eslint/require-await': 'off',
      // Casts pin the exact shapes a case exercises.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
  {
    // Integration suites talk to a real Redis by design.
    files: ['**/*.int.test.ts', 'packages/*/tests/support/**/*.ts'],
    rules: {
      'noctcore-code-quality/no-real-network-in-unit-tests': 'off',
    },
  },
);
