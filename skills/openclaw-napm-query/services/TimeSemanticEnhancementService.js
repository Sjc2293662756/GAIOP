/**
 * TimeSemanticEnhancementService.js
 * 
 * 鏃堕棿璇箟澧炲己鏈嶅姟
 * 
 * 璐熻矗浠庣敤鎴锋煡璇㈡枃鏈腑瑙ｆ瀽鏃堕棿鑼冨洿鍜屾椂闂寸矑搴︿俊鎭紝
 * 骞跺皢鍏跺簲鐢ㄥ埌鏌ヨ瀵硅薄涓€? * 
 * 淇敼鏃ユ湡锛?026-04-16
 */
const fs = require('fs');
const path = require('path');

const TimeUtils = require('../../../src/utils/TimeUtils');

/**
 * TimeSemanticEnhancementService 绫? * 浠庣敤鎴锋煡璇㈡枃鏈腑鎻愬彇鍜屽寮烘椂闂磋涔変俊鎭? */
class TimeSemanticEnhancementService {
  /**
   * 鏋勯€犲嚱鏁?   * 
   * 鍔犺浇鏃堕棿璇箟澧炲己閰嶇疆
   */
  constructor() {
    const configPath = path.join(__dirname, '../../../config/time-semantic-enhancement.v1.json');
    this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  /**
   * 澧炲己鏌ヨ鐨勬椂闂磋涔?   * 
   * 瑙ｆ瀽鏃堕棿鑼冨洿鍜屾椂闂寸矑搴︼紝骞跺皢鍏跺簲鐢ㄥ埌鏌ヨ瀵硅薄涓€?   * 
   * @param {object} query - 鏌ヨ瀵硅薄
   * @param {string} originalText - 鍘熷鏂囨湰
   * @returns {object} - 澧炲己鍚庣殑缁撴灉瀵硅薄
   */
  async enhance(query, originalText = '') {
    const resolvedQuery = this.cloneQuery(query);
    const warnings = [];
    const corrections = [];
    const text = this.normalizeText(originalText);

    const timeRange = this.resolveTimeRange(text);
    if (resolvedQuery) {
      resolvedQuery.start = timeRange.start;
      resolvedQuery.end = timeRange.end;
      corrections.push({
        field: 'timeRange',
        action: timeRange.source === 'default' ? 'apply_default_time_range' : 'normalize_time_range',
        to: {
          key: timeRange.key,
          start: timeRange.start,
          end: timeRange.end
        }
      });
    }

    let granularity = null;
    if (resolvedQuery?.service === 'timeValues') {
      granularity = this.resolveGranularity(text, timeRange);
      if (granularity) {
        resolvedQuery.granularity = granularity.value;
        corrections.push({
          field: 'granularity',
          action: granularity.source === 'explicit' ? 'apply_explicit_granularity' : 'derive_granularity_from_span',
          to: granularity.value
        });
      }
    } else if (resolvedQuery?.granularity) {
      delete resolvedQuery.granularity;
      corrections.push({
        field: 'granularity',
        action: 'remove_granularity_for_non_time_service',
        to: null
      });
    }

    return {
      query: resolvedQuery,
      warnings,
      corrections,
      evidence: {
        timeRange,
        granularity
      }
    };
  }

  /**
   * 瑙ｆ瀽鏃堕棿鑼冨洿
   * 
   * 鎸変紭鍏堢骇浠庢枃鏈腑瑙ｆ瀽鏃堕棿鑼冨洿锛氬懡鍚嶈寖鍥?> 鐩稿鑼冨洿 > 榛樿鑼冨洿
   * 
   * @param {object} text - 鏂囨湰涓婁笅鏂?   * @returns {object} - 鏃堕棿鑼冨洿瀵硅薄
   */
  resolveTimeRange(text) {
    for (const item of this.config.namedRanges) {
      if (item.aliases.some(alias => text.lower.includes(String(alias).toLowerCase()))) {
        return {
          key: item.key,
          ...this.mapNamedRange(item.key),
          source: 'named'
        };
      }
    }

    const relative = this.resolveRelativeRange(text.raw);
    if (relative) {
      return {
        ...relative,
        source: 'relative'
      };
    }

    return {
      key: this.config.defaults.timeRangeKey,
      ...this.mapNamedRange(this.config.defaults.timeRangeKey),
      source: 'default'
    };
  }

  /**
   * 瑙ｆ瀽鐩稿鏃堕棿鑼冨洿
   * 
   * 浠庢枃鏈腑鎻愬彇鐩稿鏃堕棿鑼冨洿锛堝"鏈€杩?0鍒嗛挓"銆?杩囧幓2灏忔椂"绛夛級
   * 
   * @param {string} rawText - 鍘熷鏂囨湰
   * @returns {object|null} - 鐩稿鏃堕棿鑼冨洿瀵硅薄鎴杗ull
   */
  resolveRelativeRange(rawText) {
    for (const pattern of this.config.relativePatterns.minutes || []) {
      const match = rawText.match(new RegExp(pattern, 'i'));
      if (match) {
        const minutes = Number(match[1]);
        if (Number.isFinite(minutes) && minutes > 0) {
          return this.buildRelativeRange(`last${minutes}minutes`, minutes * 60);
        }
      }
    }

    for (const pattern of this.config.relativePatterns.hours || []) {
      const match = rawText.match(new RegExp(pattern, 'i'));
      if (match) {
        const hours = Number(match[1]);
        if (Number.isFinite(hours) && hours > 0) {
          return this.buildRelativeRange(`last${hours}hours`, hours * 3600);
        }
      }
    }

    for (const pattern of this.config.relativePatterns.days || []) {
      const match = rawText.match(new RegExp(pattern, 'i'));
      if (match) {
        const days = Number(match[1]);
        if (Number.isFinite(days) && days > 0) {
          return this.buildRelativeRange(`last${days}days`, days * 86400);
        }
      }
    }

    return null;
  }

  /**
   * 鏋勫缓鐩稿鏃堕棿鑼冨洿
   * 
   * @param {string} key - 鏃堕棿鑼冨洿閿?   * @param {number} seconds - 绉掓暟
   * @returns {object} - 鏃堕棿鑼冨洿瀵硅薄
   */
  buildRelativeRange(key, seconds) {
    return {
      key,
      ...TimeUtils.getRelativeRange(seconds)
    };
  }

  /**
   * 鏄犲皠鍛藉悕鏃堕棿鑼冨洿
   * 
   * @param {string} key - 鏃堕棿鑼冨洿閿?   * @returns {object} - 鏃堕棿鑼冨洿瀵硅薄
   */
  mapNamedRange(key) {
    if (key === 'today') {
      return TimeUtils.parseTimeRange('today');
    }

    if (key === 'yesterday') {
      return TimeUtils.parseTimeRange('yesterday');
    }

    if (key === 'last7days') {
      return TimeUtils.parseTimeRange('last7days');
    }

    if (key === 'last30days') {
      return TimeUtils.parseTimeRange('last30days');
    }

    if (key === 'last24hours') {
      return this.buildRelativeRange('last24hours', 24 * 3600);
    }

    return this.buildRelativeRange('last1hour', 3600);
  }

  /**
   * 瑙ｆ瀽鏃堕棿绮掑害
   * 
   * 浼樺厛浠庢枃鏈腑鎻愬彇鏄惧紡绮掑害锛屽惁鍒欐牴鎹椂闂磋法搴︽帹瀵肩矑搴?   * 
   * @param {object} text - 鏂囨湰涓婁笅鏂?   * @param {object} timeRange - 鏃堕棿鑼冨洿
   * @returns {object} - 绮掑害瀵硅薄
   */
  resolveGranularity(text, timeRange) {
    const explicit = this.resolveExplicitGranularity(text.raw);
    if (explicit) {
      return {
        value: explicit,
        source: 'explicit'
      };
    }

    const span = Number(timeRange.end) - Number(timeRange.start);
    const rule = this.config.granularityRules.find(item => span <= item.maxSpanSeconds);
    return {
      value: rule ? rule.granularity : 3600,
      source: 'derived'
    };
  }

  /**
   * 瑙ｆ瀽鏄惧紡鏃堕棿绮掑害
   * 
   * 浠庢枃鏈腑鎻愬彇鏄惧紡鎸囧畾鐨勬椂闂寸矑搴?   * 
   * @param {string} rawText - 鍘熷鏂囨湰
   * @returns {number|null} - 绮掑害鍊硷紙绉掞級鎴杗ull
   */
  resolveExplicitGranularity(rawText) {
    for (const pattern of this.config.granularityPatterns.seconds || []) {
      const match = rawText.match(new RegExp(pattern, 'i'));
      if (match) {
        return Number(match[1]);
      }
    }

    for (const pattern of this.config.granularityPatterns.minutes || []) {
      const match = rawText.match(new RegExp(pattern, 'i'));
      if (match) {
        return Number(match[1]) * 60;
      }
    }

    for (const pattern of this.config.granularityPatterns.hours || []) {
      const match = rawText.match(new RegExp(pattern, 'i'));
      if (match) {
        return Number(match[1]) * 3600;
      }
    }

    return null;
  }

  /**
   * 瑙勮寖鍖栨枃鏈?   * 
   * @param {string} input - 杈撳叆鏂囨湰
   * @returns {object} - 瑙勮寖鍖栧悗鐨勬枃鏈笂涓嬫枃
   */
  normalizeText(input) {
    const raw = String(input || '').trim();
    const normalized = raw.replace(/\s+/g, ' ');
    const lower = normalized.toLowerCase();
    return { raw, normalized, lower };
  }

  /**
   * 娣辨嫹璐濇煡璇㈠璞?   * 
   * @param {object} query - 鏌ヨ瀵硅薄
   * @returns {object} - 鎷疯礉鍚庣殑鏌ヨ瀵硅薄
   */
  cloneQuery(query) {
    return query ? JSON.parse(JSON.stringify(query)) : query;
  }
}

module.exports = new TimeSemanticEnhancementService();

