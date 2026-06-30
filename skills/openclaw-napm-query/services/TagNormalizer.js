/**
 * TagNormalizer.js
 *
 * 把 LLM 提取的千变万化的中文语义标签归一化到标准 key，
 * 供规则引擎精确映射为 resolvedQuery。
 */
const TimeRangeService = require('./ResolvedQueryTimeRangeService');

// ── 模糊归一化：中文说法 → 标准 key ──────────────────────

const METRIC_NORMALIZE = [
  ['丢包', 'packet_loss'], ['掉包', 'packet_loss'], ['包丢失', 'packet_loss'],
  ['packet loss', 'packet_loss'], ['丢包率', 'packet_loss'],
  ['报错', 'http_error'], ['错误', 'http_error'], ['异常', 'http_error'],
  ['失败', 'http_error'], ['HTTP错误', 'http_error'], ['HTTP 错误', 'http_error'],
  ['4xx', 'http_error'], ['5xx', 'http_error'], ['400', 'http_error'], ['500', 'http_error'],
  ['连接失败', 'conn_failure'], ['TCP失败', 'conn_failure'], ['connection failure', 'conn_failure'],
  ['流量', 'traffic'], ['带宽', 'traffic'], ['吞吐', 'traffic'], ['throughput', 'traffic'],
  ['延迟', 'latency'], ['响应时间', 'latency'], ['时延', 'latency'],
  ['慢', 'latency'], ['卡', 'latency'], ['RTT', 'latency'],
  ['页面延时', 'page_latency'], ['页面响应', 'page_latency'], ['页面加载', 'page_latency'],
  ['连接数', 'connection'], ['并发连接', 'connection'],
  ['数据包', 'packet_count'], ['包数量', 'packet_count'], ['包量', 'packet_count'],
  ['PKIO', 'packet_count'],
  ['页面访问', 'page_visits'], ['访问量', 'page_visits'], ['访问次数', 'page_visits'],
  ['重传', 'retransmission'], ['重传率', 'retransmission'],
  ['慢页面', 'slow_page'], ['慢页面数', 'slow_page'],
  ['用户体验', 'ux'], ['体验', 'ux'],
];

const OBJECT_NORMALIZE = [
  ['IP', 'IPAddress'], ['IP地址', 'IPAddress'], ['地址', 'IPAddress'],
  ['主机', 'IPAddress'], ['ip', 'IPAddress'], ['ipaddress', 'IPAddress'],
  ['业务', 'WebApplication'], ['业务系统', 'WebApplication'],
  ['网站', 'WebApplication'], ['web应用', 'WebApplication'], ['Web应用', 'WebApplication'],
  ['站点', 'WebApplication'], ['WebApplication', 'WebApplication'],
  ['业务组', 'BusinessGroup'], ['工作组', 'BusinessGroup'],
  ['业务分组', 'BusinessGroup'], ['BusinessGroup', 'BusinessGroup'],
  ['网段', 'Prefix24'], ['子网', 'Prefix24'], ['/24', 'Prefix24'], ['Prefix24', 'Prefix24'],
  ['已定义应用', 'DefinedApp'], ['协议应用', 'DefinedApp'],
  ['服务器应用', 'DefinedApp'], ['DefinedApp', 'DefinedApp'], ['应用', 'DefinedApp'],
  ['自动识别应用', 'CompositeApplication'], ['复合协议', 'CompositeApplication'],
  ['CompositeApplication', 'CompositeApplication'],
];

const SHAPE_NORMALIZE = [
  ['排行', 'ranking'], ['排名', 'ranking'], ['最', 'ranking'], ['谁', 'ranking'],
  ['哪个', 'ranking'], ['top', 'ranking'], ['TopN', 'ranking'], ['找', 'ranking'],
  ['均值', 'average'], ['平均', 'average'], ['是多少', 'average'],
  ['趋势', 'trend'], ['变化', 'trend'], ['走势', 'trend'], ['波动', 'trend'], ['历史', 'trend'],
  ['清单', 'inventory'], ['列表', 'inventory'], ['有哪些', 'inventory'], ['列出', 'inventory'],
  ['综合分析', 'overview'], ['概览', 'overview'], ['总览', 'overview'],
];

const TIME_NORMALIZE = [
  ['最近1小时', 'last1hour'], ['最近一小时', 'last1hour'], ['1小时', 'last1hour'],
  ['当前', 'last1hour'], ['现在', 'last1hour'], ['这一小时', 'last1hour'],
  ['最近24小时', 'last24hours'], ['最近一天', 'last24hours'], ['24小时', 'last24hours'],
  ['一天', 'last24hours'], ['今天', 'today'], ['今日', 'today'],
  ['最近7天', 'last7days'], ['最近一周', 'last7days'], ['7天', 'last7days'], ['一周', 'last7days'],
  ['最近30天', 'last30days'], ['最近一个月', 'last30days'], ['30天', 'last30days'],
];

const SIZE_NORMALIZE = [
  ['1个', 1], ['谁', 1], ['哪个', 1], ['哪一个', 1], ['最', 1],
  ['5个', 5], ['五个', 5], ['5', 5],
  ['10个', 10], ['十个', 10], ['10', 10],
  ['20个', 20], ['二十个', 20], ['20', 20],
];

// ── 归一化函数 ──────────────────────────────────

function fuzzyMatch(text, table) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  // 精确匹配优先
  for (const [key, value] of table) {
    if (t === key.toLowerCase()) return value;
  }
  // 包含匹配
  for (const [key, value] of table) {
    if (t.includes(key.toLowerCase())) return value;
  }
  return null;
}

// ── 标签 → 指标 code 映射 ──────────────────────

const METRIC_CODE_MAP = {
  packet_loss:    { metric: 'PLI',  metrics: ['PLI'],      topMetric: 'PLI' },
  http_error:     { metric: 'PGHTTP400', metrics: ['PGHTTP400','PGHTTP500'], topMetric: 'PGHTTP400' },
  conn_failure:   { metric: 'RFCI', metrics: ['RFCI','RFCO'], topMetric: 'RFCI' },
  traffic:        { metric: 'BYTIO',metrics: ['BYTIO'],     topMetric: 'BYTIO' },
  latency:        { metric: 'RTTI', metrics: ['RTTI'],      topMetric: 'RTTI' },
  page_latency:   { metric: 'PGTME',metrics: ['PGTME'],     topMetric: 'PGTME' },
  connection:     { metric: 'CONI', metrics: ['CONI','CCNI'],topMetric: 'CONI' },
  packet_count:   { metric: 'PKIO', metrics: ['PKIO'],      topMetric: 'PKIO' },
  page_visits:    { metric: 'PGNPGE',metrics: ['PGNPGE'],   topMetric: 'PGNPGE' },
  retransmission: { metric: 'RTXI', metrics: ['RTXI'],      topMetric: 'RTXI' },
  slow_page:      { metric: 'PGNSLPGE',metrics:['PGNSLPGE'],topMetric:'PGNSLPGE' },
  ux:             { metric: 'UEII', metrics: ['UEII'],      topMetric: 'UEII' },
};

// 上下文修正：报错在业务组下用连接失败指标
function resolveMetricCode(metricKey, objectType) {
  let code = METRIC_CODE_MAP[metricKey];
  if (!code) return null;
  // 上下文修正
  if (metricKey === 'http_error' && objectType === 'BusinessGroup') {
    code = METRIC_CODE_MAP['conn_failure'];
  }
  if (metricKey === 'latency' && objectType === 'WebApplication') {
    code = METRIC_CODE_MAP['page_latency'];
  }
  return code;
}

const OBJECT_GROUP_MAP = {
  IPAddress:             [{ type: 'IPAddress' }],
  WebApplication:        [{ type: 'WebApplication' }],
  BusinessGroup:         [{ type: 'BusinessGroup' }],
  Prefix24:              [{ type: 'Prefix24' }],
  DefinedApp:            [{ type: 'DefinedApp' }],
  CompositeApplication:  [{ type: 'DefinedApp' }],
};

const SHAPE_SERVICE_MAP = {
  ranking:   { service: 'topValues',     queryModeKey: 'topn' },
  average:   { service: 'averageValues', queryModeKey: 'average' },
  trend:     { service: 'timeValues',    queryModeKey: 'timeseries' },
  inventory: { service: 'groups',        queryModeKey: 'metadata' },
  overview:  { service: 'overview',      queryModeKey: 'overview' },
};

const TIME_SECONDS_MAP = {
  last1hour:    3600,
  last24hours: 86400,
  today:        null, // 特殊处理
  last7days:   604800,
  last30days:  2592000,
};

// ── 主入口 ──────────────────────────────────────

function normalizeTags(tags = {}) {
  const metricKey = fuzzyMatch(tags.metricIntent, METRIC_NORMALIZE);
  const objectType = fuzzyMatch(tags.objectScope, OBJECT_NORMALIZE) || 'IPAddress';
  const shape = fuzzyMatch(tags.queryShape, SHAPE_NORMALIZE) || 'ranking';
  const timeKey = fuzzyMatch(tags.timeAnchor, TIME_NORMALIZE) || 'last1hour';
  const size = fuzzyMatch(String(tags.resultSize || ''), SIZE_NORMALIZE) || 10;

  return { metricKey, objectType, shape, timeKey, size };
}

function mapTagsToResolvedQuery(tags = {}, userPrompt = '') {
  const normalized = normalizeTags(tags);
  const { metricKey, objectType, shape, timeKey, size } = normalized;

  // 1. 指标
  const metricCode = resolveMetricCode(metricKey, objectType);
  if (!metricCode) {
    return {
      ok: false,
      reason: `无法识别指标意图: ${tags.metricIntent || '未指定'}`,
      needsConstruction: true,
    };
  }

  // 2. service + queryModeKey
  const serviceInfo = SHAPE_SERVICE_MAP[shape];
  if (!serviceInfo) {
    return { ok: false, reason: `无法识别查询方式: ${tags.queryShape}`, needsConstruction: true };
  }

  // 3. groups
  const groups = OBJECT_GROUP_MAP[objectType] || [{ type: 'IPAddress' }];

  // 4. 时间
  const nowSeconds = Math.floor(Date.now() / 1000);
  let start, end;
  if (timeKey === 'today') {
    const todayRange = TimeRangeService.buildTodayTimeRange(nowSeconds);
    start = todayRange.start;
    end = todayRange.end;
  } else {
    const seconds = TIME_SECONDS_MAP[timeKey] || 3600;
    const range = TimeRangeService.buildRelativeTimeRange(timeKey, seconds, nowSeconds);
    start = range.start;
    end = range.end;
  }

  // 5. topCount
  const topCount = shape === 'ranking' ? size : undefined;

  // 6. 组装
  const resolvedQuery = {
    service: serviceInfo.service,
    queryModeKey: serviceInfo.queryModeKey,
    metric: metricCode.metric,
    metrics: metricCode.metrics,
    topMetric: metricCode.topMetric,
    groups,
    start,
    end,
    timeRange: { key: timeKey, displayText: tags.timeAnchor || timeKey },
    ...(topCount ? { topCount } : {}),
    format: 'json',
    userRequirement: userPrompt || '',
    semanticConstraints: {
      operation: shape === 'ranking' ? 'rank_top' : shape,
      targetObjectType: objectType,
      workflowType: shape === 'ranking' ? 'metric_topn' : `metric_${shape}`,
    },
    executionOptions: { allowPathRepair: true },
    resolutionHints: { constructedBy: 'tag_mapper' },
  };

  return { ok: true, resolvedQuery };
}

module.exports = { normalizeTags, mapTagsToResolvedQuery, fuzzyMatch };
