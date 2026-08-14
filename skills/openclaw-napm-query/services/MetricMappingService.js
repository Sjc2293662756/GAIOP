/**
 * MetricMappingService.js
 *
 * 负责维护指标描述与指标编码之间的映射关系。
 * 优先从 `config/metrics-config.yml` 中加载指标定义；
 * 如果配置文件不存在或读取失败，则回退到内置默认指标表。
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
   * 初始化指标映射服务
   * 启动时先尝试加载配置文件，再补充少量运行期别名指标。
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
   * 补充少量配置文件中未显式声明、但语义侧会用到的指标别名。
   */
  ensureSupplementalMetrics() {
    const supplementalMetrics = [
      { description: '包流量（流入和流出）', code: 'PKIO' },
      { description: '数据包数量', code: 'PKIO' },
      { description: '数据包个数', code: 'PKIO' }
    ];

    supplementalMetrics.forEach((metric) => {
      this.addMetric(metric.description, metric.code);
    });
  }

  /**
   * 从 YAML 配置文件加载指标定义。
   */
  loadMetricsFromConfigFile() {
    try {
      const configPath = path.join(__dirname, '../../../config/metrics-config.yml');

      if (fs.existsSync(configPath)) {
        const fileContents = fs.readFileSync(configPath, 'utf8');
        const config = yaml.load(fileContents);

        if (config && config.metrics) {
          config.metrics.forEach((metric) => {
            if (metric.code && metric.description) {
              this.addMetric(metric.description, metric.code);
            }
          });
        }

        logger.info('Metrics loaded from config file', {
          totalMetrics: this.validMetricCodes.size
        });
      } else {
        logger.warn('Metrics config file not found, loading default metrics');
        this.loadDefaultMetrics();
      }
    } catch (error) {
      logger.error('Error loading metrics from config file', { error: error.message });
      this.loadDefaultMetrics();
    }
  }

  /**
   * 加载内置默认指标定义。
   * 这些定义只在配置文件缺失或解析失败时作为兜底使用。
   */
  loadDefaultMetrics() {
    const defaultMetrics = [
      { description: '吞吐量（流入）', code: 'TPI' },
      { description: '吞吐量（流出）', code: 'TPO' },
      { description: '吞吐量（总）', code: 'TPIO' },
      { description: 'HTTP 500错误数', code: 'PGHTTP500' },
      { description: 'HTTP 400错误数', code: 'PGHTTP400' },
      { description: '页面响应时间', code: 'PGTME' },
      { description: '页面数量', code: 'PGNPGE' },
      { description: '连接建立时间（TCP服务器）', code: 'CSTI' },
      { description: '慢页面百分比（客户端）', code: 'PGSLPCTS' },
      { description: '网络响应时间（服务器）', code: 'NRTO' },
      { description: '网络响应时间（客户端）', code: 'NRTI' },
      { description: '页面访问数（服务器）', code: 'PGNPGC' },
      { description: '流量（流入）', code: 'BYTI' },
      { description: '流量（流出）', code: 'BYTO' },
      { description: '流量（流入和流出）', code: 'BYTIO' },
      { description: '丢包情况（流入）', code: 'PLI' },
      { description: '丢包情况（流出）', code: 'PLO' },
      { description: '重传时延（流出）', code: 'RDTO' },
      { description: '有效吞吐（流入）', code: 'GPI' },
      { description: '有效吞吐（流出）', code: 'GPO' },
      { description: '连接请求数（TCP客户端）', code: 'CONO' },
      { description: '连接请求数（TCP服务器）', code: 'CONI' },
      { description: '连接失败数（TCP客户端）', code: 'RFCO' },
      { description: '连接失败数（TCP服务器）', code: 'RFCI' },
      { description: '新建连接数（TCP客户端）', code: 'CCNO' },
      { description: '新建连接数（TCP服务器）', code: 'CCNI' },
      { description: '连接失败率（TCP客户端）', code: 'RFRO' },
      { description: '连接失败率（TCP服务器）', code: 'RFRI' },
      { description: '首字节时间（TCP客户端）', code: 'T2FBI' },
      { description: '首字节时间（TCP服务器）', code: 'T2FBO' },
      { description: '事务数（客户端）', code: 'TRNO' },
      { description: '事务数（服务器）', code: 'TRNI' },
      { description: '包吞吐量（流入）', code: 'PKTI' },
      { description: '包吞吐量（流出）', code: 'PKTO' },
      { description: '包流量', code: 'PKIO' },
      { description: '净荷（客户端）', code: 'FSI_B' },
      { description: '净荷（服务器）', code: 'FSO_B' },
      { description: '数据包净荷（客户端）', code: 'FSI_P' },
      { description: '数据包净荷（服务器）', code: 'FSO_P' },
      { description: '页面访问率', code: 'PGRT' },
      { description: '慢页面率（客户端）', code: 'PGSLRTS' },
      { description: 'HTTP 200数量', code: 'PGHTTP200' }
    ];

    defaultMetrics.forEach((metric) => {
      this.addMetric(metric.description, metric.code);
    });

    logger.info('Default metrics loaded', {
      totalMetrics: this.validMetricCodes.size
    });
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
