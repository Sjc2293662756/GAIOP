process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'test-password';

jest.mock('../skills/openclaw-napm-query/services/NapmClient', () => {
  return jest.fn().mockImplementation(() => ({
    username: process.env.NETINSIDE_USERNAME,
    password: process.env.NETINSIDE_PASSWORD,
    baseUrl: process.env.NETINSIDE_HOST,
    get: jest.fn().mockResolvedValue('[]'),
    getJson: jest.fn().mockResolvedValue([])
  }));
});

const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
const NapmMetadataService = require('../skills/openclaw-napm-query/services/NapmMetadataService');
const QueryMetadataConstraintService = require('../skills/openclaw-napm-query/services/QueryMetadataConstraintService');
const MetadataTruthSourcePolicy = require('../skills/openclaw-napm-query/services/MetadataTruthSourcePolicy');
const ObjectMetadataRegistry = require('../skills/openclaw-napm-query/services/ObjectMetadataRegistry');

describe('metadata truth source policy', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    NapmMetadataService.clearCache();
  });

  test('should list WebApplication instances through applications Type=3 catalog', async () => {
    const applicationsSpy = jest.spyOn(NapmMetadataService, 'getApplications')
      .mockResolvedValue([
        { value: 'HTTP', label: 'HTTP', applicationType: 1 },
        { value: 'server-app', label: 'server-app', applicationType: 2 },
        { value: 'web-portal', label: 'web-portal', applicationType: 3 },
        { value: 'auto-app', label: 'auto-app', applicationType: 4 }
      ]);
    const groupArgumentsSpy = jest.spyOn(NapmMetadataService, 'getGroupArguments')
      .mockResolvedValue([{ value: 'web-portal', label: 'web-portal' }]);

    const result = await NapmMetadataService.listObjectInstances('WebApplication');

    expect(applicationsSpy).toHaveBeenCalledWith('');
    expect(groupArgumentsSpy).not.toHaveBeenCalled();
    expect(result).toEqual([
      expect.objectContaining({
        value: 'web-portal',
        type: 'WebApplication',
        objectType: 'WebApplication',
        requestedObjectType: 'WebApplication',
        effectiveObjectType: 'WebApplication',
        metadataTruthDomain: 'object_instances',
        providerType: 'applications',
        source: 'southbound_live_api',
        applicationType: 3,
        applicationTypeFilter: [3],
        applicationCatalogRole: 'web_business',
        executionGroupType: 'WebApplication'
      })
    ]);
  });

  test('should expose explicit truth-source boundaries and object provider registry', () => {
    expect(MetadataTruthSourcePolicy.getAllowedSources(
      MetadataTruthSourcePolicy.TRUTH_DOMAINS.OBJECT_INSTANCES
    )).toEqual(['southbound_live_api']);
    expect(() => MetadataTruthSourcePolicy.assertSourceAllowed(
      MetadataTruthSourcePolicy.TRUTH_DOMAINS.OBJECT_INSTANCES,
      MetadataTruthSourcePolicy.SOURCES.STATIC_GROUPS_TREE
    )).toThrow('not allowed');

    expect(ObjectMetadataRegistry.resolveObjectInstanceProvider('WebApplication')).toMatchObject({
      requestedObjectType: 'WebApplication',
      effectiveObjectType: 'WebApplication',
      executionGroupType: 'WebApplication',
      metadataTruthDomain: 'object_instances',
      providerType: 'applications',
      apiType: 'applications',
      applicationTypeFilter: [3],
      source: 'southbound_live_api'
    });
    expect(ObjectMetadataRegistry.resolveObjectInstanceProvider('DefinedApp')).toMatchObject({
      requestedObjectType: 'DefinedApp',
      effectiveObjectType: 'DefinedApp',
      providerType: 'applications',
      apiType: 'applications',
      applicationTypeFilter: [2]
    });
    expect(ObjectMetadataRegistry.resolveObjectInstanceProvider('CompositeApplication')).toMatchObject({
      requestedObjectType: 'CompositeApplication',
      effectiveObjectType: 'CompositeApplication',
      executionGroupType: 'DefinedApp',
      providerType: 'applications',
      apiType: 'applications',
      applicationTypeFilter: [4]
    });
  });

  test('should list DefinedApp instances through applications Type=2 only', async () => {
    const applicationsSpy = jest.spyOn(NapmMetadataService, 'getApplications')
      .mockResolvedValue([
        { value: 'HTTP', label: 'HTTP', applicationType: 1 },
        { value: 'server-app', label: 'server-app', applicationType: 2 },
        { value: 'web-portal', label: 'web-portal', applicationType: 3 },
        { value: 'auto-app', label: 'auto-app', applicationType: 4 }
      ]);
    const groupArgumentsSpy = jest.spyOn(NapmMetadataService, 'getGroupArguments')
      .mockResolvedValue([{ value: 'web-portal', label: 'web-portal' }]);

    const result = await NapmMetadataService.listObjectInstances('DefinedApp');

    expect(applicationsSpy).toHaveBeenCalledWith('');
    expect(groupArgumentsSpy).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result.map(item => item.value)).toEqual(['server-app']);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({
        value: 'server-app',
        type: 'DefinedApp',
        objectType: 'DefinedApp',
        requestedObjectType: 'DefinedApp',
        effectiveObjectType: 'DefinedApp',
        metadataTruthDomain: 'object_instances',
        providerType: 'applications',
        source: 'southbound_live_api',
        applicationType: 2,
        applicationTypeFilter: [2],
        applicationCatalogRole: 'defined_application'
      })
    ]));
  });

  test('should list CompositeApplication instances through applications Type=4 only', async () => {
    const applicationsSpy = jest.spyOn(NapmMetadataService, 'getApplications')
      .mockResolvedValue([
        { value: 'HTTP', label: 'HTTP', applicationType: 1 },
        { value: 'server-app', label: 'server-app', applicationType: 2 },
        { value: 'web-portal', label: 'web-portal', applicationType: 3 },
        { value: 'composite-app', label: 'composite-app', applicationType: 4 }
      ]);
    const groupArgumentsSpy = jest.spyOn(NapmMetadataService, 'getGroupArguments')
      .mockResolvedValue([{ value: 'legacy-composite', label: 'legacy-composite' }]);

    const result = await NapmMetadataService.listObjectInstances('CompositeApplication');

    expect(applicationsSpy).toHaveBeenCalledWith('');
    expect(groupArgumentsSpy).not.toHaveBeenCalled();
    expect(result).toEqual([
      expect.objectContaining({
        value: 'composite-app',
        type: 'CompositeApplication',
        objectType: 'CompositeApplication',
        requestedObjectType: 'CompositeApplication',
        effectiveObjectType: 'CompositeApplication',
        executionGroupType: 'DefinedApp',
        providerType: 'applications',
        source: 'southbound_live_api',
        applicationType: 4,
        applicationTypeFilter: [4],
        applicationCatalogRole: 'composite_application'
      })
    ]);
  });

  test('should reject metadata inventory argument all instead of filtering application names', async () => {
    const applicationsSpy = jest.spyOn(NapmMetadataService, 'getApplications')
      .mockResolvedValue([
        { value: 'RTSP-CALL_SETUP', label: 'RTSP-CALL_SETUP', applicationType: 4 },
        { value: 'SAP-R3', label: 'SAP-R3', applicationType: 4 }
      ]);

    const response = await RequirementParserService.executeDirectGatewayRequest({
      service: 'groups',
      queryModeKey: 'metadata',
      groups: [{ type: 'CompositeApplication', argument: 'all' }],
      format: 'json'
    });

    expect(applicationsSpy).not.toHaveBeenCalled();
    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      code: 'INVALID_METADATA_INVENTORY_ARGUMENT',
      details: {
        service: 'groups',
        queryModeKey: 'metadata',
        objectType: 'CompositeApplication',
        argument: 'all',
        providerType: 'applications',
        apiType: 'applications'
      }
    });
  });

  test('should execute CompositeApplication inventory without keyword filtering', async () => {
    jest.spyOn(NapmMetadataService, 'getApplications')
      .mockResolvedValue([
        { value: 'RTSP-CALL_SETUP', label: 'RTSP-CALL_SETUP', applicationType: 4 },
        { value: 'SAP-R3', label: 'SAP-R3', applicationType: 4 },
        { value: 'HTTP', label: 'HTTP', applicationType: 1 }
      ]);

    const response = await RequirementParserService.executeDirectGatewayRequest({
      service: 'groups',
      queryModeKey: 'metadata',
      groups: [{ type: 'CompositeApplication' }],
      format: 'json'
    });

    expect(response.ok).toBe(true);
    expect(response.data.map(item => item.value)).toEqual([
      'RTSP-CALL_SETUP',
      'SAP-R3'
    ]);
    expect(response.metadata).toMatchObject({
      requestedObjectType: 'CompositeApplication',
      providerType: 'applications',
      applicationTypeFilter: [4]
    });
  });

  test('should list builtin port applications through applications Type=1 catalog', async () => {
    jest.spyOn(NapmMetadataService, 'getApplications')
      .mockResolvedValue([
        { value: 'HTTP', label: 'HTTP', applicationType: 1 },
        { value: 'server-app', label: 'server-app', applicationType: 2 },
        { value: 'web-portal', label: 'web-portal', applicationType: 3 }
      ]);

    const result = await NapmMetadataService.listObjectInstances('BuiltinApplication');

    expect(result).toEqual([
      expect.objectContaining({
        value: 'HTTP',
        requestedObjectType: 'BuiltinApplication',
        effectiveObjectType: 'BuiltinApplication',
        executionGroupType: 'DefinedApp',
        providerType: 'applications',
        applicationType: 1,
        applicationTypeFilter: [1],
        applicationCatalogRole: 'builtin_port_application'
      })
    ]);
  });

  test('should reject groupArguments when argumentType cannot be resolved', async () => {
    jest.spyOn(NapmMetadataService, 'getGroupDefinition')
      .mockResolvedValue({ key: 'WebApplication', hasArgument: true });

    await expect(NapmMetadataService.getGroupArguments('WebApplication'))
      .rejects
      .toThrow('Unable to resolve argumentType for group type: WebApplication');
  });

  test('should execute single-object metadata inventory through the unified object-instance provider', async () => {
    const listSpy = jest.spyOn(NapmMetadataService, 'listObjectInstances')
      .mockResolvedValue([
        {
          value: 'web-portal',
          label: 'web-portal',
          type: 'WebApplication',
          objectType: 'WebApplication',
          requestedObjectType: 'WebApplication',
          effectiveObjectType: 'WebApplication',
          metadataTruthDomain: 'object_instances',
          providerType: 'applications',
          source: 'southbound_live_api',
          applicationType: 3,
          applicationTypeFilter: [3],
          fallbackUsed: false
        }
      ]);

    const response = await RequirementParserService.executeGatewayRequest({
      service: 'groups',
      start: 1777982400,
      end: 1777986000,
      format: 'json',
      userRequirement: '系统中有哪些web应用',
      groups: [{ type: 'WebApplication' }]
    });

    expect(listSpy).toHaveBeenCalledWith('WebApplication', '');
    expect(response.ok).toBe(true);
    expect(response.requestParams).toMatchObject({
      type: 'applications',
      json: 'true'
    });
    expect(response.metadata).toMatchObject({
      requestedObjectType: 'WebApplication',
      effectiveObjectType: 'WebApplication',
      metadataTruthDomain: 'object_instances',
      providerType: 'applications',
      source: 'southbound_live_api',
      applicationTypeFilter: [3]
    });
  });

  test('should execute business inventory resolvedQuery through applications Type=3 instead of groupArguments argumentType=4', async () => {
    const applicationsSpy = jest.spyOn(NapmMetadataService, 'getApplications')
      .mockResolvedValue([
        { value: 'HTTP', label: 'HTTP', applicationType: 1 },
        { value: 'traffic-observe', label: '交通可观测性分析平台', applicationType: 3 },
        { value: 'defined-app', label: 'defined-app', applicationType: 2 }
      ]);
    const groupArgumentsSpy = jest.spyOn(NapmMetadataService, 'getGroupArguments')
      .mockResolvedValue([
        { value: 'legacy-webapplication', label: 'legacy-webapplication' }
      ]);

    const response = await RequirementParserService.executeGatewayRequest({
      service: 'groups',
      queryModeKey: 'metadata',
      format: 'json',
      userRequirement: '现在系统中有哪些业务？',
      groups: [{ type: 'WebApplication' }],
      semanticConstraints: {
        operation: 'metadata_list',
        targetObjectType: 'WebApplication'
      }
    });

    expect(applicationsSpy).toHaveBeenCalledWith('');
    expect(groupArgumentsSpy).not.toHaveBeenCalled();
    expect(response.ok).toBe(true);
    expect(response.requestParams).toEqual({
      type: 'applications',
      json: 'true'
    });
    expect(response.requestParams).not.toHaveProperty('argumentType');
    expect(response.data).toEqual([
      expect.objectContaining({
        value: 'traffic-observe',
        label: '交通可观测性分析平台',
        type: 'WebApplication',
        providerType: 'applications',
        applicationType: 3,
        applicationTypeFilter: [3]
      })
    ]);
  });

  test('should not validate WebApplication arguments against DefinedApp instances', async () => {
    const result = await QueryMetadataConstraintService.constrainWithDynamicMetadata({
      service: 'topValues',
      metric: 'PGNPGE',
      metrics: ['PGNPGE'],
      groups: [{ type: 'WebApplication', argument: 'HTTPS' }]
    }, {
      groupArguments: [
        {
          value: 'HTTPS',
          label: 'HTTPS',
          requestedObjectType: 'DefinedApp',
          effectiveObjectType: 'DefinedApp',
          objectType: 'DefinedApp',
          type: 'DefinedApp'
        },
        {
          value: 'web-portal',
          label: 'web-portal',
          requestedObjectType: 'WebApplication',
          effectiveObjectType: 'WebApplication',
          objectType: 'WebApplication',
          type: 'WebApplication'
        }
      ]
    });

    expect(result.warnings).toContain('group_argument_not_in_dynamic_metadata:WebApplication:HTTPS');
  });
});
