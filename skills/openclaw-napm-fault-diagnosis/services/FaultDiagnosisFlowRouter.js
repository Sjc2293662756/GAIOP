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
    steps: ['step1_app_overview', 'step2_time_breakdown'],
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
    '业务系统慢', '业务慢', '网站慢', '浏览器'
  ];
  if (bsKeywords.some((k) => text.includes(k))) {
    return 'bs_app_slow';
  }

  // C/S app slow keywords
  const csKeywords = [
    '客户端软件', '数据库访问', '非web', '非 web', 'cs', 'c/s',
    '固定端口', '能连上但', '操作慢', '没有url', '客户端慢',
    'c/s架构', 'cs架构', '桌面应用'
  ];
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
    '转应用分析': 'bs_app_slow',
    '转业务分析': 'bs_app_slow',
    '转bs应用': 'bs_app_slow',
    '转b/s应用': 'bs_app_slow',
    '转cs应用': 'cs_app_slow',
    '转c/s应用': 'cs_app_slow',
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

module.exports = {
  classify,
  getFlow,
  getNextStep,
  resolveJump,
  getJumpOptions,
  FLOW_TYPES,
  __test__: { FLOW_TYPES }
};
