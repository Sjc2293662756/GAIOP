'use strict';

const {
  NapmObjectTargetResolver,
  TARGET_RESOLUTION_STATUS
} = require('../skills/shared/NapmObjectTargetResolver');

function createResolver(rowsByType) {
  return new NapmObjectTargetResolver({
    catalogProvider: async (groupTypes) => groupTypes.flatMap((groupType) =>
      (rowsByType[groupType] || []).map((row) => ({ ...row, __groupType: groupType })))
  });
}

describe('NapmObjectTargetResolver', () => {
  test.each([
    [
      '给我回溯238web的综述报告！',
      { type: 'global', label: '全局' },
      { groupType: 'WebApplication', groupArgument: '回溯238web' }
    ],
    [
      '给我HTTPS应用的综述报告！',
      { type: 'application', label: '应用' },
      { groupType: 'DefinedApp', groupArgument: 'HTTPS' }
    ]
  ])('resolves a named object from the authoritative catalog: %s', async (prompt, baseScope, expectedTarget) => {
    const resolver = createResolver({
      WebApplication: [{ name: '回溯238web', applicationType: 3 }],
      DefinedApp: [{ name: 'HTTPS', applicationType: 2 }]
    });

    const result = await resolver.resolveSummaryScope(prompt, baseScope);

    expect(result).toMatchObject({
      ok: true,
      status: TARGET_RESOLUTION_STATUS.RESOLVED,
      scope: { target: expectedTarget }
    });
  });

  test('uses the shared NapmMetadataService singleton on the default production path', async () => {
    const metadataService = require('../skills/openclaw-napm-query/services/NapmMetadataService');
    const listObjectInstances = jest.spyOn(metadataService, 'listObjectInstances')
      .mockImplementation(async (groupType) => (groupType === 'WebApplication'
        ? [{ name: '回溯238web', applicationType: 3 }]
        : []));

    try {
      const resolver = new NapmObjectTargetResolver();
      const result = await resolver.resolveSummaryScope(
        '给我回溯238web的综述报告！',
        { type: 'global', label: '全局' }
      );

      expect(result).toMatchObject({
        ok: true,
        status: TARGET_RESOLUTION_STATUS.RESOLVED,
        scope: {
          target: {
            groupType: 'WebApplication',
            groupArgument: '回溯238web'
          }
        }
      });
      expect(listObjectInstances).toHaveBeenCalledWith('WebApplication');
      expect(listObjectInstances).toHaveBeenCalledWith('DefinedApp');
    } finally {
      listObjectInstances.mockRestore();
    }
  });

  test('includes built-in applications that execute through the DefinedApp dimension', async () => {
    const metadataService = require('../skills/openclaw-napm-query/services/NapmMetadataService');
    const listObjectInstances = jest.spyOn(metadataService, 'listObjectInstances')
      .mockImplementation(async (groupType) => (groupType === 'BuiltinApplication'
        ? [{
          name: 'HTTPS',
          Type: 1,
          applicationType: 1,
          effectiveObjectType: 'BuiltinApplication',
          executionGroupType: 'DefinedApp'
        }]
        : []));

    try {
      const resolver = new NapmObjectTargetResolver();
      const result = await resolver.resolveSummaryScope(
        '给我HTTPS应用的综述报告！',
        { type: 'application', label: '应用' }
      );

      expect(result).toMatchObject({
        ok: true,
        status: TARGET_RESOLUTION_STATUS.RESOLVED,
        scope: {
          type: 'application',
          target: {
            groupType: 'DefinedApp',
            groupArgument: 'HTTPS'
          }
        }
      });
      expect(listObjectInstances).toHaveBeenCalledWith('BuiltinApplication');
    } finally {
      listObjectInstances.mockRestore();
    }
  });

  test.each([
    ['给我应用最近七天的综述报告！', { type: 'application', label: '应用' }],
    ['给我业务组最近七天的综述报告！', { type: 'businessGroup', label: '业务组' }],
    ['给我NAPM最近七天的综述报告！', { type: 'global', label: '全局' }]
  ])('keeps an explicit overview summary targetless: %s', async (prompt, scope) => {
    const provider = jest.fn();
    const resolver = new NapmObjectTargetResolver({ catalogProvider: provider });

    const result = await resolver.resolveSummaryScope(prompt, scope);

    expect(result).toEqual({
      ok: true,
      status: TARGET_RESOLUTION_STATUS.OVERALL,
      scope,
      targetHint: ''
    });
    expect(provider).not.toHaveBeenCalled();
  });

  test('fails closed when a named object is absent', async () => {
    const resolver = createResolver({ WebApplication: [], DefinedApp: [] });

    const result = await resolver.resolveSummaryScope(
      '给我不存在对象ABC的综述报告！',
      { type: 'global', label: '全局' }
    );

    expect(result).toMatchObject({
      ok: false,
      status: TARGET_RESOLUTION_STATUS.NOT_FOUND,
      targetHint: '不存在对象ABC'
    });
  });

  test('reports ambiguity for the same name in business and application catalogs', async () => {
    const resolver = createResolver({
      WebApplication: [{ name: '同名对象', applicationType: 3 }],
      DefinedApp: [{ name: '同名对象', applicationType: 2 }]
    });

    const result = await resolver.resolveSummaryScope(
      '给我同名对象的综述报告！',
      { type: 'global', label: '全局' }
    );

    expect(result).toMatchObject({
      ok: false,
      status: TARGET_RESOLUTION_STATUS.AMBIGUOUS,
      candidates: [
        expect.objectContaining({ groupArgument: '同名对象' }),
        expect.objectContaining({ groupArgument: '同名对象' })
      ]
    });
  });

  test('reports catalog unavailability instead of returning an overall scope', async () => {
    const resolver = new NapmObjectTargetResolver({
      catalogProvider: async () => { throw new Error('catalog unavailable'); }
    });

    const result = await resolver.resolveSummaryScope(
      '给我回溯238web的综述报告！',
      { type: 'global', label: '全局' }
    );

    expect(result).toMatchObject({
      ok: false,
      status: TARGET_RESOLUTION_STATUS.CATALOG_UNAVAILABLE,
      targetHint: '回溯238web'
    });
  });
});
