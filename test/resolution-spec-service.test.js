process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'test-password';

const ResolutionSpecService = require('../skills/openclaw-napm-query/services/ResolutionSpecService');
const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');

describe('ResolutionSpecService extended getters', () => {
  test('should expose new spec sections for OpenClaw query construction', () => {
    const serviceProfiles = ResolutionSpecService.getServiceProfiles();
    const objectCatalog = ResolutionSpecService.getObjectCatalog();
    const groupSpec = ResolutionSpecService.getGroupSpec();
    const metricSpec = ResolutionSpecService.getMetricSpec();
    const templateSpec = ResolutionSpecService.getTemplateSpec();
    const timeSpec = ResolutionSpecService.getTimeSpec();
    const runtimeContracts = ResolutionSpecService.getRuntimeMetadataContracts();
    const argumentPolicies = ResolutionSpecService.getQueryArgumentPolicies();
    const queryPolicy = ResolutionSpecService.getQueryConstructionPolicy();

    expect(serviceProfiles.topValues.requiredExecutionFields).toContain('start');
    const topValuesServiceSpec = ResolutionSpecService.getServiceSpec('topValues');
    const averageValuesServiceSpec = ResolutionSpecService.getServiceSpec('averageValues');
    const timeValuesServiceSpec = ResolutionSpecService.getServiceSpec('timeValues');
    expect(topValuesServiceSpec.required).toEqual(expect.arrayContaining(['start', 'end']));
    expect(topValuesServiceSpec.required).not.toContain('timeRange');
    expect(averageValuesServiceSpec.required).toEqual(expect.arrayContaining(['start', 'end']));
    expect(averageValuesServiceSpec.required).not.toContain('timeRange');
    expect(timeValuesServiceSpec.required).toEqual(expect.arrayContaining(['start', 'end']));
    expect(timeValuesServiceSpec.required).toContain('groups');
    expect(timeValuesServiceSpec.required).not.toContain('timeRange');
    expect(objectCatalog.WebApplication.hasArgument).toBe(true);
    expect(objectCatalog.CompositeApplication.runtimeKey).toBe('DefinedApp');
    expect(ResolutionSpecService.getObjectAliases().CompositeApplication).toEqual(expect.arrayContaining(['复合协议', '自动识别应用']));
    expect(groupSpec.pathTemplates.defaultBranches.BusinessGroup).toBeTruthy();
    expect(metricSpec.catalog.TPIO.domain).toBe('network_usage');
    expect(metricSpec.aliases.TPIO).toEqual(expect.arrayContaining(['流量趋势', '流量的趋势', '流量速率']));
    expect(metricSpec.aliases.BYTIO).toEqual(expect.arrayContaining(['流量', '累计流量', '流量大小']));
    expect(Array.isArray(templateSpec.stableQueryTemplates)).toBe(true);
    expect(templateSpec.stableQueryTemplates.length).toBeGreaterThan(0);
    expect(timeSpec.supportedGranularities).toContain(3600);
    expect(runtimeContracts.mustValidateBeforeExecution.metricsForGroup).toBe(true);
    expect(argumentPolicies.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'defined-app-single-value-argument-required',
        argumentPolicy: 'required'
      })
    ]));
    expect(queryPolicy.constructionOrder).toContain('template_binding');
  });
});

describe('ResolutionSpecService query argument policy', () => {
  test.each([
    [
      'requires DefinedApp argument for a single trend',
      {
        service: 'timeValues',
        queryModeKey: 'timeseries',
        groups: [{ type: 'DefinedApp' }]
      },
      { ok: false, code: 'GROUP_ARGUMENT_REQUIRED' }
    ],
    [
      'requires WebApplication argument for a single average',
      {
        service: 'averageValues',
        queryModeKey: 'average',
        groups: [{ type: 'WebApplication' }]
      },
      { ok: false, code: 'GROUP_ARGUMENT_REQUIRED' }
    ],
    [
      'allows DefinedApp argument for a ranking',
      {
        service: 'topValues',
        queryModeKey: 'topn',
        groups: [{ type: 'DefinedApp' }]
      },
      { ok: true, status: 'not_applicable' }
    ],
    [
      'forbids arguments on TotalTraffic',
      {
        service: 'timeValues',
        queryModeKey: 'timeseries',
        groups: [{ type: 'TotalTraffic', argument: 'HTTP' }]
      },
      { ok: false, code: 'GROUP_ARGUMENT_FORBIDDEN' }
    ],
    [
      'does not require an argument for a multi-object trend path',
      {
        service: 'timeValues',
        queryModeKey: 'timeseries',
        groups: [{ type: 'IPAddress' }, { type: 'DefinedApp' }]
      },
      { ok: true, status: 'not_applicable' }
    ]
  ])('%s', (_name, query, expected) => {
    const result = ResolutionSpecService.evaluateQueryArgumentPolicy(query);
    expect(result).toMatchObject(expected);
  });
});

describe('RequirementParserService stable templates source', () => {
  test('should honor stable template switch from resolution spec', () => {
    const templateSpec = ResolutionSpecService.getTemplateSpec();

    expect(Array.isArray(templateSpec.stableQueryTemplates)).toBe(true);
    expect(templateSpec.stableQueryTemplates.length).toBeGreaterThan(0);
    expect(templateSpec.stableQueryTemplates.some((item) => item?.id === 'webapp-http-500-count-topn-v1')).toBe(true);

    expect(Array.isArray(RequirementParserService.stableQueryTemplates)).toBe(true);
    expect(templateSpec.stableQueryTemplatesEnabledInSkillRuntime).toBe(false);
    expect(RequirementParserService.stableQueryTemplates).toEqual([]);
  });
});
