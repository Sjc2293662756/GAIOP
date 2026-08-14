describe('napm-openclaw-plugin packet business page guard', () => {
  let plugin;
  let packetSkill;

  beforeEach(() => {
    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote.js');
    packetSkill = require('../skills/openclaw-napm-packet-analysis/scripts/run_packet_analysis.js');
  });

  test('should route an explicit business page preview through DownServlet resolution', () => {
    const resolved = packetSkill.resolveQuery({
      prompt: 'http://101.254.114.238/SDK/webLanguage 分析这个的数据包预览',
      mode: 'preview_only',
      criteria: {
        businessName: 'SDK',
        page: 'http://101.254.114.238/SDK/webLanguage',
        pageUrl: 'http://101.254.114.238/SDK/webLanguage',
        businessPageViewsPreviewOnly: true,
        start: 1781488800,
        end: 1781492400
      }
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.task.mode).toBe('preview_only');
    expect(resolved.task.downloadType).toBe('DownServlet');
    expect(resolved.task.needsBusinessInstanceResolution).toBe(true);
    expect(resolved.task.criteria.page).toBe('http://101.254.114.238/SDK/webLanguage');
    expect(resolved.task.criteria.businessPageViewsPreviewOnly).toBe(true);
  });

  test('should keep explicit IP-only packet preview as packetsDown flow', () => {
    const resolved = packetSkill.resolveQuery({
      prompt: '预览 101.254.114.238 最近一小时的数据包',
      mode: 'preview_only',
      downloadType: 'packetsDown',
      criteria: {
        ips: ['101.254.114.238'],
        start: 1781488800,
        end: 1781492400
      }
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.task.mode).toBe('preview_only');
    expect(resolved.task.downloadType).toBe('packetsDown');
    expect(resolved.task.needsBusinessInstanceResolution).toBe(false);
    expect(resolved.task.criteria.page).toBeUndefined();
  });
});
