const {
  buildMetricInventoryPresentation
} = require('../skills/openclaw-napm-query/services/MetricInventoryPresentationService');

const WEB_APPLICATION_ROWS = [
  { id: 'PGHTTP100PCT', label: '% HTTP 100数量', unit: '%' },
  { id: 'PGNPGE', label: '页面访问数', unit: 'pages' },
  { id: 'PGSLRT', label: '慢页面率', unit: 'pages/min' },
  { id: 'PGHTTP400', label: 'HTTP 400数量', unit: 'objects' },
  { id: 'PGRT', label: '页面访问率', unit: 'pages/min' },
  { id: 'PGHTTP200PCT', label: '% HTTP 200数量', unit: '%' },
  { id: 'PGNOBJE', label: 'HTTP响应数', unit: 'objects' },
  { id: 'PGSLPCT', label: '慢页面百分比', unit: '%' },
  { id: 'PGBYTI', label: '请求流量', unit: 'MiB' },
  { id: 'PPOPT', label: '部分优化的页面数量百分比', unit: '%' },
  { id: 'PGHTTP400PCT', label: '% HTTP 400数量', unit: '%' },
  { id: 'PGBYTO', label: '页面流量', unit: 'MiB' },
  { id: 'PGSIZEO', label: '页面大小', unit: 'KiB' },
  { id: 'PGHTTP500PCT', label: '% HTTP 500数量', unit: '%' },
  { id: 'POPT', label: '优化的页面数量百分比', unit: '%' },
  { id: 'PGSIZEI', label: '请求大小', unit: 'KiB' },
  { id: 'PGHTTP100', label: 'HTTP 100数量', unit: 'objects' },
  { id: 'PGNSLPGE', label: '慢页面数量', unit: 'pages' },
  { id: 'PGHTTP200', label: 'HTTP 200数量', unit: 'objects' },
  { id: 'ROPT', label: '优化的响应百分比', unit: '%' },
  { id: 'PGHTTP300PCT', label: '% HTTP 300数量', unit: '%' },
  { id: 'PGTME', label: '页面延时', unit: 'sec' },
  { id: 'PGHTTP500', label: 'HTTP 500数量', unit: 'objects' },
  { id: 'PFOPT', label: '全优化的页面百分比', unit: '%' },
  { id: 'PNOPT', label: '未优化的页面数量百分比', unit: '%' },
  { id: 'PGHTTP300', label: 'HTTP 300数量', unit: 'objects' }
];

const BUSINESS_GROUP_METRIC_IDS = [
  'TPIO', 'TPI', 'TPO', 'BYTIO', 'BYTI', 'BYTO',
  'PKIO', 'PKI', 'PKO', 'PKTIO', 'PKTI', 'PKTO', 'PKZI', 'PKZO',
  'GPI', 'GPO', 'UTI', 'UTO', 'FSO_B', 'FSI_B', 'FSO_P', 'FSI_P',
  'RTTI', 'RTTO', 'PLI', 'PLO', 'RDTI', 'RDTO', 'RTXI', 'RTXO', 'RPKI', 'RPKO',
  'CONI', 'CONO', 'CCNI', 'CCNO', 'RFCI', 'RFCO', 'CDI', 'CDO',
  'CRTI', 'CRTO', 'FILI', 'FILO', 'RFRI', 'RFRO',
  'RSTSI', 'RSTSO', 'RSTI', 'RSTO', 'TRNI', 'TRNO', 'TRRI', 'TRRO',
  'CSTI', 'CSTO', 'TRTI', 'TRTO', 'NRTO', 'NRTI', 'PTTO', 'PTTI',
  'T2FBO', 'T2FBI', 'ARTO', 'ARTI', 'UEII', 'UEIO'
];

function countOccurrences(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (text.match(new RegExp(`(?<![A-Z0-9_])${escaped}(?![A-Z0-9_])`, 'g')) || []).length;
}

describe('MetricInventoryPresentationService', () => {
  test('groups the 26 returned WebApplication metrics into five readable sections', () => {
    const presentation = buildMetricInventoryPresentation({
      objectType: 'WebApplication',
      rows: WEB_APPLICATION_ROWS
    });

    expect(presentation.metricCount).toBe(26);
    expect(presentation.sections.map((section) => section.title)).toEqual([
      '业务网络',
      '业务访问',
      '业务性能',
      '响应代码',
      '页面优化'
    ]);
    expect(presentation.displayText).toContain('按类别整理如下');
    expect(presentation.displayText).toContain('页面访问（访问数 PGNPGE');
    expect(presentation.displayText).toContain('访问率 PGRT');
    expect(presentation.displayText).toContain('HTTP 状态码数量');
    expect(presentation.displayText).toContain('HTTP 状态码占比');
    expect(presentation.displayText).toContain('小结：');
    expect(presentation.displayText).not.toMatch(/^\d+\.\s+/m);

    WEB_APPLICATION_ROWS.forEach(({ id }) => {
      expect(countOccurrences(presentation.displayText, id)).toBe(1);
    });
    expect(presentation.displayText).not.toContain('PGNPGC');
  });

  test('keeps a 68-metric BusinessGroup inventory grouped in the accepted operations format', () => {
    const rows = BUSINESS_GROUP_METRIC_IDS.map((id) => ({ id, label: id, unit: 'unit' }));
    const presentation = buildMetricInventoryPresentation({
      objectType: 'BusinessGroup',
      rows
    });

    expect(presentation.metricCount).toBe(68);
    expect(presentation.sections.map((section) => section.title)).toEqual([
      '流量/吞吐',
      '连接/TCP',
      '时延/响应',
      '可靠性',
      '体验'
    ]);
    expect(presentation.displayText).toContain('利用率');
    expect(presentation.displayText).toContain('连接请求数');
    expect(presentation.displayText).toContain('丢包情况');
    expect(presentation.displayText).not.toMatch(/^\d+\.\s+/m);

    BUSINESS_GROUP_METRIC_IDS.forEach((id) => {
      expect(countOccurrences(presentation.displayText, id)).toBe(1);
    });
  });

  test('puts an unknown returned metric in Other without inventing or dropping it', () => {
    const presentation = buildMetricInventoryPresentation({
      objectType: 'WebApplication',
      rows: [
        { id: 'PGNPGE', label: '页面访问数', unit: 'pages' },
        { id: 'PGFUTURE', label: '未来指标', unit: 'widgets' }
      ]
    });

    expect(presentation.sections.map((section) => section.title)).toEqual([
      '业务访问',
      '其他指标'
    ]);
    expect(presentation.displayText).toContain('未来指标（PGFUTURE，widgets）');
    expect(countOccurrences(presentation.displayText, 'PGFUTURE')).toBe(1);
  });

  test('keeps a known but out-of-profile returned metric visible in Other', () => {
    const presentation = buildMetricInventoryPresentation({
      objectType: 'WebApplication',
      rows: [
        { id: 'PGNPGE', label: '页面访问数', unit: 'pages' },
        { id: 'TPIO', label: '吞吐量', unit: 'kb/sec' }
      ]
    });

    expect(presentation.sections.map((section) => section.title)).toEqual([
      '业务访问',
      '其他指标'
    ]);
    expect(countOccurrences(presentation.displayText, 'TPIO')).toBe(1);
  });

  test('uses the repository server and client semantics for business detail metrics', () => {
    const presentation = buildMetricInventoryPresentation({
      objectType: 'WebApplication',
      rows: [
        { id: 'PGNPGC', label: '页面访问数（服务器）', unit: 'pages' },
        { id: 'PGNPGS', label: '页面访问数（客户端）', unit: 'pages' },
        { id: 'PGTMC', label: '页面延时（服务器）', unit: 'sec' },
        { id: 'PGTMS', label: '页面延时（客户端）', unit: 'sec' }
      ]
    });

    expect(presentation.displayText).toContain('服务器访问数 PGNPGC');
    expect(presentation.displayText).toContain('客户端访问数 PGNPGS');
    expect(presentation.displayText).toContain('服务器 PGTMC');
    expect(presentation.displayText).toContain('客户端 PGTMS');
  });
});
