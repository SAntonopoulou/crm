import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'var/**', 'scripts/**', 'db/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The codebase is intentionally explicit about unused args in ports.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Clock doctrine: bare `new Date()` in src is a bug — inject Clock (or
    // use systemClock for row timestamps). clock.ts is the one legal home.
    files: ['src/**/*.ts'],
    ignores: ['src/shared/jobs/clock.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'Bare new Date() breaks time-controlled tests. Inject Clock, or use systemClock for row timestamps.',
        },
      ],
    },
  },
  {
    // Module boundaries: only AppModule composes the worker runtime, and the
    // message-provider seam stays inside comms (the pre-send gate is the
    // only send path).
    files: ['src/modules/**/*.ts'],
    ignores: ['src/modules/worker/**', 'src/modules/comms/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/worker/worker.module', '**/modules/worker/**'],
              message: 'Only AppModule wires the worker runtime.',
            },
            {
              group: ['**/comms/comms.service'],
              importNames: ['MessageProviderRegistry'],
              message:
                'Message providers are reachable only through the comms compliance gate.',
            },
          ],
        },
      ],
    },
  },
);
