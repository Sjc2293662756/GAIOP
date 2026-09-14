/**
 * MetricMappingService.js
 *
 * 负责维护指标描述与指标编码之间的映射关系。
 * 只从 Skill-local `config/metrics-config.yml` 加载合法指标定义。
 * 配置缺失、不可读、不可解析或结构非法时 fail closed，禁止用内置表继续运行。
 *
 * 最近更新：2026-04-15
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const logger = require('../src/utils/logger');
const NodeCache = require('node-cache');

/**
 * 指标映射服务
 * 用于统一管理指标编码、描述、合法性校验和兜底修正。
 */
class MetricMappingService {
  /**
   * 初始化指标映射服务。
   * 启动时严格加载唯一 Metric Catalog，再补充不创建新 ID 的描述别名。
   */
  constructor() {
    /** @type {Map<string, string>} 指标描述 -> 指标编码 */
    this.metricMapping = new Map();
    /** @type {Map<string, object>} 规范化指标描述 -> 指标定义 */
    this.metricDefinitions = new Map();
    /** @type {Set<string>} 所有合法的指标编码集合 */
    this.validMetricCodes = new Set();
    /** @type {NodeCache} 预留缓存实例，供后续扩展使用 */
    this.cache = new NodeCache({ stdTTL: 3600 });

    this.loadMetricsFromConfigFile();
    this.ensureSupplementalMetrics();
  }

  /**
   * 补充少量语义侧会用到的指标描述别名。
   * 只有 Catalog 已声明对应 code 时才注册，不能借别名创建合法指标 ID。
   */
  ensureSupplementalMetrics() {
    const supplementalMetrics = [
      { description: '包流量（流入和流出）', code: 'PKIO' },
      { description: '数据包数量', code: 'PKIO' },
      { description: '数据包个数', code: 'PKIO' }
    ];

    supplementalMetrics.forEach((metric) => {
      if (this.isValidMetricCode(metric.code)) {
        this.addMetric(metric.description, metric.code);
      }
    });
  }

  /**
   * 从唯一 YAML Metric Catalog 加载指标定义。
   */
  loadMetricsFromConfigFile() {
    const configPath = path.join(__dirname, '../config/metrics-config.yml');

    if (!fs.existsSync(configPath)) {
      throw this.createCatalogError(
        'METRIC_CATALOG_NOT_FOUND',
        `Metric Catalog not found: ${configPath}`
      );
    }

    let fileContents;
    try {
      fileContents = fs.readFileSync(configPath, 'utf8');
    } catch (error) {
      throw this.createCatalogError(
        'METRIC_CATALOG_READ_FAILED',
        `Metric Catalog could not be read: ${configPath}`,
        error
      );
    }

    let config;
    try {
      config = yaml.load(fileContents);
    } catch (error) {
      throw this.createCatalogError(
        'METRIC_CATALOG_PARSE_FAILED',
        `Metric Catalog could not be parsed: ${configPath}`,
        error
      );
    }

    const metrics = config?.metrics;
    if (!Array.isArray(metrics) || metrics.length === 0) {
      throw this.createCatalogError(
        'METRIC_CATALOG_INVALID',
        'Metric Catalog must contain a non-empty metrics array.'
      );
    }

    metrics.forEach((metric, index) => {
      const code = String(metric?.code || '').trim();
      const description = String(metric?.description || '').trim();
      if (!code || !description) {
        throw this.createCatalogError(
          'METRIC_CATALOG_INVALID',
          `Metric Catalog entry at index ${index} requires non-empty code and description.`
        );
      }
      this.addMetric(description, code);
    });

    logger.info('Metrics loaded from canonical config file', {
      totalMetrics: this.validMetricCodes.size
    });
  }

  createCatalogError(code, message, cause = null) {
    const error = new Error(message);
    error.code = code;
    if (cause) {
      error.cause = cause;
    }
    return error;
  }

  /**
   * 新增一条指标映射。
   * @param {string} description 指标描述
   * @param {string} code 指标编码
   */
  addMetric(description, code) {
    if (code && description) {
      const normalizedDescription = this.normalizeMetricText(description);
      this.metricMapping.set(normalizedDescription, code);
      this.metricDefinitions.set(normalizedDescription, {
        code,
        description
      });
      this.validMetricCodes.add(code);
    }
  }

  /**
   * 判断指标编码是否合法。
   * @param {string} code 指标编码
   * @returns {boolean}
   */
  isValidMetricCode(code) {
    return this.validMetricCodes.has(code);
  }

  /**
   * 根据指标描述获取指标编码。
   * @param {string} description 指标描述
   * @returns {string|undefined}
   */
  getMetricCode(description) {
    return this.metricMapping.get(this.normalizeMetricText(description));
  }

  /**
   * 根据指标编码反查指标描述。
   * @param {string} code 指标编码
   * @returns {string|null}
   */
  getMetricDescription(code) {
    for (const metric of this.metricDefinitions.values()) {
      if (metric.code === code) {
        return metric.description;
      }
    }
    return null;
  }

  /**
   * 获取全部合法指标编码。
   * @returns {string[]}
   */
  getAllMetricCodes() {
    return Array.from(this.validMetricCodes);
  }

  /**
   * 获取全部指标定义。
   * @returns {{description: string, code: string}[]}
   */
  getAllMetrics() {
    const metrics = [];
    for (const metric of this.metricDefinitions.values()) {
      metrics.push({ description: metric.description, code: metric.code });
    }
    return metrics;
  }

  /**
   * 从查询文本里做最长匹配，找出最可能对应的指标定义。
   */
  findMetricByQueryText(text = '') {
    const normalizedText = this.normalizeMetricText(text);
    if (!normalizedText) {
      return null;
    }

    let best = null;
    for (const [normalizedDescription, metric] of this.metricDefinitions.entries()) {
      if (!normalizedDescription || !normalizedText.includes(normalizedDescription)) {
        continue;
      }

      const candidate = {
        code: metric.code,
        description: metric.description,
        matchLength: normalizedDescription.length
      };

      if (
        !best
        || candidate.matchLength > best.matchLength
        || (candidate.matchLength === best.matchLength && String(candidate.description).length > String(best.description).length)
      ) {
        best = candidate;
      }
    }

    return best;
  }

  /**
   * 统一规范化指标描述文本，便于描述匹配时忽略空格、括号和大小写差异。
   */
  normalizeMetricText(value = '') {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[()（）_-]/g, '');
  }

  /**
   * 校验并修正传入的指标编码串。
   * 如果全部非法，则回退到默认指标 `TPIO`。
   *
   * @param {string} metricsString 逗号分隔的指标编码字符串
   * @returns {string}
   */
  validateAndFixMetrics(metricsString) {
    if (!metricsString) {
      return 'TPIO';
    }

    const metricCodes = metricsString.split(',').map((m) => m.trim());
    const validMetrics = [];

    metricCodes.forEach((code) => {
      logger.info(`Validating metric code: ${code}`, {
        isValid: this.isValidMetricCode(code)
      });

      if (this.isValidMetricCode(code)) {
        validMetrics.push(code);
      }
    });

    if (validMetrics.length === 0) {
      logger.warn('No valid metrics found, using default TPIO');
      return 'TPIO';
    }

    return validMetrics.join(',');
  }
}

module.exports = new MetricMappingService();
