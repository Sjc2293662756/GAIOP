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
    const queryPolicy = ResolutionSpecService.getQueryConstructionPolicy();

    expect(serviceProfiles.topValues.requiredExecutionFields).toContain('start');
    expect(objectCatalog.WebApplication.hasArgument).toBe(true);
    expect(groupSpec.pathTemplates.defaultBranches.BusinessGroup).toBeTruthy();
    expect(metricSpec.catalog.TPIO.domain).toBe('network_usage');
    expect(Array.isArray(templateSpec.stableQueryTemplates)).toBe(true);
    expect(templateSpec.stableQueryTemplates.length).toBeGreaterThan(0);
    expect(timeSpec.supportedGranularities).toContain(3600);
    expect(runtimeContracts.mustValidateBeforeExecution.metricsForGroup).toBe(true);
    expect(queryPolicy.constructionOrder).toContain('template_binding');
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
