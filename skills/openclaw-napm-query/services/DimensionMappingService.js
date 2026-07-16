/**
 * DimensionMappingService.js
 *
 * 负责维护对象维度、指标域和指标兼容对象之间的静态映射关系。
 * 这个服务本身不访问上游，只对常量表做统一封装，供语义约束和兼容性判断复用。
 */

const { OBJECT_DIMENSIONS } = require('../src/constants/objectDimensions');
const {
  METRIC_DOMAINS,
  METRIC_META,
  getDomainForMetric,
  getDomainMeta,
  getObjectsForMetric,
  getPreferredObjectsForMetric
} = require('../src/constants/metricDomains');
const MetricMappingService = require('./MetricMappingService');

/**
 * 维度映射服务类
 * 负责统一读取对象维度与指标域元数据，并提供常用查询接口。
 */
class DimensionMappingService {
  /**
   * 获取所有对象维度
   * @returns {array} - 对象维度列表
   */
  getObjectDimensions() {
    return OBJECT_DIMENSIONS;
  }

  /**
   * 获取当前技能支持的对象维度
   * @returns {array} - 支持的对象维度列表
   */
  getSupportedObjectDimensions() {
    return OBJECT_DIMENSIONS.filter(item => item.supportedByCurrentSkill);
  }

  /**
   * 根据键获取对象维度
   * @param {string} key - 维度键
   * @returns {object|null} - 对象维度信息，未找到返回 null
   */
  getObjectDimension(key) {
    return OBJECT_DIMENSIONS.find(item => item.key === key) || null;
  }

  /**
   * 获取所有指标域
   * @returns {array} - 指标域列表
   */
  getMetricDomains() {
    return METRIC_DOMAINS;
  }

  /**
   * 根据指标 ID 获取所属的指标域
   * @param {string} metricId - 指标 ID
   * @returns {string|null} - 指标域 ID，未找到返回 null
   */
  getMetricDomain(metricId) {
    return getDomainForMetric(metricId)?.id || null;
  }

  /**
   * 获取指标域的元数据
   * @param {string} domainId - 指标域 ID
   * @returns {object|null} - 指标域元数据，未找到返回 null
   */
  getDomainMeta(domainId) {
    return getDomainMeta(domainId);
  }

  /**
   * 获取指定指标兼容的对象维度列表
   * @param {string} metricId - 指标 ID
   * @param {object} options - 选项
   * @param {boolean} options.onlySupportedByCurrentSkill - 是否只返回当前技能支持的维度
   * @returns {array} - 兼容的对象维度列表
   */
  getObjectsForMetric(metricId, options = {}) {
    const objects = getObjectsForMetric(metricId);
    if (options.onlySupportedByCurrentSkill) {
      const supportedKeys = new Set(this.getSupportedObjectDimensions().map(item => item.key));
      return objects.filter(item => supportedKeys.has(item));
    }

    return objects;
  }

  /**
   * 获取指定指标的首选对象维度列表
   * @param {string} metricId - 指标 ID
   * @returns {array} - 首选对象维度列表
   */
  getPreferredObjectsForMetric(metricId) {
    return getPreferredObjectsForMetric(metricId);
  }

  /**
   * 获取指标的元数据
   * @param {string} metricId - 指标 ID
   * @returns {object|null} - 指标元数据，未找到返回 null
   */
  getMetricMeta(metricId) {
    return METRIC_META[metricId] || null;
  }

  /**
   * 获取所有指标的对象映射信息
   * @returns {array} - 指标对象映射列表
   */
  getMetricObjectMappings() {
    const metrics = MetricMappingService.getAllMetrics();
    return metrics.map(metric => {
      const domain = this.getMetricDomain(metric.code);
      const domainMeta = this.getDomainMeta(domain);
      const compatibility = this.getObjectsForMetric(metric.code, {
        onlySupportedByCurrentSkill: true
      });
      const meta = this.getMetricMeta(metric.code) || {};

      return {
        metricId: metric.code,
        metricLabel: meta.label || metric.description,
        unit: meta.unit || null,
        domainId: domain,
        domainLabel: domainMeta ? domainMeta.label : null,
        compatibleObjects: compatibility
      };
    });
  }
}

module.exports = new DimensionMappingService();
