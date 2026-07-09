'use strict';

/**
 * Fault diagnosis flow router.
 *
 * Responsibilities:
 *   1. Classify user problem descriptions into flow types
 *   2. Define the step chain for each flow type
 *   3. Resolve inter-flow jumps based on user decisions
 */

// ── Flow definitions ────────────────────────────────────────────────

const FLOW_TYPES = {
  network_slow: {
    label: '网络慢/网络运行异常',
    steps: ['step1_traffic_trend', 'step2_top_objects', 'step3_network_quality', 'step4_connection_failure'],
    // Jump targets from any step in this flow
    jumpTargets: {
      bs_app_slow: { label: 'B/S 业务慢分析', trigger: '某应用/业务异常' },
      cs_app_slow: { label: 'C/S 应用慢分析', trigger: '某应用访问慢' },
      network_quality: { label: '网络质量专项', trigger: '丢包/重传为主' },
      connection_failure: { label: '连接失败/RST 分析', trigger: '连接失败为主' },
      security_anomaly: { label: '安全异常分析', trigger: '失败/未知应用/外连为主' }
    }
  },
  bs_app_slow: {
    label: 'B/S 架构业务慢',
    steps: ['step1_4xx_5xx_overview', 'step2_page_error_analysis', 'step3_page_status_detail'],
    jumpTargets: {
      network_slow: { label: '网络慢分析', trigger: '网络侧指标异常' },
      connection_failure: { label: '连接失败/RST 分析', trigger: 'HTTP错误需看包' },
      network_quality: { label: '网络质量专项', trigger: '网络时间长/重传高' }
    }
  },
  cs_app_slow: {
    label: 'C/S 架构应用慢',
    steps: ['step1_app_overview', 'step2_user_experience_trend', 'step3_slow_client_analysis'],
    jumpTargets: {
      network_slow: { label: '网络慢分析', trigger: '网络侧流量异常' },
      connection_failure: { label: '连接失败/RST 分析', trigger: '失败率升高' },
      network_quality: { label: '网络质量专项', trigger: '重传率升高' }
    }
  }
};

// ── Description → flow type classification ──────────────────────────

/**
 * Classify a user's problem description into a flow type.
 * Uses keyword matching against common scenario descriptions.
 */
function classify(description = '') {
  const text = String(description || '').toLowerCase();

  // B/S app slow keywords
  const bsKeywords = [
    'web', '页面', 'url', 'http', '登录慢', '查询慢', '接口慢',
    '提交后', '转圈', '报错', '400', '500', '页面慢', 'bs', 'b/s',
    '业务系统慢', '业务慢', '网站慢', '浏览器',
    '业务故障分析', '业务故障诊断', 'web应用慢', 'web业务'
  ];

  // B/S takes priority when user explicitly says "业务故障"
  if (text.includes('业务故障') || text.includes('业务诊断')) {
    return 'bs_app_slow';
  }
  // B/S keyword matching
  if (bsKeywords.some((k) => text.includes(k))) {
    return 'bs_app_slow';
  }

  // C/S app slow keywords
  const csKeywords = [
    '客户端软件', '数据库访问', '非web', '非 web', 'cs', 'c/s',
    '固定端口', '能连上但', '操作慢', '没有url', '客户端慢',
    'c/s架构', 'cs架构', '桌面应用',
    '应用故障分析', '应用故障诊断', '应用性能分析',
    '应用慢', '应用访问慢', '应用响应慢', '应用延迟',
    'tcp应用', '非http', '非http应用', '协议应用'
  ];

  // C/S takes priority when user explicitly says "应用故障"
  if (text.includes('应用故障') || text.includes('应用诊断')) {
    return 'cs_app_slow';
  }
  // C/S keyword matching
  if (csKeywords.some((k) => text.includes(k))) {
    return 'cs_app_slow';
  }

  // Network slow keywords — catch-all default
  const netKeywords = [
    '全网', '网络慢', '网络卡', '网络运行', '带宽', '拥塞',
    '全局', '整体', '访问多个系统都慢', '大家都', '所有业务',
    '网络异常', '流量异常', '流量高', '流量突'
  ];
  if (netKeywords.some((k) => text.includes(k)) || text.length === 0) {
    return 'network_slow';
  }

  // Default to network_slow for anything unrecognized
  return 'network_slow';
}

/**
 * Get the flow definition for a given flow type.
 */
function getFlow(flowType = 'network_slow') {
  return FLOW_TYPES[flowType] || FLOW_TYPES.network_slow;
}

/**
 * Get the next step in a flow, or null if at the end.
 */
function getNextStep(flowType, currentStepId) {
  const flow = getFlow(flowType);
  const idx = flow.steps.indexOf(currentStepId);
  if (idx < 0 || idx >= flow.steps.length - 1) return null;
  return flow.steps[idx + 1];
}

/**
 * Resolve a jump from one flow+step to another flow+step based on user decision.
 */
function resolveJump(fromFlowType, fromStepId, userDecision = '') {
  const flow = getFlow(fromFlowType);
  const decision = String(userDecision || '').toLowerCase();

  // Map user decisions to jump targets
  const jumpMap = {
    '转B/S业务': 'bs_app_slow',
    '转B/S业务分析': 'bs_app_slow',
    '转C/S应用': 'cs_app_slow',
    '转C/S应用分析': 'cs_app_slow',
    '转应用慢': 'bs_app_slow',
    '转网络质量': 'network_quality',
    '转网络质量专项': 'network_quality',
    '丢包重传为主': 'network_quality',
    '转连接失败': 'connection_failure',
    '连接失败为主': 'connection_failure',
    '转安全异常': 'security_anomaly',
    '安全异常': 'security_anomaly',
    '失败未知外连': 'security_anomaly',
    '转网络分析': 'network_slow',
    '网络侧异常': 'network_slow'
  };

  const targetFlow = jumpMap[decision] || null;
  if (!targetFlow || !FLOW_TYPES[targetFlow]) {
    // Not a jump — stay in current flow, move to next step
    const nextStep = getNextStep(fromFlowType, fromStepId);
    return nextStep ? { flowType: fromFlowType, stepId: nextStep } : null;
  }

  // Jump to the first step of the target flow
  return {
    flowType: targetFlow,
    stepId: FLOW_TYPES[targetFlow].steps[0]
  };
}

/**
 * Get all available jump options for a flow (for user display).
 */
function getJumpOptions(flowType) {
  const flow = getFlow(flowType);
  return Object.entries(flow.jumpTargets).map(([key, val]) => ({
    flowType: key,
    label: val.label,
    trigger: val.trigger
  }));
}

// ── Name → NAPM catalog resolution ────────────────────────────────

/**
 * Extract candidate target name from user input.
 * Priority: target.groupLabel > target.groupArgument > regex from description.
 */
function extractTargetName(input = {}) {
  // 1. From description — always check first, it's the user's actual intent.
  //    Target fields may contain AI guesses that are wrong.
  let desc = String(input.description || '');
  let raw = _extractFromDescription(desc);
  if (raw) return raw;

  // 2. Fallback: from explicit target fields (caller provided name but no description match)
  const label = input.target?.groupLabel || input.target?.groupArgument || '';
  const trimmed = String(label).trim();
  if (trimmed) return trimmed;

  return null;
}

/**
 * Extract candidate target name from description text.
 * Keyword-anchored: locate "应用故障"/"业务故障" etc., then extract the name before it.
 */
function _extractFromDescription(desc) {
  desc = String(desc || '');

  // Ordered keyword patterns — first match wins
  const kwPatterns = [
    /(?:应用|业务)故障/,
    /(?:应用|业务)(?:慢|异常|延迟|分析|诊断)/,
    /故障(?:分析|报告|诊断)/,
  ];

  let kwMatch = null;
  for (const pat of kwPatterns) {
    kwMatch = desc.match(pat);
    if (kwMatch) break;
  }
  if (!kwMatch) return null;

  // Extract text before the keyword
  const before = desc.slice(0, kwMatch.index).trim();
  if (!before) return null;

  let raw = null;

  // Strip trailing "的" (with optional leading whitespace) then extract last word
  //   "可观测239的应用故障" → before="可观测239"  → "可观测239"
  //   "给我可观测239 的"     → before="给我可观测239" → "可观测239"
  const beforeClean = before.replace(/\s*的\s*$/, '').trim();
  if (beforeClean) {
    const runMatch = beforeClean.match(/([一-龥a-zA-Z0-9_-]+)$/);
    if (runMatch) raw = runMatch[1];
  }

  if (!raw) return null;

  // Strip leading action words that may bleed into the name
  // ("分析一下可观测239的" → after deMatch: "分析一下可观测239")
  raw = raw.replace(/^(?:请帮我看一下|请帮我分析一下|帮我分析一下|帮我查看一下|帮我分析|帮我查看|请帮我|帮我|请|分析一下|分析下|分析|查看一下|查看|检查一下|检查|诊断一下|诊断|排查|给|给我|我|做|出个|出)+/, '').trim();

  return raw || null;
}

/**
 * Find the best-matching NAPM application entry by name.
 * Scoring: exact(100) > prefix(80) > contains(50) > contained(40).
 * Tie-break: prefer Type=2 (DefinedApp, shorter/more precise names).
 */
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
    } else if (candidateName.includes(name) && name.length >= 3) {
      candidates.push({ name, type: Number(app.type) || 0, score: 40, matchType: 'contained' });
    }
  }

  if (candidates.length === 0) {
    // No match — try stripping common suffixes and re-matching
    // "239web" → "239" → may find "可观测239" (DefinedApp)
    const stripped = candidateName.replace(/(?:web|应用|业务|网站|系统|平台|服务)$/i, '');
    if (stripped && stripped !== candidateName && stripped.length >= 2) {
      return matchAppByName(stripped, catalog);
    }
    return null;
  }

  // Sort: highest score first; tie-break → prefer Type=2 (DefinedApp)
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.type === 2 && b.type !== 2) return -1;
    if (b.type === 2 && a.type !== 2) return 1;
    return 0;
  });

  const best = candidates[0];

  // If best match is not exact, also try suffix-stripped version —
  // it might find a better-typed match
  if (best.score < 100) {
    const stripped = candidateName.replace(/(?:web|应用|业务|网站|系统|平台|服务)$/i, '');
    if (stripped && stripped !== candidateName && stripped.length >= 2) {
      const strippedMatch = matchAppByName(stripped, catalog);
      // Prefer stripped match if it has higher score or same score but better type (Type=2)
      if (strippedMatch && (
        strippedMatch.score > best.score ||
        (strippedMatch.score === best.score && strippedMatch.type === 2 && best.type !== 2)
      )) {
        return strippedMatch;
      }
    }
  }

  return best;
}

/**
 * Resolve fault diagnosis flow type from a NAPM catalog match.
 * Type=3 → WebApplication → bs_app_slow (业务故障分析)
 * Type=1,2,4 → DefinedApp (or mapped) → cs_app_slow (应用故障分析)
 */
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
  getNextStep,
  resolveJump,
  getJumpOptions,
  extractTargetName,
  matchAppByName,
  resolveFlowTypeFromCatalog,
  FLOW_TYPES,
  __test__: { FLOW_TYPES }
};
