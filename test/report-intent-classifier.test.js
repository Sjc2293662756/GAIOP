'use strict';

const {
  REPORT_INTENTS,
  classifyReportPrompt,
  isAutomaticReportIntent,
  isReportWorkflowIntent
} = require('../plugin/ReportIntentClassifier');

describe('ReportIntentClassifier', () => {
  test.each([
    ['给我最近七天的系统巡检报告！', REPORT_INTENTS.INSPECTION],
    ['生成一份系统巡检报告', REPORT_INTENTS.INSPECTION],
    ['生成健康检查报告', REPORT_INTENTS.INSPECTION],
    ['create an inspection report', REPORT_INTENTS.INSPECTION],
    ['给我最近七天的系统综述报告！', REPORT_INTENTS.SUMMARY],
    ['生成一份本周周报', REPORT_INTENTS.SUMMARY],
    ['生成最近七天的报告', REPORT_INTENTS.SUMMARY],
    ['生成回溯238web的单个业务分析报告', REPORT_INTENTS.SUMMARY],
    ['生成HTTPS的单个应用分析报告', REPORT_INTENTS.SUMMARY],
    ['将以上巡检结果导出为 Word', REPORT_INTENTS.EXPORT],
    ['先巡检再生成综述报告', REPORT_INTENTS.MIXED],
    ['先巡检再生成故障诊断报告', REPORT_INTENTS.MIXED],
    ['生成回溯238web的业务故障分析报告', REPORT_INTENTS.NONE],
    ['生成HTTPS的应用故障分析报告', REPORT_INTENTS.NONE],
    ['生成最近七天239web的故障诊断报告', REPORT_INTENTS.NONE],
    ['最近七天流量趋势怎么样', REPORT_INTENTS.NONE]
  ])('classifies %s as %s', (prompt, expected) => {
    expect(classifyReportPrompt(prompt)).toBe(expected);
  });

  test('exposes automatic and workflow intent boundaries', () => {
    expect(isAutomaticReportIntent(REPORT_INTENTS.INSPECTION)).toBe(true);
    expect(isAutomaticReportIntent(REPORT_INTENTS.SUMMARY)).toBe(true);
    expect(isAutomaticReportIntent(REPORT_INTENTS.MIXED)).toBe(false);
    expect(isReportWorkflowIntent(REPORT_INTENTS.MIXED)).toBe(true);
    expect(isReportWorkflowIntent(REPORT_INTENTS.EXPORT)).toBe(false);
  });
});
