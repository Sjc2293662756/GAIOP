/**
 * MetricDomainStrategyService.js
 * 
 * 说明：指标域策略服务模块
 * 功能：根据指标域（如网络、连接、应用、Web）加载对应的策略配置，构建排名分析、诊断分析和比较分析
 *       支持通过执行状态、语义解析结果、指标名称等多种方式解析指标域
 * 作者：系统生成
 * 修改日期：2026-04-15
 */

const fs = require('fs');
const path = require('path');

const DimensionMappingService = require('./DimensionMappingService');

/**
 * 指标域策略服务类
 * 根据指标域智能选择并构建对应的分析策略方案
 */
class MetricDomainStrategyService {
  /**
   * 构造函数
   * 加载指标域策略配置文件
   */
  constructor() {
    const configPath = path.join(__dirname, '../../../config/metric-domain-strategies.v1.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    this.config = parsed || {};
    this.domainAliases = parsed?.domainAliases && typeof parsed.domainAliases === 'object'
      ? parsed.domainAliases
      : {};
    this.domains = parsed?.domains && typeof parsed.domains === 'object'
      ? parsed.domains
      : {};
  }

  /**
   * 解析指标域
   * 按照优先级从执行状态、语义解析结果、指标名称中提取指标域
   * @param {object} executionState - 执行状态对象
   * @param {object} resolvedQuery - 解析后的查询对象
   * @returns {string|null} - 解析出的指标域键，未找到返回 null
   */
  resolveMetricDomain(executionState = null, resolvedQuery = null) {
    const stateDomain = this.normalizeDomainKey(executionState?.metricDomainHint || null);
    if (stateDomain) {
      return stateDomain;
    }

    const semanticDomain = this.normalizeDomainKey(
      resolvedQuery?.metricSemantic?.metricDomain || resolvedQuery?.metricDomain || null
    );
    if (semanticDomain) {
      return semanticDomain;
    }

    const metrics = Array.isArray(resolvedQuery?.metrics) && resolvedQuery.metrics.length > 0
      ? resolvedQuery.metrics
      : (resolvedQuery?.metric ? [resolvedQuery.metric] : []);
    for (const metric of metrics) {
      const lowLevelDomain = DimensionMappingService.getMetricDomain(metric);
      const normalized = this.normalizeDomainKey(lowLevelDomain);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  /**
   * 获取指定指标域的策略配置
   * @param {string} domainKey - 指标域键
   * @returns {object|null} - 策略配置对象，未找到返回 null
   */
  getDomainStrategy(domainKey) {
    const normalized = this.normalizeDomainKey(domainKey);
    return normalized ? this.domains[normalized] || null : null;
  }

  
  /**
   * 构建比较计划
   */
  buildComparePlan(executionState = null, resolvedQuery = null) {
    const domainKey = this.resolveMetricDomain(executionState, resolvedQuery);
    const strategy = this.getDomainStrategy(domainKey);
    const compare = strategy?.compare || null;
    if (!domainKey || !compare) {
      return null;
    }

    const baseline = executionState?.compareBaselineKey
      || resolvedQuery?.compareBaselineKey
      || compare.baseline
      || 'yesterday_same_window';
    const explicitMetrics = Array.isArray(resolvedQuery?.metrics) && resolvedQuery.metrics.length > 0
      ? resolvedQuery.metrics.filter(Boolean)
      : (resolvedQuery?.metric ? [resolvedQuery.metric] : []);

    return {
      objectType: 'ComparePlan',
      key: `domain-compare-${domainKey}`,
      responseType: compare.responseType || 'compare',
      metricDomain: domainKey,
      domainLabel: strategy?.label || domainKey,
      baseline,
      scopeKey: executionState?.compareScopeKey || null,
      titleKey: executionState?.compareTitleKey || executionState?.compareScopeKey || null,
      focusMetrics: explicitMetrics.length > 0
        ? explicitMetrics
        : (Array.isArray(compare.focusMetrics) ? compare.focusMetrics : []),
      nextActions: Array.isArray(compare.nextActions) ? compare.nextActions : []
    };
  }

  /**
   * 规范化指标域键
   * 支持别名映射和大小写不敏感匹配
   * @param {string} domainKey - 原始指标域键
   * @returns {string|null} - 规范化后的指标域键，无效返回 null
   */
  normalizeDomainKey(domainKey) {
    const raw = String(domainKey || '').trim();
    if (!raw) {
      return null;
    }

    // 精确匹配
    if (this.domains[raw]) {
      return raw;
    }

    // 别名匹配
    const alias = this.domainAliases[raw] || this.domainAliases[raw.toLowerCase()] || null;
    if (alias && this.domains[alias]) {
      return alias;
    }

    // 大小写不敏感匹配
    const matched = Object.keys(this.domains).find((item) => item.toLowerCase() === raw.toLowerCase());
    return matched || null;
  }
}

module.exports = new MetricDomainStrategyService();


