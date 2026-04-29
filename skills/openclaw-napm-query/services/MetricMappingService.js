/**
 * MetricMappingService.js
 * 
 * 鎻忚堪锛氭寚鏍囨槧灏勬湇鍔℃ā鍧? * 鍔熻兘锛氱鐞嗘寚鏍囨弿杩颁笌鎸囨爣浠ｇ爜涔嬮棿鐨勬槧灏勫叧绯伙紝鏀寔浠庨厤缃枃浠跺姞杞藉拰榛樿鎸囨爣鍔犺浇
 *       鎻愪緵鎸囨爣楠岃瘉銆佹煡璇㈠拰淇鍔熻兘
 * 浣滆€咃細绯荤粺鐢熸垚
 * 淇敼鏃ユ湡锛?026-04-15
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const logger = require('../../../src/utils/logger');
const NodeCache = require('node-cache');

/**
 * 鎸囨爣鏄犲皠鏈嶅姟绫? * 璐熻矗鎸囨爣鎻忚堪涓庢寚鏍囦唬鐮佺殑鍙屽悜鏄犲皠绠＄悊
 */
class MetricMappingService {
  /**
   * 鏋勯€犲嚱鏁?   * 鍒濆鍖栨寚鏍囨槧灏勬暟鎹粨鏋勫苟鍔犺浇鎸囨爣閰嶇疆
   */
  constructor() {
    /** @type {Map<string, string>} 鎸囨爣鎻忚堪鍒版寚鏍囦唬鐮佺殑鏄犲皠 */
    this.metricMapping = new Map();
    /** @type {Set<string>} 鏈夋晥鐨勬寚鏍囦唬鐮侀泦鍚?*/
    this.validMetricCodes = new Set();
    /** @type {NodeCache} 缂撳瓨瀹炰緥锛岀敤浜庣紦瀛樻寚鏍囨暟鎹?*/
    this.cache = new NodeCache({ stdTTL: 3600 });
    
    // 鍔犺浇鎸囨爣閰嶇疆
    this.loadMetricsFromConfigFile();
    this.ensureSupplementalMetrics();
  }

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
   * 浠庨厤缃枃浠跺姞杞芥寚鏍?   * 浼樺厛浠?YAML 閰嶇疆鏂囦欢鍔犺浇锛屽け璐ュ垯浣跨敤榛樿鎸囨爣
   */
  loadMetricsFromConfigFile() {
    try {
      const configPath = path.join(__dirname, '../../../config/metrics-config.yml');
      
      if (fs.existsSync(configPath)) {
        const fileContents = fs.readFileSync(configPath, 'utf8');
        const config = yaml.load(fileContents);
        
        if (config && config.metrics) {
          config.metrics.forEach(metric => {
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
   * 鍔犺浇榛樿鎸囨爣
   * 褰撻厤缃枃浠朵笉瀛樺湪鎴栧姞杞藉け璐ユ椂浣跨敤鐨勫唴缃寚鏍囧垪琛?   */
  loadDefaultMetrics() {
    const defaultMetrics = [
      { description: '鍚炲悙閲?鍏ョ珯)', code: 'TPI' },
      { description: '鍚炲悙閲?鍑虹珯)', code: 'TPO' },
      { description: '鍚炲悙閲?鎬?', code: 'TPIO' },
      { description: 'HTTP 500閿欒', code: 'PGHTTP500' },
      { description: 'HTTP 400閿欒', code: 'PGHTTP400' },
      { description: '鍝嶅簲鏃堕棿', code: 'PGTME' },
      { description: '椤甸潰鏁伴噺', code: 'PGNPGE' },
      { description: 'Connection setup time (TCP server)', code: 'CSTI' },
      { description: 'Slow page percent (client)', code: 'PGSLPCTS' },
      { description: 'Network response time out (server)', code: 'NRTO' },
      { description: 'Network response time in (client)', code: 'NRTI' },
      { description: '椤甸潰璁块棶鏁帮紙鏈嶅姟鍣級', code: 'PGNPGC' },
      { description: '娴侀噺锛堟祦鍏ワ級', code: 'BYTI' },
      { description: '娴侀噺锛堟祦鍑猴級', code: 'BYTO' },
      { description: 'Traffic in/out total', code: 'BYTIO' },
      { description: '涓㈠寘鎯呭喌 (娴佸叆)', code: 'PLI' },
      { description: '涓㈠寘鎯呭喌 (娴佸嚭)', code: 'PLO' },
      { description: '閲嶄紶鏃跺欢锛堟祦鍑猴級', code: 'RDTO' },
      { description: '鏈夋晥鍚炲悙 (娴佸叆)', code: 'GPI' },
      { description: '鏈夋晥鍚炲悙 (娴佸嚭)', code: 'GPO' },
      { description: '杩炴帴璇锋眰鏁?(TCP 瀹㈡埛绔?', code: 'CONO' },
      { description: '杩炴帴璇锋眰鏁?(TCP 鏈嶅姟鍣?', code: 'CONI' },
      { description: 'Connection failure count (TCP client)', code: 'RFCO' },
      { description: 'Connection failure count (TCP server)', code: 'RFCI' },
      { description: 'New connection count (TCP client)', code: 'CCNO' },
      { description: 'New connection count (TCP server)', code: 'CCNI' },
      { description: '杩炴帴澶辫触鐜?(TCP 瀹㈡埛绔?', code: 'RFRO' },
      { description: '杩炴帴澶辫触鐜?(TCP 鏈嶅姟鍣?', code: 'RFRI' },
      { description: '绗竴瀛楄妭鏃堕棿锛圱CP 瀹㈡埛绔級', code: 'T2FBI' },
      { description: '绗竴瀛楄妭鏃堕棿锛圱CP 鏈嶅姟鍣級', code: 'T2FBO' },
      { description: '浜や簰鏁帮紙瀹㈡埛绔級', code: 'TRNO' },
      { description: '浜や簰鏁帮紙鏈嶅姟鍣級', code: 'TRNI' },
      { description: '鍖呭悶鍚愰噺锛堟祦鍏ワ級', code: 'PKTI' },
      { description: '鍖呭悶鍚愰噺锛堟祦鍑猴級', code: 'PKTO' },
      { description: 'Packet traffic in/out total', code: 'PKIO' },
      { description: '鍑€鑽凤紙瀹㈡埛绔級', code: 'FSI_B' },
      { description: '鍑€鑽凤紙鏈嶅姟鍣級', code: 'FSO_B' },
      { description: '鏁版嵁鍖呭噣鑽凤紙瀹㈡埛绔級', code: 'FSI_P' },
      { description: '鏁版嵁鍖呭噣鑽凤紙鏈嶅姟鍣級', code: 'FSO_P' },
      { description: 'Page visit rate', code: 'PGRT' },
      { description: 'Slow page rate (client)', code: 'PGSLRTS' },
      { description: 'HTTP 200 鏁伴噺', code: 'PGHTTP200' }
    ];

    defaultMetrics.forEach(metric => {
      this.addMetric(metric.description, metric.code);
    });

    logger.info('Default metrics loaded', {
      totalMetrics: this.validMetricCodes.size
    });
  }

  /**
   * 娣诲姞鎸囨爣鍒版槧灏?   * @param {string} description - 鎸囨爣鎻忚堪
   * @param {string} code - 鎸囨爣浠ｇ爜
   */
  addMetric(description, code) {
    if (code && description) {
      this.metricMapping.set(description.toLowerCase(), code);
      this.validMetricCodes.add(code);
    }
  }

  /**
   * 楠岃瘉鎸囨爣浠ｇ爜鏄惁鏈夋晥
   * @param {string} code - 鎸囨爣浠ｇ爜
   * @returns {boolean} - 鏄惁涓烘湁鏁堟寚鏍囦唬鐮?   */
  isValidMetricCode(code) {
    return this.validMetricCodes.has(code);
  }

  /**
   * 鏍规嵁鎻忚堪鑾峰彇鎸囨爣浠ｇ爜
   * @param {string} description - 鎸囨爣鎻忚堪
   * @returns {string|undefined} - 鎸囨爣浠ｇ爜
   */
  getMetricCode(description) {
    return this.metricMapping.get(description.toLowerCase());
  }

  /**
   * 鏍规嵁鎸囨爣浠ｇ爜鑾峰彇鎻忚堪
   * @param {string} code - 鎸囨爣浠ｇ爜
   * @returns {string|null} - 鎸囨爣鎻忚堪锛屾湭鎵惧埌杩斿洖 null
   */
  getMetricDescription(code) {
    for (const [desc, metricCode] of this.metricMapping.entries()) {
      if (metricCode === code) {
        return desc;
      }
    }
    return null;
  }

  /**
   * 鑾峰彇鎵€鏈夋湁鏁堢殑鎸囨爣浠ｇ爜
   * @returns {array} - 鎸囨爣浠ｇ爜鏁扮粍
   */
  getAllMetricCodes() {
    return Array.from(this.validMetricCodes);
  }

  /**
   * 鑾峰彇鎵€鏈夋寚鏍囨槧灏?   * @returns {array} - 鍖呭惈鎻忚堪鍜屼唬鐮佺殑瀵硅薄鏁扮粍
   */
  getAllMetrics() {
    const metrics = [];
    for (const [description, code] of this.metricMapping.entries()) {
      metrics.push({ description, code });
    }
    return metrics;
  }

  /**
   * 楠岃瘉骞朵慨澶嶆寚鏍囧瓧绗︿覆
   * 杩囨护鏃犳晥鎸囨爣锛岃嫢鏃犳湁鏁堟寚鏍囧垯杩斿洖榛樿鍊?TPIO
   * @param {string} metricsString - 閫楀彿鍒嗛殧鐨勬寚鏍囦唬鐮佸瓧绗︿覆
   * @returns {string} - 楠岃瘉鍚庣殑鎸囨爣浠ｇ爜瀛楃涓?   */
  validateAndFixMetrics(metricsString) {
    if (!metricsString) {
      return 'TPIO';
    }

    const metricCodes = metricsString.split(',').map(m => m.trim());
    const validMetrics = [];

    metricCodes.forEach(code => {
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

