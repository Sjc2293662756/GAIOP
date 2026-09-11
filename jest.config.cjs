module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/setup-verified-product-baseline.js'],
  testTimeout: 30000,
  testPathIgnorePatterns: [
    '/node_modules/',
    '/archive/',
    '/.codex-temp/'
  ],
  modulePathIgnorePatterns: [
    '<rootDir>/archive/',
    '<rootDir>/.codex-temp/'
  ]
};
