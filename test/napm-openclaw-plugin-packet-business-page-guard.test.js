describe('napm-openclaw-plugin packet business page guard', () => {
  let plugin;

  beforeEach(() => {
    jest.resetModules();
    plugin = require('../.codex-temp/napm-openclaw-plugin.remote.js');
  });

  test('should normalize page URL packet preview to DownServlet pageViews preview', () => {
    const payload = plugin.__test__.buildPacketExecutorPayload({
      prompt: 'http://101.254.114.238/SDK/webLanguage 分析这个的数据包预览',
      mode: 'preview_only',
      criteria: {
        ips: ['101.254.114.238'],
        start: 1781488800,
        end: 1781492400
      }
    });

    expect(payload.mode).toBe('preview_only');
    expect(payload.downloadType).toBe('DownServlet');
    expect(payload.criteria.page).toBe('http://101.254.114.238/SDK/webLanguage');
    expect(payload.criteria.pageUrl).toBe('http://101.254.114.238/SDK/webLanguage');
    expect(payload.criteria.businessPageViewsPreviewOnly).toBe(true);
  });

  test('should keep explicit IP-only packet preview as packetsDown flow', () => {
    const payload = plugin.__test__.buildPacketExecutorPayload({
      prompt: '预览 101.254.114.238 最近一小时的数据包',
      mode: 'preview_only',
      downloadType: 'packetsDown',
      criteria: {
        ips: ['101.254.114.238'],
        start: 1781488800,
        end: 1781492400
      }
    });

    expect(payload.mode).toBe('preview_only');
    expect(payload.downloadType).toBe('packetsDown');
    expect(payload.criteria.page).toBeUndefined();
    expect(payload.criteria.businessPageViewsPreviewOnly).toBeUndefined();
  });
});
