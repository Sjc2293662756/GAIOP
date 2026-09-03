'use strict';

process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'test-password';

jest.mock('../skills/openclaw-napm-query/services/NapmClient', () => {
  return jest.fn().mockImplementation(() => ({
    username: process.env.NETINSIDE_USERNAME,
    password: process.env.NETINSIDE_PASSWORD,
    baseUrl: process.env.NETINSIDE_HOST,
    get: jest.fn(),
    getJson: jest.fn()
  }));
});

const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');

function buildQuery(overrides = {}) {
  return {
    service: 'pageViews',
    queryModeKey: 'detail',
    start: 1785310980,
    end: 1785314580,
    pageFamilyId: '8573007',
    maxLimit: 20,
    ...overrides
  };
}

describe('pageViews execution kernel', () => {
  beforeEach(() => {
    RequirementParserService.napmClient.get.mockReset();
  });

  test('executes one southbound request and normalizes visit details', async () => {
    RequirementParserService.napmClient.get.mockResolvedValue({
      rows: [{
        startTime: '2026-08-27 14:05:00',
        page: 'https://example.invalid/api',
        clientIp: '192.0.2.10',
        serverIp: '192.0.2.20',
        httpStatus: 500,
        pageFamilyDetailId: '36916498-1781149080---1781149111.656803-1781149111.657076-192.0.2.10'
      }]
    });

    const result = await RequirementParserService.executeGatewayRequest(buildQuery());

    expect(result).toMatchObject({
      ok: true,
      service: 'pageViews',
      requestParams: {
        type: 'pageViews',
        start: 1785310980,
        end: 1785314580,
        json: 'true',
        pageFamilyId: '8573007',
        maxLimit: 20
      },
      data: [expect.objectContaining({
        index: 1,
        httpStatus: 500,
        instanceId: expect.stringMatching(/^PATH1\//)
      })]
    });
    expect(RequirementParserService.napmClient.get).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['missing pageFamilyId', { pageFamilyId: undefined }],
    ['invalid maxLimit', { maxLimit: 'undefined' }],
    ['forbidden PageFamilyDetail group', { groups: [{ type: 'PageFamilyDetail' }] }],
    ['forbidden metric shape', { metrics: ['PGNPGE'] }]
  ])('blocks %s before NapmClient', async (_label, overrides) => {
    const result = await RequirementParserService.executeGatewayRequest(buildQuery(overrides));

    expect(result.ok).toBe(false);
    expect(RequirementParserService.napmClient.get).not.toHaveBeenCalled();
  });
});
