/**
 * TimeResolveService.js
 * 
 * 鏃堕棿瑙ｆ瀽鏈嶅姟
 * 
 * 璐熻矗浠庢椂闂磋涔夊寮虹粨鏋滃拰瑙ｆ瀽鍚庣殑鏌ヨ涓彁鍙栨椂闂磋寖鍥村拰鏃堕棿绮掑害淇℃伅銆? * 
 * 淇敼鏃ユ湡锛?026-04-16
 */

/**
 * TimeResolveService 绫? * 瑙ｆ瀽鏃堕棿鐩稿叧淇℃伅
 */
class TimeResolveService {
  /**
   * 娣辨嫹璐濆璞?   * 
   * @param {any} value - 瑕佹嫹璐濈殑鍊?   * @returns {any} - 鎷疯礉鍚庣殑鍊?   */
  clone(value) {
    return value && typeof value === 'object'
      ? JSON.parse(JSON.stringify(value))
      : value;
  }

  /**
   * 瑙ｆ瀽鏃堕棿淇℃伅
   * 
   * 浠庢椂闂磋涔夊寮虹粨鏋滃拰瑙ｆ瀽鍚庣殑鏌ヨ涓彁鍙栨椂闂磋寖鍥村拰鏃堕棿绮掑害淇℃伅锛?   * 鏋勫缓鏍囧噯鍖栫殑鏃堕棿瑙ｆ瀽缁撴灉銆?   * 
   * @param {object} input - 杈撳叆瀵硅薄
   * @param {object} input.timeSemanticEnhancement - 鏃堕棿璇箟澧炲己缁撴灉
   * @param {object} input.resolvedQuery - 瑙ｆ瀽鍚庣殑鏌ヨ瀵硅薄
   * @returns {object} - 鏃堕棿瑙ｆ瀽缁撴灉瀵硅薄
   */
  resolve(input = {}) {
    const timeSemanticEnhancement = input.timeSemanticEnhancement || null;
    const resolvedQuery = input.resolvedQuery || null;
    const timeRange = timeSemanticEnhancement?.evidence?.timeRange || null;
    const granularity = timeSemanticEnhancement?.evidence?.granularity || null;

    return {
      version: 'v1',
      stage: 'time_resolve',
      status: timeSemanticEnhancement ? 'resolved' : 'unavailable',
      time_range: {
        key: timeRange?.key || resolvedQuery?.timeRangeKey || null,
        start: resolvedQuery?.start || timeRange?.start || null,
        end: resolvedQuery?.end || timeRange?.end || null,
        source: timeRange?.source || null
      },
      granularity: {
        value: resolvedQuery?.granularity || granularity?.value || null,
        source: granularity?.source || null
      },
      corrections: this.clone(timeSemanticEnhancement?.corrections || []),
      warnings: this.clone(timeSemanticEnhancement?.warnings || []),
      evidence: this.clone(timeSemanticEnhancement?.evidence || null)
    };
  }
}

module.exports = new TimeResolveService();

