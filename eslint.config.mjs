// ESLint flat config. Deliberately small: typescript + React hooks + Next's own rules.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import next from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['.next/**', 'node_modules/**', 'storage/**', '.test-storage/**', 'db/**', '**/*.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { '@next/next': next, 'react-hooks': reactHooks },
    rules: {
      ...next.configs['core-web-vitals'].rules,
      // The classic two hook rules only. The newer React-Compiler rules (set-state-in-effect, error-boundaries,
      // refs, component-during-render) flag established patterns in this codebase, e.g. the autosave refs.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Underscore-prefixed arguments are intentionally unused.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // The codebase uses `any` at a few DB boundaries on purpose; keep it visible but not fatal.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Two rules strip control characters from user input on purpose; that is not a mistake.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: { 'no-console': ['warn', { allow: ['warn', 'error', 'log'] }] },
  },
];
