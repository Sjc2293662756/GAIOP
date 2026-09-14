'use strict';

const MetricSemanticNormalizerService = require('./MetricSemanticNormalizerService');
const ObjectOntologyService = require('./ObjectOntologyService');
const RankingIntentParserService = require('./RankingIntentParserService');
const TimeRangeService = require('./ResolvedQueryTimeRangeService');

const SEMANTIC_SCHEMA_VERSION = 'napm-query-semantic.v1';
const SEMANTIC_STATUS = Object.freeze({
  RESOLVED: 'RESOLVED',
  AMBIGUOUS: 'AMBIGUOUS',
  UNRESOLVED: 'UNRESOLVED',
  UNSUPPORTED: 'UNSUPPORTED'
});

const REQUIRED_SLOTS_BY_OPERATION = Object.freeze({
  rank_top: Object.freeze(['operation', 'targetObjectType', 'rankingMetric', 'topCount', 'direction']),
  rank_bottom: Object.freeze(['operation', 'targetObjectType', 'rankingMetric', 'topCount', 'direction']),
  timeseries: Object.freeze(['operation', 'targetObjectType', 'requestedMetrics']),
  average: Object.freeze(['operation', 'targetObjectType', 'requestedMetrics']),
  detail_list: Object.freeze(['operation', 'targetObjectType']),
  metadata_list: Object.freeze(['operation', 'targetObjectType']),
  drilldown: Object.freeze(['operation', 'targetObjectType']),
  overview: Object.freeze(['operation'])
});

function normalizePromptText(prompt = '') {
  return String(prompt || '').trim();
}

function hasInventoryIntent(text = '') {
  return /(?:系统中|系统里|系统都|当前|现在)?[^，。！？\n]{0,12}(?:有哪些|有什么|有哪几个|都有哪些|包含哪些|列表|清单)/.test(text)
    || /(?:列出|查看|查询)[^，。！？\n]{0,12}(?:业务|业务系统|WebApplication|Web应用|web应用|网站|站点|应用|工作组|业务组|业务分组|BusinessGroup)/i.test(text);
}

function hasMetricInventoryIntent(text = '') {
  return /(?:哪些|有什么|有哪些|都有哪些)[^，。！？\n]{0,12}指标/.test(text)
    || /指标[^，。！？\n]{0,12}(?:哪些|有什么|有哪些|可查|能查|支持)/.test(text)
    || /(?:可查|能查|支持)[^，。！？\n]{0,12}(?:哪些|有什么|有哪些)[^，。！？\n]{0,6}指标/.test(text);
}

function hasDrilldownIntent(text = '') {
  return /(下钻|钻取|层级|路径|往下钻到哪里|支持哪些|可达|目录|结构)/.test(text);
}

function hasOverviewIntent(text = '') {
  return /(整体|总体|概览|总览|overall|overview|global|怎么样|情况|状态)/i.test(text);
}

function hasTrendIntent(text = '') {
  return /(趋势|走势|变化|曲线|time\s*series|timeseries)/i.test(text);
}

function hasAverageIntent(text = '') {
  return /(平均|均值|average|avg)/i.test(text);
}

function hasPageViewDetailIntent(text = '') {
  const explicitDetail = /page\s*views?|访问(?:实例|明细|详情)|页面(?:访问)?实例/i.test(text);
  const rankedPageDetail = /页面/.test(text)
    && /(详细查看|查看详情|明细)/.test(text)
    && /(排名|排行|第\s*[一二三四五六七八九十\d]+|前\s*\d+)/.test(text);
  return explicitDetail || rankedPageDetail;
}

function hasRankedResultPageDrilldownIntent(text = '') {
  const hasOrdinalReference = /(?:排名|排行)?第\s*[一二三四五六七八九十\d]+|排名(?:第一|首位)|排行(?:第一|首位)/.test(text);
  const asksVisitedPages = /(?:都|具体)?访问了(?:什么|哪些)|访问(?:的)?(?:页面|地址|URL)|有哪些页面/i.test(text);
  return hasOrdinalReference && asksVisitedPages;
}

function matchAlertPacketIntent(text = '') {
  if (!/告警/i.test(text) || !/(?:数据包|报文|抓包|pcap|\.cap\b)/i.test(text)) {
    return null;
  }
  const eventMatch = text.match(/\bevent\s*id\s*[:=]?\s*(\d+)\b/i)
    || text.match(/告警(?:事件)?\s*(?:id\s*[:=]?)?\s*(\d{3,})/i);
  return eventMatch ? { eventId: eventMatch[1] } : null;
}

function buildTimeIntent(text = '') {
  const explicit = TimeRangeService.hasExplicitTimeRangeExpression(text);
  return {
    key: TimeRangeService.inferTimeRangeKeyFromPrompt(text),
    explicit,
    source: 'ResolvedQueryTimeRangeService'
  };
}

function freezeAmbiguities(items = []) {
  return Object.freeze(items.map((item) => Object.freeze({
    ...item,
    candidates: Object.freeze(Array.isArray(item.candidates)
      ? item.candidates.map((candidate) => (
        candidate && typeof candidate === 'object'
          ? Object.freeze({ ...candidate })
          : candidate
      ))
      : [])
  })));
}

function deriveSemanticLifecycle({
  operation = null,
  direction = null,
  targetObjectType = null,
  requestedMetrics = [],
  rankingMetric = null,
  topCount = null,
  metricSemantic,
  objectIntent,
  rankingIntent
} = {}) {
  const requiredSlots = REQUIRED_SLOTS_BY_OPERATION[operation] || ['operation'];
  const ambiguities = [];

  if (requiredSlots.includes('targetObjectType') && objectIntent?.ambiguous === true) {
    ambiguities.push({
      slot: 'targetObjectType',
      candidates: Array.isArray(objectIntent.candidates) ? objectIntent.candidates : []
    });
  }
  const metricSlot = requiredSlots.includes('rankingMetric')
    ? 'rankingMetric'
    : (requiredSlots.includes('requestedMetrics') ? 'requestedMetrics' : null);
  if (metricSlot && metricSemantic?.status === 'ambiguous') {
    ambiguities.push({
      slot: metricSlot,
      candidates: Array.isArray(metricSemantic.candidates)
        ? metricSemantic.candidates.map((metricId) => ({ metricId }))
        : []
    });
  }
  if (
    requiredSlots.some((slot) => ['operation', 'direction', 'topCount'].includes(slot))
    && rankingIntent?.status === 'ambiguous'
  ) {
    ambiguities.push({
      slot: 'operation',
      candidates: Array.isArray(rankingIntent.candidates) ? rankingIntent.candidates : []
    });
  }

  const ambiguousSlots = new Set(ambiguities.map((item) => item.slot));
  const values = {
    operation,
    direction,
    targetObjectType,
    requestedMetrics,
    rankingMetric,
    topCount
  };
  const unresolvedSlots = requiredSlots.filter((slot) => {
    if (ambiguousSlots.has(slot)) return false;
    const value = values[slot];
    if (slot === 'requestedMetrics') return !Array.isArray(value) || value.length === 0;
    if (slot === 'topCount') return !Number.isInteger(Number(value)) || Number(value) <= 0;
    return value === null || value === undefined || value === '';
  });

  if (ambiguities.length > 0) {
    return {
      status: SEMANTIC_STATUS.AMBIGUOUS,
      ambiguities: freezeAmbiguities(ambiguities),
      unresolvedSlots: Object.freeze(unresolvedSlots),
      reasonCode: 'SEMANTIC_AMBIGUOUS'
    };
  }
  if (unresolvedSlots.length > 0) {
    return {
      status: SEMANTIC_STATUS.UNRESOLVED,
      ambiguities: Object.freeze([]),
      unresolvedSlots: Object.freeze(unresolvedSlots),
      reasonCode: 'SEMANTIC_UNRESOLVED'
    };
  }
  if (operation === 'rank_bottom') {
    return {
      status: SEMANTIC_STATUS.UNSUPPORTED,
      ambiguities: Object.freeze([]),
      unresolvedSlots: Object.freeze([]),
      reasonCode: 'RANK_BOTTOM_UNSUPPORTED'
    };
  }
  return {
    status: SEMANTIC_STATUS.RESOLVED,
    ambiguities: Object.freeze([]),
    unresolvedSlots: Object.freeze([]),
    reasonCode: null
  };
}

function buildSemanticContract({
  operation = null,
  direction = null,
  targetObjectType = null,
  metricSemantic,
  objectIntent,
  rankingIntent,
  timeIntent,
  confidence = 0
} = {}) {
  const requestedMetrics = metricSemantic?.status === 'resolved'
    ? metricSemantic.requestedMetrics.slice()
    : [];
  const primaryMetric = metricSemantic?.status === 'resolved'
    ? metricSemantic.primaryMetric
    : null;
  const isRanking = operation === 'rank_top' || operation === 'rank_bottom';
  const rankingMetric = isRanking
    ? (metricSemantic?.rankingMetric || primaryMetric || null)
    : null;
  const lifecycle = deriveSemanticLifecycle({
    operation,
    direction,
    targetObjectType,
    requestedMetrics,
    rankingMetric,
    topCount: isRanking ? rankingIntent?.topCount || null : null,
    metricSemantic,
    objectIntent,
    rankingIntent
  });
  const objectSourceType = targetObjectType && targetObjectType !== objectIntent?.objectType
    ? 'workflow_classifier_context'
    : 'object_ontology';
  return Object.freeze({
    schemaVersion: SEMANTIC_SCHEMA_VERSION,
    status: lifecycle.status,
    operation,
    direction,
    targetObjectType,
    primaryMetric,
    requestedMetrics: Object.freeze(requestedMetrics),
    rankingMetric,
    topCount: isRanking ? rankingIntent?.topCount || null : null,
    timeIntent: Object.freeze({ ...(timeIntent || {}) }),
    confidence,
    ambiguities: lifecycle.ambiguities,
    unresolvedSlots: lifecycle.unresolvedSlots,
    reasonCode: lifecycle.reasonCode,
    source: Object.freeze({
      object: Object.freeze({
        type: objectSourceType,
        schemaVersion: ObjectOntologyService.loadOntology().version,
        status: objectIntent?.ambiguous === true
          ? 'ambiguous'
          : (targetObjectType ? 'resolved' : 'unresolved'),
        candidates: Object.freeze(Array.isArray(objectIntent?.candidates)
          ? objectIntent.candidates.slice()
          : [])
      }),
      metric: Object.freeze({
        ...(metricSemantic?.source || {}),
        status: metricSemantic?.status || 'unresolved',
        candidates: Object.freeze(Array.isArray(metricSemantic?.candidates)
          ? metricSemantic.candidates.slice()
          : []),
        matchedRuleIds: Object.freeze(Array.isArray(metricSemantic?.matchedRuleIds)
          ? metricSemantic.matchedRuleIds.slice()
          : [])
      }),
      ranking: Object.freeze({
        ...(rankingIntent?.source || {}),
        status: rankingIntent?.status || 'unresolved',
        matchedRuleIds: Object.freeze(Array.isArray(rankingIntent?.matchedRuleIds)
          ? rankingIntent.matchedRuleIds.slice()
          : [])
      })
    })
  });
}

function buildResult(base, semanticContract, metricSemantic) {
  return {
    ...base,
    operation: semanticContract.operation,
    direction: semanticContract.direction,
    targetObjectType: semanticContract.targetObjectType,
    primaryMetric: semanticContract.primaryMetric,
    requestedMetrics: semanticContract.requestedMetrics,
    rankingMetric: semanticContract.rankingMetric,
    topCount: semanticContract.topCount,
    timeIntent: semanticContract.timeIntent,
    metricSemantic: metricSemantic?.status === 'resolved' ? metricSemantic : null,
    semanticContract
  };
}

function classifyWorkflow(prompt = '') {
  const text = normalizePromptText(prompt);
  const objectIntent = ObjectOntologyService.classifyObjectText(text);
  const rankingIntent = RankingIntentParserService.parseRankingIntent(text);
  const targetObjectType = objectIntent.objectType || null;
  const metricSemantic = MetricSemanticNormalizerService.resolveMetricSemantic(text, {
    targetObjectType,
    rankingMetricText: rankingIntent?.rankingMetricClause?.metricText || '',
    rankingMetricRange: rankingIntent?.rankingMetricClause?.metricRange || null
  });
  const timeIntent = buildTimeIntent(text);

  const finalize = (base, operation, direction = null, confidence = base.confidence || 0) => {
    const semanticContract = buildSemanticContract({
      operation,
      direction,
      targetObjectType: base.targetObjectType === undefined ? targetObjectType : base.targetObjectType,
      metricSemantic,
      objectIntent,
      rankingIntent,
      timeIntent,
      confidence
    });
    return buildResult(base, semanticContract, metricSemantic);
  };

  if (!text) {
    return finalize({ workflowType: null, confidence: 0, reason: 'empty_prompt' }, null);
  }

  const alertPacketIntent = matchAlertPacketIntent(text);
  if (alertPacketIntent) {
    return finalize({
      workflowType: 'alert_packet_analysis',
      confidence: 1,
      eventId: alertPacketIntent.eventId,
      reason: 'alert_packet_event_intent'
    }, null, null, 1);
  }

  if (hasPageViewDetailIntent(text)) {
    return finalize({
      workflowType: 'page_view_detail',
      targetObjectType: targetObjectType || 'PageFamily',
      confidence: 0.95,
      reason: 'page_view_detail_intent'
    }, 'detail_list', null, 0.95);
  }

  if (hasRankedResultPageDrilldownIntent(text)) {
    return finalize({
      workflowType: 'metric_topn',
      targetObjectType: 'PageFamily',
      drilldownRequested: true,
      requiresResultReference: true,
      confidence: 0.95,
      reason: 'ranked_result_page_drilldown_intent'
    }, 'drilldown', null, 0.95);
  }

  if (hasDrilldownIntent(text)) {
    return finalize({
      workflowType: 'drilldown_catalog',
      confidence: 0.9,
      reason: 'drilldown_catalog_intent'
    }, 'metadata_list', null, 0.9);
  }

  if (hasMetricInventoryIntent(text)) {
    return finalize({
      workflowType: 'metric_inventory',
      confidence: 0.9,
      reason: 'metric_inventory_intent'
    }, 'metadata_list', null, 0.9);
  }

  if (hasTrendIntent(text)) {
    return finalize({
      workflowType: 'metric_timeseries',
      confidence: 0.85,
      reason: 'trend_intent'
    }, 'timeseries', null, 0.85);
  }

  if (hasAverageIntent(text)) {
    return finalize({
      workflowType: 'metric_average',
      confidence: 0.85,
      reason: 'average_intent'
    }, 'average', null, 0.85);
  }

  if (rankingIntent.status === 'resolved') {
    return finalize({
      workflowType: 'metric_topn',
      confidence: 0.9,
      reason: 'ranking_intent'
    }, rankingIntent.operation, rankingIntent.direction, 0.9);
  }

  if (hasInventoryIntent(text) && targetObjectType) {
    return finalize({
      workflowType: 'object_inventory',
      confidence: 0.92,
      reason: 'object_inventory_intent'
    }, 'metadata_list', null, 0.92);
  }

  if (hasOverviewIntent(text)) {
    return finalize({
      workflowType: 'overview',
      confidence: 0.7,
      reason: 'overview_intent'
    }, 'overview', null, 0.7);
  }

  return finalize({
    workflowType: null,
    confidence: 0.2,
    reason: 'workflow_unresolved'
  }, null, null, 0.2);
}

function isObjectInventoryPrompt(prompt = '') {
  return classifyWorkflow(prompt).workflowType === 'object_inventory';
}

module.exports = {
  SEMANTIC_SCHEMA_VERSION,
  SEMANTIC_STATUS,
  buildSemanticContract,
  deriveSemanticLifecycle,
  classifyWorkflow,
  isObjectInventoryPrompt,
  normalizePromptText
};
