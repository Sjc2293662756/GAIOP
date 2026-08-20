'use strict';

const REPORT_INTENTS = Object.freeze({
  INSPECTION: 'inspection',
  SUMMARY: 'summary',
  EXPORT: 'export',
  MIXED: 'mixed',
  NONE: 'none'
});

const INSPECTION_PATTERN = /(?:巡检(?:报告)?|健康(?:检查|巡检)(?:报告)?|inspection(?:\s+report)?|health\s*check(?:\s+report)?)/i;
const SUMMARY_PATTERN = /(?:综述报告|全局综述|业务综述|应用综述|业务组综述|网络综述|告警综述|summary\s*report|overview\s*report)/i;
const PERIODIC_SUMMARY_PATTERN = /(?:日报|周报|月报)/i;
const OTHER_REPORT_PATTERN = /(?:故障(?:诊断|分析)?报告|诊断报告|数据包分析报告|抓包分析报告)/i;
const REPORT_PATTERN = /(?:报告|报表|report)/i;
const TIME_CONTEXT_PATTERN = /(?:最近|近\s*\d+|过去|今天|昨天|本周|本月|近一|近两|近三)/i;
const EXPORT_REFERENCE_PATTERN = /(?:以上|上述|刚才|前面|这个|该)(?:的)?(?:查询|分析|结果|报告|巡检结果|综述结果)?/i;
const EXPORT_ACTION_PATTERN = /(?:导出|生成|整理成|输出|转换成|转成|以)\s*(?:为|成)?\s*(?:Word|docx|PDF|文档|文件)/i;

function classifyReportPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return REPORT_INTENTS.NONE;
  }

  const inspection = INSPECTION_PATTERN.test(text);
  const summary = SUMMARY_PATTERN.test(text) || PERIODIC_SUMMARY_PATTERN.test(text);
  const otherReport = OTHER_REPORT_PATTERN.test(text);
  const exportFollowUp = EXPORT_REFERENCE_PATTERN.test(text) && EXPORT_ACTION_PATTERN.test(text);

  if ((inspection && summary) || ((inspection || summary) && otherReport)) {
    return REPORT_INTENTS.MIXED;
  }
  if (exportFollowUp) {
    return REPORT_INTENTS.EXPORT;
  }
  if (inspection) {
    return REPORT_INTENTS.INSPECTION;
  }
  if (summary) {
    return REPORT_INTENTS.SUMMARY;
  }
  if (otherReport) {
    return REPORT_INTENTS.NONE;
  }
  if (REPORT_PATTERN.test(text) && TIME_CONTEXT_PATTERN.test(text)) {
    return REPORT_INTENTS.SUMMARY;
  }
  return REPORT_INTENTS.NONE;
}

function isAutomaticReportIntent(intent = '') {
  return intent === REPORT_INTENTS.INSPECTION || intent === REPORT_INTENTS.SUMMARY;
}

function isReportWorkflowIntent(intent = '') {
  return isAutomaticReportIntent(intent) || intent === REPORT_INTENTS.MIXED;
}

module.exports = {
  REPORT_INTENTS,
  classifyReportPrompt,
  isAutomaticReportIntent,
  isReportWorkflowIntent
};
