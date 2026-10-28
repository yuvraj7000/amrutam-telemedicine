module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'security'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  env: {
    es2022: true,
    node: true,
    jest: true,
  },
  ignorePatterns: ['dist/', 'coverage/', 'node_modules/'],
  overrides: [
    {
      files: ['FRONTEND/**/*.{ts,tsx}'],
      parserOptions: {
        project: './FRONTEND/tsconfig.json',
        tsconfigRootDir: __dirname,
        sourceType: 'module',
      },
    },
    {
      files: ['**/*.js'],
      parserOptions: {
        project: null,
      },
      rules: {
        '@typescript-eslint/no-floating-promises': 'off',
        '@typescript-eslint/no-misused-promises': 'off',
      },
    },
  ],
  rules: {
    '@typescript-eslint/consistent-type-imports': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    'security/detect-unsafe-regex': 'warn',
    'security/detect-non-literal-regexp': 'warn',
    'security/detect-child-process': 'warn',
    'security/detect-non-literal-fs-filename': 'warn',
    'security/detect-object-injection': 'off',
  },
};
