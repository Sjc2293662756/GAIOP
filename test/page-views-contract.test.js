'use strict';

const {
  DEFAULT_PAGE_VIEWS_LIMIT,
  PAGE_VIEWS_PROTECTIVE_LIMIT,
  buildPageViewsParams,
  extractPageFamilyDetailId,
  extractPageFamilyId,
  normalizePageViewRows,
  normalizePageViewsMaxLimit,
  validatePageViewsQuery
} = require('../skills/shared/NapmPageViewsContract');

describe('shared pageViews contract', () => {
  test('builds a complete request with the numeric client default', () => {
    expect(buildPageViewsParams({
      service: 'pageViews',
      queryModeKey: 'detail',
      start: 1785310980,
      end: 1785314580,
      pageFamilyId: '8573007'
    })).toEqual({
      type: 'pageViews',
      start: 1785310980,
      end: 1785314580,
      json: 'true',
      pageFamilyId: '8573007',
      maxLimit: DEFAULT_PAGE_VIEWS_LIMIT
    });
    expect(normalizePageViewsMaxLimit(undefined)).toBe(DEFAULT_PAGE_VIEWS_LIMIT);
    expect(DEFAULT_PAGE_VIEWS_LIMIT).toBe(20);
    expect(PAGE_VIEWS_PROTECTIVE_LIMIT).toBeGreaterThanOrEqual(DEFAULT_PAGE_VIEWS_LIMIT);
  });

  test.each([
    ['missing pageFamilyId', { pageFamilyId: undefined }, 'PAGE_FAMILY_ID_REQUIRED'],
    ['non-numeric pageFamilyId', { pageFamilyId: 'page-one' }, 'PAGE_FAMILY_ID_INVALID'],
    ['zero maxLimit', { maxLimit: 0 }, 'PAGE_VIEWS_MAX_LIMIT_INVALID'],
    ['fractional maxLimit', { maxLimit: 1.5 }, 'PAGE_VIEWS_MAX_LIMIT_INVALID'],
    ['over protective limit', { maxLimit: PAGE_VIEWS_PROTECTIVE_LIMIT + 1 }, 'PAGE_VIEWS_MAX_LIMIT_EXCEEDED'],
    ['PageFamilyDetail group', { groups: [{ type: 'PageFamilyDetail' }] }, 'PAGE_FAMILY_DETAIL_GROUP_FORBIDDEN'],
    ['metric field', { metrics: ['PGNPGE'] }, 'PAGE_VIEWS_QUERY_FIELDS_FORBIDDEN']
  ])('rejects %s', (_label, overrides, code) => {
    const validation = validatePageViewsQuery({
      service: 'pageViews',
      queryModeKey: 'detail',
      start: 1785310980,
      end: 1785314580,
      pageFamilyId: '8573007',
      ...overrides
    });

    expect(validation).toMatchObject({ ok: false, code });
  });

  test('extracts identifiers and normalizes page visit rows', () => {
    const raw = {
      rows: [{
        groupPath: 'root>pages>page 8573007/https://example.invalid/api',
        StartTime: '2026-08-27 14:05:00',
        Page: 'https://example.invalid/api',
        ClientIp: '192.0.2.10',
        ServerIp: '192.0.2.20',
        HttpStatus: 500,
        Http200S: 2,
        Http400S: 1,
        Http500S: 3,
        PageTime: 1.25,
        PageTraffic: 4096,
        RequestTraffic: 1024,
        UserAgent: 'test-agent',
        pageFamilyDetailId: '36916498-1781149080---1781149111.656803-1781149111.657076-192.0.2.10'
      }]
    };

    expect(extractPageFamilyId(raw.rows[0])).toBe('8573007');
    expect(extractPageFamilyDetailId(raw.rows[0])).toContain('36916498-1781149080');
    expect(normalizePageViewRows(raw)).toEqual([
      expect.objectContaining({
        index: 1,
        rowRef: 'page-view:1',
        page: 'https://example.invalid/api',
        clientIp: '192.0.2.10',
        serverIp: '192.0.2.20',
        httpStatus: 500,
        http200S: 2,
        http400S: 1,
        http500S: 3,
        pageTime: 1.25,
        instanceId: expect.stringMatching(/^PATH1\//)
      })
    ]);
  });

  test.each([
    [[{ httpStatus: 200 }]],
    [{ data: [{ httpStatus: 200 }] }],
    [{ result: { rows: [{ httpStatus: 200 }] } }],
    [JSON.stringify({ items: [{ httpStatus: 200 }] })]
  ])('normalizes supported pageViews response wrappers', (payload) => {
    expect(normalizePageViewRows(payload)).toEqual([
      expect.objectContaining({ index: 1, httpStatus: 200 })
    ]);
  });

  test('rejects a non-JSON pageViews response', () => {
    expect(() => normalizePageViewRows('<html>upstream error</html>')).toThrow(
      expect.objectContaining({ code: 'PAGE_VIEWS_RESPONSE_INVALID' })
    );
  });
});
