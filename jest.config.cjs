module.exports = {
  testEnvironment: 'node',
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
