const plugin = require('../napm-openclaw-plugin.remote');

describe('report delivery presentation', () => {
  test('renders a bounded inspection overview without exposing artifact locations', () => {
    const text = plugin.__test__.buildInspectionReportDeliveryReply({
      summary: {
        status: 'warning',
        highlights: [
          '发现一。',
          '发现二。',
          '发现三。',
          '发现四。',
          '发现五。',
          '发现六。'
        ]
      }
    }, {
      ok: true,
      title: 'NAPM 系统巡检报告',
      format: 'docx',
      downloadUrl: '/reports/inspection.docx',
      filePath: '/home/netinside/private/inspection.docx'
    });

    expect(text).toContain('总体状态：需关注');
    expect(text).toContain('- 发现一。');
    expect(text).toContain('- 发现五。');
    expect(text).not.toContain('发现六');
    expect(text).not.toContain('/reports/');
    expect(text).not.toContain('/home/');
    expect(text).not.toContain('下载链接');
    expect(text).not.toContain('文件路径');
  });

  test('uses the inspection conclusion when highlights are unavailable', () => {
    const text = plugin.__test__.buildInspectionReportDeliveryReply({
      summary: { status: 'unknown', highlights: [] },
      inspection: {
        summary: {
          overallStatus: 'unknown',
          conclusion: '当前数据不足，建议稍后重新巡检。'
        }
      }
    }, {
      ok: true,
      title: 'NAPM 系统巡检报告',
      filePath: '/tmp/inspection.docx'
    });

    expect(text).toContain('巡检结论：当前数据不足，建议稍后重新巡检。');
    expect(text).not.toContain('总体状态：unknown');
    expect(text).toContain('完整巡检报告已作为附件发送。');
    expect(text).not.toContain('/tmp/inspection.docx');
  });

  test('keeps generic report replies path-free', () => {
    const text = plugin.__test__.buildReportExportReply({
      ok: true,
      title: 'NAPM 综述报告',
      format: 'docx',
      downloadUrl: '/reports/summary.docx',
      filePath: '/tmp/summary.docx'
    });

    expect(text).toBe([
      '报告已生成：NAPM 综述报告',
      '格式：docx',
      '完整报告将以附件形式发送。'
    ].join('\n'));
  });
});
