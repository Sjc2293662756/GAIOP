const {
  classifyApplicationCatalogPrompt
} = require('./ApplicationCatalogSemanticRules');
const ObjectOntologyService = require('./ObjectOntologyService');

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

function hasRankingIntent(text = '') {
  return /(最大|最高|最多|较多|更多|偏多|最小|最低|最少|较少|更少|偏少|top\s*\d*|TopN|排行|排名|是谁|哪个|哪一个)/i.test(text);
}

function hasTrendIntent(text = '') {
  return /(趋势|走势|变化|曲线|time\s*series|timeseries)/i.test(text);
}

function hasAverageIntent(text = '') {
  return /(平均|均值|average|avg)/i.test(text);
}

function matchAlertPacketIntent(text = '') {
  if (!/告警/i.test(text) || !/(?:数据包|报文|抓包|pcap|\.cap\b)/i.test(text)) {
    return null;
  }
  const eventMatch = text.match(/\bevent\s*id\s*[:=]?\s*(\d+)\b/i)
    || text.match(/告警(?:事件)?\s*(?:id\s*[:=]?)?\s*(\d{3,})/i);
  return eventMatch ? { eventId: eventMatch[1] } : null;
}

function inferInventoryObjectType(text = '') {
  const ontologyMatch = ObjectOntologyService.classifyObjectText(text);
  if (ontologyMatch.objectType) {
    return ontologyMatch.objectType;
  }

  const applicationCatalog = classifyApplicationCatalogPrompt(text);
  return applicationCatalog.objectType || null;
}

function classifyWorkflow(prompt = '') {
  const text = normalizePromptText(prompt);
  if (!text) {
    return {
      workflowType: null,
      confidence: 0,
      reason: 'empty_prompt'
    };
  }

  const alertPacketIntent = matchAlertPacketIntent(text);
  if (alertPacketIntent) {
    return {
      workflowType: 'alert_packet_analysis',
      confidence: 1,
      eventId: alertPacketIntent.eventId,
      reason: 'alert_packet_event_intent'
    };
  }

  if (hasDrilldownIntent(text)) {
    return {
      workflowType: 'drilldown_catalog',
      confidence: 0.9,
      targetObjectType: inferInventoryObjectType(text),
      reason: 'drilldown_catalog_intent'
    };
  }

  if (hasMetricInventoryIntent(text)) {
    return {
      workflowType: 'metric_inventory',
      confidence: 0.9,
      targetObjectType: inferInventoryObjectType(text),
      reason: 'metric_inventory_intent'
    };
  }

  if (hasTrendIntent(text)) {
    return {
      workflowType: 'metric_timeseries',
      confidence: 0.85,
      targetObjectType: inferInventoryObjectType(text),
      reason: 'trend_intent'
    };
  }

  if (hasAverageIntent(text)) {
    return {
      workflowType: 'metric_average',
      confidence: 0.85,
      targetObjectType: inferInventoryObjectType(text),
      reason: 'average_intent'
    };
  }

  if (hasRankingIntent(text)) {
    return {
      workflowType: 'metric_topn',
      confidence: 0.85,
      targetObjectType: inferInventoryObjectType(text),
      reason: 'ranking_intent'
    };
  }

  if (hasInventoryIntent(text)) {
    const targetObjectType = inferInventoryObjectType(text);
    if (targetObjectType) {
      return {
        workflowType: 'object_inventory',
        confidence: 0.92,
        targetObjectType,
        reason: 'object_inventory_intent'
      };
    }
  }

  if (hasOverviewIntent(text)) {
    return {
      workflowType: 'overview',
      confidence: 0.7,
      targetObjectType: inferInventoryObjectType(text),
      reason: 'overview_intent'
    };
  }

  return {
    workflowType: null,
    confidence: 0.2,
    targetObjectType: inferInventoryObjectType(text),
    reason: 'workflow_unresolved'
  };
}

function isObjectInventoryPrompt(prompt = '') {
  return classifyWorkflow(prompt).workflowType === 'object_inventory';
}

module.exports = {
  classifyWorkflow,
  isObjectInventoryPrompt,
  normalizePromptText
};
