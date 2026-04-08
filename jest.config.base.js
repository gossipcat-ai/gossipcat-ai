// Gemini-dependent e2e suites are opt-in: they make real API calls and were
// silently failing on master because the keychain held an invalid key.
// Set RUN_GEMINI_E2E=1 with a known-good key to run them locally.
const GEMINI_E2E_SUITES = [
  'tests/e2e/conversation-flows\\.test\\.ts$',
  'tests/e2e/quick-smoke\\.test\\.ts$',
  'tests/e2e/regression-flows\\.test\\.ts$',
  'tests/orchestrator/full-stack-e2e\\.test\\.ts$',
  'tests/orchestrator/project-init-e2e\\.test\\.ts$',
  'tests/orchestrator/cognitive-e2e\\.test\\.ts$',
  'tests/orchestrator/interactive-session-e2e\\.test\\.ts$',
];

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    ...(process.env.RUN_GEMINI_E2E === '1' ? [] : GEMINI_E2E_SUITES),
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }]
  },
  moduleNameMapper: {
    '^@gossip/types$': '<rootDir>/packages/types/src',
    '^@gossip/types/(.*)$': '<rootDir>/packages/types/src/$1',
    '^@gossip/relay$': '<rootDir>/packages/relay/src',
    '^@gossip/relay/(.*)$': '<rootDir>/packages/relay/src/$1',
    '^@gossip/client$': '<rootDir>/packages/client/src',
    '^@gossip/client/(.*)$': '<rootDir>/packages/client/src/$1',
    '^@gossip/tools$': '<rootDir>/packages/tools/src',
    '^@gossip/tools/(.*)$': '<rootDir>/packages/tools/src/$1',
    '^@gossip/orchestrator$': '<rootDir>/packages/orchestrator/src',
    '^@gossip/orchestrator/(.*)$': '<rootDir>/packages/orchestrator/src/$1'
  }
};
