module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
    jest: true
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script'
  },
  extends: ['eslint:recommended'],
  ignorePatterns: [
    'archive/**',
    '.codex-temp/**',
    'node_modules/**',
    'skills/openclaw-napm-query/logs/**'
  ],
  rules: {
    'no-unused-vars': ['warn', {
      argsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_'
    }]
  }
};
