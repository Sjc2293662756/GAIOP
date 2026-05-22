const path = require('path');

describe('napm-openclaw-plugin path preflight', () => {
  const originalExecutor = process.env.NAPM_SKILL_EXECUTOR;
  const originalBoundaryMode = process.env.NAPM_RESOLUTION_BOUNDARY_MODE;
  let plugin = null;

  beforeAll(() => {
    process.env.NAPM_SKILL_EXECUTOR = path.resolve(__dirname, '../skills/openclaw-napm-query/scripts/run_napm_query.js');
    jest.resetModules();
    plugin = require('../.codex-temp/napm-openclaw-plugin.remote.js');
  });

  afterAll(() => {
    if (originalExecutor === undefined) {
      delete process.env.NAPM_SKILL_EXECUTOR;
    } else {
      process.env.NAPM_SKILL_EXECUTOR = originalExecutor;
    }
    if (originalBoundaryMode === undefined) {
      delete process.env.NAPM_RESOLUTION_BOUNDARY_MODE;
    } else {
      process.env.NAPM_RESOLUTION_BOUNDARY_MODE = originalBoundaryMode;
    }
  });

  afterEach(() => {
    if (originalBoundaryMode === undefined) {
      delete process.env.NAPM_RESOLUTION_BOUNDARY_MODE;
    } else {
      process.env.NAPM_RESOLUTION_BOUNDARY_MODE = originalBoundaryMode;
    }
  });

  test('should not rewrite resolvedQuery through plugin path preflight', () => {
    const testApi = plugin.__test__;
    const original = {
      service: 'groups',
      groups: [{ type: 'BusinessGroup', argument: '\u670d\u52a1\u5668\u7f51\u6bb5' }],
      format: 'json'
    };
    const next = testApi.applyPathPreflightToResolvedQuery(
      original,
      '\u770b\u8fd9\u4e2a\u4e1a\u52a1\u7ec4\u4e0b\u9762\u7684\u5e94\u7528',
      null
    );

    expect(next.groups).toEqual([
      { type: 'BusinessGroup', argument: '\u670d\u52a1\u5668\u7f51\u6bb5' }
    ]);
    expect(next.pathPlanning).toBeUndefined();
  });

  test('should preserve explicit resolvedQuery during skill arg preparation', () => {
    const testApi = plugin.__test__;
    const next = testApi.prepareSkillExecutionArgs({
      prompt: '\u770b\u8fd9\u4e2a\u4e1a\u52a1\u7ec4\u4e0b\u9762\u7684\u5e94\u7528',
      userQuery: '\u770b\u8fd9\u4e2a\u4e1a\u52a1\u7ec4\u4e0b\u9762\u7684\u5e94\u7528',
      resolvedQuery: {
        service: 'groups',
        groups: [{ type: 'BusinessGroup', argument: '\u670d\u52a1\u5668\u7f51\u6bb5' }],
        format: 'json'
      }
    });

    expect(next.resolvedQuery.groups).toEqual([
      { type: 'BusinessGroup', argument: '\u670d\u52a1\u5668\u7f51\u6bb5' }
    ]);
    expect(next.resolvedQuery.pathPlanning).toBeUndefined();
  });

  test('should expose canonical skill tool params without plugin path rewrite', () => {
    const testApi = plugin.__test__;
    const next = testApi.buildCanonicalSkillToolParams('\u770b\u8fd9\u4e2a\u4e1a\u52a1\u7ec4\u4e0b\u9762\u7684\u5e94\u7528', {
      resolvedQuery: {
        service: 'groups',
        groups: [{ type: 'BusinessGroup', argument: '\u670d\u52a1\u5668\u7f51\u6bb5' }],
        format: 'json'
      }
    });

    expect(next.prompt).toBe('\u770b\u8fd9\u4e2a\u4e1a\u52a1\u7ec4\u4e0b\u9762\u7684\u5e94\u7528');
    expect(next.userQuery).toBe('\u770b\u8fd9\u4e2a\u4e1a\u52a1\u7ec4\u4e0b\u9762\u7684\u5e94\u7528');
    expect(next.resolvedQuery.pathPlanning).toBeUndefined();
    expect(next.resolvedQuery.groups).toEqual([
      { type: 'BusinessGroup', argument: '\u670d\u52a1\u5668\u7f51\u6bb5' }
    ]);
  });

  test('should still preserve explicit resolvedQuery in strict boundary mode', () => {
    process.env.NAPM_RESOLUTION_BOUNDARY_MODE = 'strict';
    jest.resetModules();
    plugin = require('../.codex-temp/napm-openclaw-plugin.remote.js');

    const testApi = plugin.__test__;
    const next = testApi.prepareSkillExecutionArgs({
      prompt: '\u770b\u8fd9\u4e2a\u4e1a\u52a1\u7ec4\u4e0b\u9762\u7684\u5e94\u7528',
      userQuery: '\u770b\u8fd9\u4e2a\u4e1a\u52a1\u7ec4\u4e0b\u9762\u7684\u5e94\u7528',
      resolvedQuery: {
        service: 'groups',
        groups: [{ type: 'BusinessGroup', argument: '\u670d\u52a1\u5668\u7f51\u6bb5' }],
        format: 'json'
      }
    });

    expect(testApi.getBoundaryMode()).toBe('strict');
    expect(next.resolvedQuery.groups).toEqual([
      { type: 'BusinessGroup', argument: '\u670d\u52a1\u5668\u7f51\u6bb5' }
    ]);
    expect(next.resolvedQuery.pathPlanning).toBeUndefined();
  });
});
