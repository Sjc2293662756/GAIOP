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

  test('should list WebApplication instances through groupArguments, not protocol applications', async () => {
    const applicationsSpy = jest.spyOn(NapmMetadataService, 'getApplications')
      .mockResolvedValue([{ value: 'HTTP', label: 'HTTP' }]);
    const groupArgumentsSpy = jest.spyOn(NapmMetadataService, 'getGroupArguments')
      .mockResolvedValue([{ value: 'web-portal', label: 'web-portal' }]);

    const result = await NapmMetadataService.listObjectInstances('WebApplication');

    expect(groupArgumentsSpy).toHaveBeenCalledWith('WebApplication', '');
    expect(applicationsSpy).not.toHaveBeenCalled();
    expect(result).toEqual([
      expect.objectContaining({
        value: 'web-portal',
        type: 'WebApplication',
        objectType: 'WebApplication',
        requestedObjectType: 'WebApplication',
        effectiveObjectType: 'WebApplication',
        metadataTruthDomain: 'object_instances',
        providerType: 'groupArguments',
        source: 'southbound_live_api'
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
      metadataTruthDomain: 'object_instances',
      providerType: 'groupArguments',
      apiType: 'groupArguments',
      source: 'southbound_live_api'
    });
    expect(ObjectMetadataRegistry.resolveObjectInstanceProvider('DefinedApp')).toMatchObject({
      requestedObjectType: 'DefinedApp',
      effectiveObjectType: 'DefinedApp',
      providerType: 'applications',
      apiType: 'applications'
    });
  });

  test('should list DefinedApp instances through applications, not WebApplication groupArguments', async () => {
    const applicationsSpy = jest.spyOn(NapmMetadataService, 'getApplications')
      .mockResolvedValue([{ value: 'HTTPS', label: 'HTTPS' }]);
    const groupArgumentsSpy = jest.spyOn(NapmMetadataService, 'getGroupArguments')
      .mockResolvedValue([{ value: 'web-portal', label: 'web-portal' }]);

    const result = await NapmMetadataService.listObjectInstances('DefinedApp');

    expect(applicationsSpy).toHaveBeenCalledWith('');
    expect(groupArgumentsSpy).not.toHaveBeenCalled();
    expect(result).toEqual([
      expect.objectContaining({
        value: 'HTTPS',
        type: 'DefinedApp',
        objectType: 'DefinedApp',
        requestedObjectType: 'DefinedApp',
        effectiveObjectType: 'DefinedApp',
        metadataTruthDomain: 'object_instances',
        providerType: 'applications',
        source: 'southbound_live_api'
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
          providerType: 'groupArguments',
          source: 'southbound_live_api',
          argumentType: 18,
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
      type: 'groupArguments',
      json: 'true'
    });
    expect(response.requestParams.argumentType).toEqual(expect.any(Number));
    expect(response.metadata).toMatchObject({
      requestedObjectType: 'WebApplication',
      effectiveObjectType: 'WebApplication',
      metadataTruthDomain: 'object_instances',
      providerType: 'groupArguments',
      source: 'southbound_live_api'
    });
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
