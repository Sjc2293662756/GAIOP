'use strict';

/**
 * Fault diagnosis flow router.
 *
 * Responsibilities:
 *   1. Define the step chain for each flow type (业务故障分析 / 应用故障分析)
 *   2. Classify user descriptions → flow type (fallback when catalog unavailable)
 *   3. Name → NAPM catalog → Type → flowType (primary path)
 */

// ── Flow definitions ────────────────────────────────────────────────

const FLOW_TYPES = {
  bs_app_slow: {
    label: 'B/S 架构业务慢',
    steps: ['step1_4xx_5xx_overview', 'step2_page_error_analysis', 'step3_page_status_detail']
  },
  bs_page_perf: {
    label: 'B/S 页面性能慢',
    steps: ['step1_page_perf_overview', 'step2_page_delay_detail', 'step3_slow_pattern_analysis']
  },
  cs_app_slow: {
    label: 'C/S 架构应用慢',
    steps: ['step1_app_overview', 'step2_user_experience_trend', 'step3_slow_client_analysis']
  }
};

// ── Description → flow type classification (fallback) ────────────────

function classify(description = '') {
  const text = String(description || '').toLowerCase();

  // PgPerf: 页面性能慢（必须在 B/S 之前检查，避免"页面慢"被错误路由到 bs_app_slow）
  if (text.includes('页面性能') || text.includes('性能诊断')) return 'bs_page_perf';
  // Chinese text often has words inserted between keyword components (e.g., "加载很慢" not "加载慢")
  if (/(?:页面|加载|访问|响应|打开|载入|渲染|首屏).{0,2}(?:慢|延时|延迟|卡顿|卡|转圈)/.test(text)) return 'bs_page_perf';
  const perfKeywords = [
    '页面慢', '加载慢', '响应慢', '打开慢', '访问延时',
    '延时高', '延迟高', '卡顿', '转圈', '加载中',
    '性能问题', '响应时间', '用户体验差',
    '页面响应', '载入慢', '渲染慢', '首屏',
    '白屏', '页面加载', '性能分析'
  ];
  if (perfKeywords.some((k) => text.includes(k))) return 'bs_page_perf';

  // B/S: 业务故障
  if (text.includes('业务故障') || text.includes('业务诊断')) return 'bs_app_slow';
  const bsKeywords = [
    'web', '页面', 'url', 'http', '登录慢', '查询慢', '接口慢',
    '提交后', '转圈', '报错', '400', '500', '页面慢', 'bs', 'b/s',
    '业务系统慢', '业务慢', '网站慢', '浏览器',
    '业务故障分析', '业务故障诊断', 'web应用慢', 'web业务'
  ];
  if (bsKeywords.some((k) => text.includes(k))) return 'bs_app_slow';

  // C/S: 应用故障
  if (text.includes('应用故障') || text.includes('应用诊断')) return 'cs_app_slow';
  const csKeywords = [
    '客户端软件', '数据库访问', '非web', '非 web', 'cs', 'c/s',
    '固定端口', '能连上但', '操作慢', '没有url', '客户端慢',
    'c/s架构', 'cs架构', '桌面应用',
    '应用故障分析', '应用故障诊断', '应用性能分析',
    '应用慢', '应用访问慢', '应用响应慢', '应用延迟',
    'tcp应用', '非http', '非http应用', '协议应用'
  ];
  if (csKeywords.some((k) => text.includes(k))) return 'cs_app_slow';

  // Default
  return 'bs_app_slow';
}

function getFlow(flowType) {
  return FLOW_TYPES[flowType] || FLOW_TYPES.bs_app_slow;
}

/**
 * Check if a description is a PgPerf（页面性能）intent rather than PgAna（页面错误）.
 * Used to override catalog-based routing when the catalog says WebApplication (bs_app_slow)
 * but the user's description indicates a performance analysis intent.
 */
function isPerfDescription(description = '') {
  const text = String(description || '').toLowerCase();
  if (text.includes('页面性能') || text.includes('性能诊断')) return true;
  // Chinese text often has words inserted (e.g., "加载很慢" not "加载慢")
  if (/(?:页面|加载|访问|响应|打开|载入|渲染|首屏).{0,2}(?:慢|延时|延迟|卡顿|卡|转圈)/.test(text)) return true;
  const perfKeywords = [
    '页面慢', '加载慢', '响应慢', '打开慢', '访问延时',
    '延时高', '延迟高', '卡顿', '转圈',
    '性能问题', '响应时间', '用户体验差',
    '页面响应', '载入慢', '渲染慢', '首屏',
    '白屏', '页面加载', '性能分析'
  ];
  return perfKeywords.some((k) => text.includes(k));
}

// ── Name → NAPM catalog resolution ────────────────────────────────

function extractTargetName(input = {}) {
  let text = String(input.prompt || input.description || '');
  let raw = _extractFromDescription(text);
  if (raw) return raw;

  const label = input.target?.groupLabel || input.target?.groupArgument || '';
  const trimmed = String(label).trim();
  if (trimmed) return trimmed;

  return null;
}

function _extractFromDescription(desc) {
  desc = String(desc || '');

  const kwPatterns = [
    /(?:应用|业务)故障/,
    /(?:应用|业务)(?:慢|异常|延迟|分析|诊断|报告)/,
    /故障(?:分析|报告|诊断)/,
    // PgPerf: 页面性能相关模式（必须在泛化"分析报告诊断"之前检查，避免"分析一下"误匹配）
    /(?:页面|加载|延时|延迟|性能).{0,3}(?:慢|高|长|分析|诊断|卡顿|问题|拆分)/,
    /(?:首屏|白屏|卡顿|转圈)/,
    // PgPerf: 直接关键词
    /(?:页面加载|页面慢|页面延时|页面延迟|页面卡顿|加载慢|响应慢|打开慢|渲染慢|性能分析|性能诊断|延时分析)/,
    /(?:应用|业务)$/,
    /分析(?:报告|诊断)/,
  ];

  let kwMatch = null;
  for (const pat of kwPatterns) {
    kwMatch = desc.match(pat);
    if (kwMatch) break;
  }
  if (!kwMatch) return null;

  const before = desc.slice(0, kwMatch.index).trim();
  if (!before) return null;

  const beforeClean = before.replace(/\s*的\s*$/, '').trim();
  if (!beforeClean) return null;

  let cleaned = beforeClean.replace(/^(?:请帮我看一下|请帮我分析一下|帮我分析一下|帮我查看一下|帮我分析|帮我查看|请帮我|给我|帮我|请|分析一下|分析下|分析|查看一下|查看|检查一下|检查|诊断一下|诊断|排查|给|我|做|出个|出)\s*/i, '').trim();

  const nameMatch = cleaned.match(/^([一-龥a-zA-Z0-9_-]+)/);
  if (nameMatch) return nameMatch[1];

  return null;
}

function matchAppByName(candidateName, catalog = []) {
  if (!candidateName || catalog.length === 0) return null;

  const candidates = [];

  for (const app of catalog) {
    const name = String(app.name || '');
    if (!name) continue;

    if (name === candidateName) {
      candidates.push({ name, type: Number(app.type) || 0, score: 100, matchType: 'exact' });
    } else if (name.startsWith(candidateName)) {
      candidates.push({ name, type: Number(app.type) || 0, score: 80, matchType: 'prefix' });
    } else if (name.includes(candidateName)) {
      candidates.push({ name, type: Number(app.type) || 0, score: 50, matchType: 'contains' });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.type === 2 && b.type !== 2) return -1;
    if (b.type === 2 && a.type !== 2) return 1;
    return 0;
  });

  return candidates[0];
}

function resolveFlowTypeFromCatalog(match) {
  const isBusiness = match.type === 3;
  return {
    flowType: isBusiness ? 'bs_app_slow' : 'cs_app_slow',
    groupType: isBusiness ? 'WebApplication' : 'DefinedApp',
    groupArgument: match.name,
    groupLabel: match.name
  };
}

module.exports = {
  classify,
  getFlow,
  isPerfDescription,
  extractTargetName,
  matchAppByName,
  resolveFlowTypeFromCatalog,
  FLOW_TYPES
};
