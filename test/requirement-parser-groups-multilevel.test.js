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

describe('RequirementParserService multilevel groups execution', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('should not short-circuit multilevel groups query to top-level metadata list', async () => {
    const businessGroupsSpy = jest.spyOn(NapmMetadataService, 'getBusinessGroups');
    const applicationsSpy = jest.spyOn(NapmMetadataService, 'getApplications');

    const response = await RequirementParserService.executeGatewayRequest({
      service: 'groups',
      start: 1777982400,
      end: 1777986000,
      format: 'json',
      userRequirement: 'look at applications under this business group',
      groups: [
        { type: 'BusinessGroup', argument: 'server-segment' },
        { type: 'Applications', argument: null },
        { type: 'DefinedApp', argument: null }
      ]
    });

    expect(businessGroupsSpy).not.toHaveBeenCalled();
    expect(applicationsSpy).not.toHaveBeenCalled();
    expect(response.requestParams).toMatchObject({
      type: 'groups',
      groupType1: 'BusinessGroup',
      groupArgument1: 'server-segment',
      groupType2: 'Applications',
      groupType3: 'DefinedApp',
      numGroups: 3
    });
  });
});
