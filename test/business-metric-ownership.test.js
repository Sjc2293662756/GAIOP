process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'test-password';

const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
const QueryMetadataConstraintService = require('../skills/openclaw-napm-query/services/QueryMetadataConstraintService');
const DimensionMappingService = require('../skills/openclaw-napm-query/services/DimensionMappingService');
const {
  getDefaultMetricCandidatesForObjectType,
  rankMetricIdsForObjectType
} = require('../skills/openclaw-napm-query/src/constants/objectMetricOwnership');
const {
  getDomainMeta,
  getObjectsForDomain,
  isMetricCompatibleWithObjectType
} = require('../skills/openclaw-napm-query/src/constants/metricDomains');

describe('business metric ownership guardrails', () => {
  test('should filter WebApplication metric inventory to PG and optimization metrics', () => {
    const filtered = RequirementParserService.filterMetricInventoryForOwnership(
      [{ type: 'WebApplication' }],
      [
        { id: 'PGNPGE', label: 'Page Visits' },
        { id: 'PGHTTP500', label: 'HTTP 500 Count' },
        { id: 'PGTME', label: 'Page Delay' },
        { id: 'POPT', label: 'Page Optimization' },
        { id: 'TPIO', label: 'Throughput Total' },
        { id: 'BYTIO', label: 'Traffic Total' },
        { id: 'PLI', label: 'Packet Loss In' },
        { id: 'RTTI', label: 'RTT In' },
        { id: 'CONI', label: 'Connection Requests In' }
      ]
    );

    expect(filtered.map((item) => item.id)).toEqual([
      'PGNPGE',
      'PGHTTP500',
      'PGTME',
      'POPT'
    ]);
  });

  test('should filter ClientBusinessGroup metric inventory to business-owned metrics', () => {
    const filtered = RequirementParserService.filterMetricInventoryForOwnership(
      [{ type: 'ClientBusinessGroup' }],
      [
        { id: 'PGNPGE', label: 'Page Visits' },
        { id: 'PGHTTP400', label: 'HTTP 400 Count' },
        { id: 'PFOPT', label: 'Fully Optimized Page Ratio' },
        { id: 'TPIO', label: 'Throughput Total' },
        { id: 'PLI', label: 'Packet Loss In' },
        { id: 'TRTI', label: 'Server Response Time' },
        { id: 'UEII', label: 'User Experience In' }
      ]
    );

    expect(filtered.map((item) => item.id)).toEqual([
      'PGNPGE',
      'PGHTTP400',
      'PFOPT'
    ]);
  });

  test('should return empty inventory instead of leaking non-business metrics for business objects', () => {
    const filtered = RequirementParserService.filterMetricInventoryForOwnership(
      [{ type: 'WebApplication' }],
      [
        { id: 'TPIO', label: 'Throughput Total' },
        { id: 'PLI', label: 'Packet Loss In' },
        { id: 'RTTI', label: 'RTT In' }
      ]
    );

    expect(filtered).toEqual([]);
  });

  test('should filter BusinessGroup metric inventory to non-business owned metrics', () => {
    const filtered = RequirementParserService.filterMetricInventoryForOwnership(
      [{ type: 'BusinessGroup' }],
      [
        { id: 'TPIO', label: 'Throughput Total' },
        { id: 'PLI', label: 'Packet Loss In' },
        { id: 'RTTI', label: 'RTT In' },
        { id: 'CONI', label: 'Connection Requests In' },
        { id: 'PGNPGE', label: 'Page Visits' },
        { id: 'PGHTTP500', label: 'HTTP 500 Count' }
      ]
    );

    expect(filtered.map((item) => item.id)).toEqual([
      'TPIO',
      'PLI',
      'RTTI',
      'CONI'
    ]);
  });

  test('should not prefer WebApplication for generic throughput metric compatibility', () => {
    expect(DimensionMappingService.getPreferredObjectsForMetric('TPIO')).not.toContain('WebApplication');
    expect(DimensionMappingService.getObjectsForMetric('TPIO', { onlySupportedByCurrentSkill: true })).not.toContain('WebApplication');
  });

  test('should not keep business objects in non-business compatibility domains', () => {
    expect(DimensionMappingService.getPreferredObjectsForMetric('TRTI')).not.toContain('ClientBusinessGroup');
    expect(DimensionMappingService.getObjectsForMetric('TRTI', { onlySupportedByCurrentSkill: true })).not.toContain('ClientBusinessGroup');
    expect(DimensionMappingService.getObjectsForMetric('UEII', { onlySupportedByCurrentSkill: true })).not.toContain('WebApplication');
    expect(DimensionMappingService.getObjectsForMetric('UEII', { onlySupportedByCurrentSkill: true })).not.toContain('ClientBusinessGroup');
  });

  test('should preserve incompatible WebApplication throughput query without metadata repair', () => {
    const result = QueryMetadataConstraintService.constrain({
      service: 'averageValues',
      metric: 'TPIO',
      metrics: ['TPIO'],
      groups: [{ type: 'WebApplication' }],
      userRequirement: '业务吞吐量是多少'
    }, '业务吞吐量是多少');

    expect(result.query.groups[0].type).toBe('WebApplication');
    expect(result.compatibility.isCompatible).toBe(false);
  });

  test('should correct incompatible WebApplication throughput query only with metadata repair', () => {
    const result = QueryMetadataConstraintService.constrain({
      service: 'averageValues',
      metric: 'TPIO',
      metrics: ['TPIO'],
      groups: [{ type: 'WebApplication' }],
      executionOptions: {
        allowMetadataRepair: true
      },
      userRequirement: 'web throughput'
    }, 'web throughput');

    expect(result.query.groups[0].type).not.toBe('WebApplication');
    expect(result.compatibility.isCompatible).toBe(true);
  });

  test('should preserve incompatible ClientBusinessGroup packet-loss query without metadata repair', () => {
    const result = QueryMetadataConstraintService.constrain({
      service: 'averageValues',
      metric: 'PLI',
      metrics: ['PLI'],
      groups: [{ type: 'ClientBusinessGroup' }],
      userRequirement: '发起组丢包率是多少'
    }, '发起组丢包率是多少');

    expect(result.query.groups[0].type).toBe('ClientBusinessGroup');
    expect(result.compatibility.isCompatible).toBe(false);
  });

  test('should expose business-owned default metric candidates for WebApplication first', () => {
    expect(getDefaultMetricCandidatesForObjectType('WebApplication').slice(0, 5)).toEqual([
      'PGNPGE',
      'PGRT',
      'PGTME',
      'PGNSLPGE',
      'PGSLPCT'
    ]);
  });

  test('should expose non-business default metric candidates for BusinessGroup first', () => {
    expect(getDefaultMetricCandidatesForObjectType('BusinessGroup').slice(0, 6)).toEqual([
      'TPIO',
      'BYTIO',
      'PKIO',
      'PLI',
      'RTTI',
      'CONI'
    ]);
  });

  test('should rank BusinessGroup metric candidates away from web metrics', () => {
    expect(rankMetricIdsForObjectType('BusinessGroup', [
      'PGHTTP500',
      'TPIO',
      'CONI',
      'PGNPGE',
      'PLI'
    ])).toEqual([
      'TPIO',
      'PLI',
      'CONI'
    ]);
  });

  test('should rank WebApplication metric candidates away from network metrics', () => {
    expect(rankMetricIdsForObjectType('WebApplication', [
      'TPIO',
      'PGHTTP500',
      'PGNPGE',
      'RTTI',
      'POPT'
    ])).toEqual([
      'PGNPGE',
      'PGHTTP500',
      'POPT'
    ]);
  });

  test('should prefer ownership-compatible fallback metrics for BusinessGroup metadata review', () => {
    const ranked = RequirementParserService.buildMetricCandidatesFromMetadataReview({
      metricsForGroup: [
        { id: 'PGHTTP500' },
        { id: 'PGNPGE' },
        { id: 'TPIO' },
        { id: 'PLI' },
        { id: 'CONI' }
      ]
    }, {
      groups: [{ type: 'BusinessGroup' }]
    });

    expect(ranked.slice(0, 3)).toEqual(['TPIO', 'PLI', 'CONI']);
    expect(ranked).not.toContain('PGHTTP500');
    expect(ranked).not.toContain('PGNPGE');
  });

  test('should suppress ownership-incompatible embedded BusinessGroup HTTP fallback template', () => {
    expect(
      RequirementParserService.buildEmbeddedTopnTemplate('businessgroup-http-500-count-topn-v1')
    ).toBeNull();
  });

  test('should normalize stable template metrics to ownership-compatible order', () => {
    const normalized = RequirementParserService.normalizeStableTemplateDefinition({
      id: 'businessgroup-custom-template',
      metricDomain: 'ApplicationPerformance',
      bindings: {
        groupPath: ['BusinessGroup'],
        primaryMetrics: ['PGHTTP500', 'TRTI'],
        auxMetrics: ['TPIO', 'PLI']
      }
    });

    expect(normalized.metricDomainToken).toBe('application');
    expect(normalized.bindings.metric).toBe('TPIO');
    expect(normalized.bindings.metrics).toEqual(['TPIO', 'PLI', 'TRTI']);
    expect(normalized.bindings.primaryMetrics).toEqual(['TRTI']);
    expect(normalized.bindings.auxMetrics).toEqual(['TPIO', 'PLI']);
  });

  test('should drop ownership-incompatible stable template completely', () => {
    const normalized = RequirementParserService.normalizeStableTemplateDefinition({
      id: 'businessgroup-http-only-template',
      metricDomain: 'ApplicationPerformance',
      bindings: {
        groupPath: ['BusinessGroup'],
        metric: 'PGHTTP500',
        metrics: ['PGHTTP500']
      }
    });

    expect(normalized).toBeNull();
  });

  test('should normalize runtime stable template shape during query normalization', () => {
    const request = RequirementParserService.normalizeTopLevelQueryShape({
      service: 'topValues',
      metric: 'TPIO',
      metrics: ['TPIO'],
      groups: [{ type: 'BusinessGroup' }],
      stableTemplate: {
        id: 'runtime-template',
        metricDomain: 'TrafficVolume',
        inferredArguments: {
          Application: 'HTTP'
        },
        allowedGroupPaths: [
          ['BusinessGroup']
        ],
        bindings: {
          groupPath: ['BusinessGroup'],
          metric: 'TPIO',
          metrics: ['TPIO'],
          allowedGroupPaths: [
            ['BusinessGroup']
          ]
        }
      }
    });

    expect(request.stableTemplate.metricDomainToken).toBe('traffic');
    expect(request.stableTemplate.inferredArguments).toEqual({
      Application: 'HTTP',
      DefinedApp: 'HTTP'
    });
    expect(request.stableTemplate.allowedGroupPaths).toEqual([
      ['BusinessGroup']
    ]);
    expect(request.stableTemplate.bindings.groupPath).toEqual(['BusinessGroup']);
    expect(request.stableTemplate.bindings.allowedGroupPaths).toEqual([
      ['BusinessGroup']
    ]);
  });

  test('should expose consistent metric domain metadata for TPIO', () => {
    const domainId = DimensionMappingService.getMetricDomain('TPIO');
    const domainMeta = getDomainMeta(domainId);

    expect(domainId).toBe('network_usage');
    expect(domainMeta?.label).toBe('Network Usage');
    expect(getObjectsForDomain(domainId)).toEqual(
      expect.arrayContaining(['BusinessGroup', 'IPAddress', 'DefinedApp'])
    );
  });

  test('should keep ownership-aware metric compatibility for business objects', () => {
    expect(isMetricCompatibleWithObjectType('PGNPGE', 'WebApplication')).toBe(true);
    expect(isMetricCompatibleWithObjectType('TPIO', 'WebApplication')).toBe(false);
    expect(isMetricCompatibleWithObjectType('PGHTTP500', 'BusinessGroup')).toBe(false);
    expect(isMetricCompatibleWithObjectType('TPIO', 'BusinessGroup')).toBe(true);
  });

  test('should keep preferred objects aligned with compatibility filtering', () => {
    expect(DimensionMappingService.getPreferredObjectsForMetric('PGNPGE')).toEqual(
      expect.arrayContaining(['WebApplication', 'PageFamily', 'User', 'ClientBusinessGroup'])
    );
    expect(DimensionMappingService.getPreferredObjectsForMetric('PGNPGE')).not.toContain('BusinessGroup');
    expect(DimensionMappingService.getPreferredObjectsForMetric('TRTI')).not.toContain('ClientBusinessGroup');
  });
});
