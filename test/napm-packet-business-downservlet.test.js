const packet = require('../skills/openclaw-napm-packet-analysis/scripts/run_packet_analysis');

describe('openclaw-napm-packet-analysis business DownServlet flow', () => {
  const host = 'https://101.254.114.238';

  test('should mark business packet criteria for multi-step instance resolution', () => {
    const resolved = packet.resolveQuery({
      mode: 'build_url_only',
      host,
      criteria: {
        businessName: '其他Web应用',
        start: 1781147760,
        end: 1781151360
      }
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.task.downloadType).toBe('DownServlet');
    expect(resolved.task.needsBusinessInstanceResolution).toBe(true);
    expect(resolved.task.urls).toEqual({});
  });

  test('should extract pageFamilyId from selected page row groupPath', () => {
    const row = {
      groupPath: 'root>WebApplication 其他Web应用>pages>page 8573007/http://101.254.114.239:443/'
    };

    expect(packet.extractPageFamilyId(row)).toBe('8573007');
  });

  test('should extract pageFamilyDetailId from pageViews record and normalize instanceId', () => {
    const record = {
      pageFamilyDetailId: '36916498-1781149080---1781149111.656803-1781149111.657076-182.242.169.138',
      clientIp: '182.242.169.138',
      httpStatus: 500
    };

    const detailId = packet.extractPageFamilyDetailId(record);
    expect(detailId).toBe('36916498-1781149080---1781149111.656803-1781149111.657076-182.242.169.138');
    expect(packet.normalizeInstanceId(detailId)).toBe(`PATH1/${detailId}`);
  });

  test('should build page family and pageViews URLs according to v3 document', () => {
    const criteria = {
      start: 1781147760,
      end: 1781151360
    };

    const pageFamilyUrl = new URL(packet.buildPageFamilyTopValuesUrl(host, criteria, '其他Web应用'));
    expect(pageFamilyUrl.searchParams.get('type')).toBe('topValues');
    expect(pageFamilyUrl.searchParams.get('numGroups')).toBe('3');
    expect(pageFamilyUrl.searchParams.get('groupType1')).toBe('WebApplication');
    expect(pageFamilyUrl.searchParams.get('groupArgument1')).toBe('其他Web应用');
    expect(pageFamilyUrl.searchParams.get('groupType2')).toBe('PageFamilies');
    expect(pageFamilyUrl.searchParams.get('groupType3')).toBe('PageFamily');
    expect(pageFamilyUrl.searchParams.get('topMetric')).toBe('PGHTTP500');

    const pageViewsUrl = new URL(packet.buildPageViewsUrl(host, criteria, '8573007'));
    expect(pageViewsUrl.searchParams.get('type')).toBe('pageViews');
    expect(pageViewsUrl.searchParams.get('json')).toBe('true');
    expect(pageViewsUrl.searchParams.get('pageFamilyId')).toBe('8573007');
    expect(pageViewsUrl.searchParams.get('maxLimit')).toBe('undefined');
  });

  test('should build pageViews preview rows for business packet selection', () => {
    const preview = packet.buildPageViewsPreview([
      {
        clientIp: '31.59.160.12',
        serverIp: '101.254.114.238',
        httpStatus: 404,
        page: 'http://101.254.114.238/SDK/webLanguage',
        startTime: '2026-06-15 10:39:30.7',
        pageFamilyDetailId: '43425979-1781491140---1781491170.721124-1781491170.873562-31.59.160.12'
      },
      {
        clientIp: '204.76.203.219',
        serverIp: '101.254.114.238',
        httpStatus: 404,
        page: 'http://101.254.114.238/SDK/webLanguage',
        startTime: '2026-06-15 10:32:26.1',
        pageFamilyDetailId: '43425974-1781490720---1781490746.135020-1781490746.296289-204.76.203.219'
      }
    ], {
      businessName: '其他Web应用',
      pageFamilyId: '8574581'
    });

    expect(preview.rowCount).toBe(2);
    expect(preview.uniqueClientIps).toEqual(['31.59.160.12', '204.76.203.219']);
    expect(preview.statusCounts).toEqual({ '404': 2 });
    expect(preview.rows[0]).toMatchObject({
      index: 0,
      clientIp: '31.59.160.12',
      serverIp: '101.254.114.238',
      httpStatus: 404,
      instanceId: 'PATH1/43425979-1781491140---1781491170.721124-1781491170.873562-31.59.160.12'
    });
  });

  test('should build DownServlet URL with fixed groupId and rtClickId for resolved instance', () => {
    const urls = packet.buildUrls({
      host,
      showFullUrls: false,
      downloadType: 'DownServlet',
      criteria: {
        start: 1781147760,
        end: 1781151360,
        instanceId: 'PATH1/36916498-1781149080---1781149111.656803-1781149111.657076-182.242.169.138'
      }
    });

    const downloadUrl = new URL(urls.download);
    expect(downloadUrl.pathname).toBe('/webservice/DownServlet');
    expect(downloadUrl.searchParams.get('moduleKey')).toBe('Ipv');
    expect(downloadUrl.searchParams.get('groupId')).toBe('45');
    expect(downloadUrl.searchParams.get('rtClickId')).toBe('5');
    expect(downloadUrl.searchParams.get('instanceId')).toBe('PATH1/36916498-1781149080---1781149111.656803-1781149111.657076-182.242.169.138');
  });
});
