module.exports = {
  testEnvironment: 'node',
  testTimeout: 15000,
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
