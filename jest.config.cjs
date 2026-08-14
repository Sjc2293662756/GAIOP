module.exports = {
  testEnvironment: 'node',
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
