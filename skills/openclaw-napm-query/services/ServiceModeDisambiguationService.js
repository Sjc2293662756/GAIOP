/**
 * ServiceModeDisambiguationService.js
 * 
 * 鏈嶅姟妯″紡娑堟鏈嶅姟
 * 
 * 璐熻矗鏍规嵁鐢ㄦ埛鏌ヨ鏂囨湰鍒ゆ柇搴旇浣跨敤鍝鏈嶅姟妯″紡锛堝 topValues銆乼imeValues銆乤verageValues 绛夛級銆? * 
 * 淇敼鏃ユ湡锛?026-04-16
 */
const fs = require('fs');
const path = require('path');

/**
 * ServiceModeDisambiguationService 绫? * 鏍规嵁鐢ㄦ埛鏌ヨ鏂囨湰杩涜鏈嶅姟妯″紡娑堟
 */
class ServiceModeDisambiguationService {
  /**
   * 鏋勯€犲嚱鏁?   * 
   * 鍔犺浇鏈嶅姟妯″紡娑堟閰嶇疆
   */
  constructor() {
    const configPath = path.join(__dirname, '../../../config/service-mode-disambiguation.v1.json');
    this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  /**
   * 鎵ц鏈嶅姟妯″紡娑堟
   * 
   * 鏍规嵁鐢ㄦ埛鏌ヨ鏂囨湰涓烘瘡涓湇鍔℃ā寮忔墦鍒嗭紝閫夋嫨鏈€浣冲尮閰嶇殑鏈嶅姟妯″紡銆?   * 
   * @param {object} query - 鏌ヨ瀵硅薄
   * @param {string} originalText - 鍘熷鏂囨湰
   * @returns {object} - 娑堟缁撴灉瀵硅薄
   */
  async disambiguate(query, originalText = '') {
    const resolvedQuery = this.cloneQuery(query);
    const warnings = [];
    const corrections = [];
    const text = this.buildTextContext(originalText);
    const currentService = resolvedQuery?.service || null;

    const candidates = Object.keys(this.config.services)
      .map(service => this.scoreService(service, text, resolvedQuery))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const best = candidates[0] || null;
    const current = candidates.find(item => item.service === currentService) || null;
    const lead = best && current ? Number((best.score - current.score).toFixed(2)) : null;
    const shouldApply = Boolean(
      best &&
      best.score >= this.config.thresholds.autoApply &&
      best.service !== currentService &&
      (current ? best.score - current.score >= this.config.thresholds.minimumLead : true)
    );

    if (shouldApply) {
      const before = this.cloneQuery(resolvedQuery);
      this.applyService(resolvedQuery, best.service);
      corrections.push({
        field: 'service',
        action: 'disambiguate_service_mode',
        from: currentService,
        to: best.service,
        evidence: best.reasons
      });

      if (before.service !== resolvedQuery.service) {
        corrections.push({
          field: 'query_shape',
          action: 'normalize_fields_for_service_mode',
          from: before,
          to: resolvedQuery
        });
      }
    }

    return {
      query: resolvedQuery,
      warnings,
      corrections,
      shouldApply,
      candidates,
      suggestions: candidates
        .filter(item => item !== best && item.score >= this.config.thresholds.suggest)
        .slice(0, this.config.maxSuggestions),
      evidence: {
        currentService,
        selectedCandidate: best,
        lead
      }
    };
  }

  /**
   * 涓烘湇鍔℃ā寮忔墦鍒?   * 
   * 鏍规嵁鏂囨湰鐗瑰緛鍜屾煡璇笂涓嬫枃涓烘湇鍔℃ā寮忚绠楀垎鏁般€?   * 
   * @param {string} service - 鏈嶅姟妯″紡鍚嶇О
   * @param {object} text - 鏂囨湰涓婁笅鏂?   * @param {object} query - 鏌ヨ瀵硅薄
   * @returns {object} - 鎵撳垎缁撴灉
   */
  scoreService(service, text, query) {
    const config = this.config.services[service];
    const reasons = [];
    let score = 0;

    const aliasHits = this.countAliasHits(config.aliases, text);
    if (aliasHits > 0) {
      score += aliasHits * config.weights.aliasHit;
      reasons.push(`alias_hits:${aliasHits}`);
    }

    if (query?.service === service) {
      score += config.weights.currentBias || 0;
      reasons.push('current_service_bias');
    }

    if (service === 'topValues' && this.matchesAnyPattern(this.config.topPatterns, text.raw)) {
      score += config.weights.topCount || 0;
      reasons.push('top_pattern');
    }

    if (service === 'timeValues') {
      if (this.hasAnyTerm(this.config.timeSeriesTerms, text.lower)) {
        score += config.weights.aliasHit || 0;
        reasons.push('time_series_term');
      }
      if (this.matchesAnyPattern(this.config.granularityPatterns, text.raw)) {
        score += config.weights.granularity || 0;
        reasons.push('granularity_pattern');
      }
      if (this.hasTimeRange(text.raw)) {
        score += config.weights.timeRange || 0;
        reasons.push('time_range_hint');
      }
    }

    if (service === 'averageValues' && this.hasAnyTerm(this.config.averageOverrideTerms, text.lower)) {
      score += 0.34;
      reasons.push('average_term');
    }

    if ((service === 'metrics' || service === 'groups') && this.hasAnyTerm(this.config.questionTerms, text.lower)) {
      score += config.weights.questionHint || 0;
      reasons.push('question_hint');
    }

    if (service === 'groups' && /business group|涓氬姟缁剕group/.test(text.lower)) {
      score += 0.16;
      reasons.push('group_domain_hint');
    }

    if (service === 'metrics' && /metric|鎸囨爣/.test(text.lower)) {
      score += 0.16;
      reasons.push('metric_domain_hint');
    }

    if ((service === 'metrics' || service === 'groups') && this.hasAnyTerm(this.config.quantitativeTerms, text.lower)) {
      score -= 0.24;
      reasons.push('quantitative_conflict_penalty');
    }

    if (service === 'averageValues' && this.hasAnyTerm(this.config.timeSeriesTerms, text.lower)) {
      score -= 0.12;
      reasons.push('trend_conflict_penalty');
    }

    if (service === 'topValues' && this.hasAnyTerm(this.config.timeSeriesTerms, text.lower)) {
      score -= 0.1;
      reasons.push('trend_conflict_penalty');
    }

    return {
      service,
      score: Number(Math.max(0, Math.min(score, 0.99)).toFixed(2)),
      reasons
    };
  }

  /**
   * 搴旂敤鏈嶅姟妯″紡鍒版煡璇?   * 
   * 鏍规嵁鏈嶅姟妯″紡瑙勮寖鍖栨煡璇㈠瓧娈点€?   * 
   * @param {object} query - 鏌ヨ瀵硅薄
   * @param {string} service - 鏈嶅姟妯″紡鍚嶇О
   */
  applyService(query, service) {
    query.service = service;

    if (service === 'metrics') {
      delete query.metric;
      delete query.metrics;
      delete query.topCount;
      delete query.granularity;
      delete query.groups;
      return;
    }

    if (service === 'groups') {
      delete query.metric;
      delete query.metrics;
      delete query.topCount;
      delete query.granularity;
      return;
    }

    if (!query.metric && Array.isArray(query.metrics) && query.metrics[0]) {
      query.metric = query.metrics[0];
    }

    if (!Array.isArray(query.metrics) || query.metrics.length === 0) {
      query.metrics = query.metric ? [query.metric] : ['TPIO'];
    }

    if (!Array.isArray(query.groups) || query.groups.length === 0) {
      query.groups = [{ type: 'IPAddress' }];
    }

    if (service === 'topValues') {
      if (!query.metric) {
        query.metric = query.metrics[0];
      }
      query.topCount = Number(query.topCount || 10);
      delete query.granularity;
      return;
    }

    if (service === 'averageValues') {
      delete query.topCount;
      delete query.granularity;
      return;
    }

    if (service === 'timeValues') {
      delete query.topCount;
      if (!query.granularity) {
        query.granularity = 3600;
      }
    }
  }

  /**
   * 鏋勫缓鏂囨湰涓婁笅鏂?   * 
   * @param {string} originalText - 鍘熷鏂囨湰
   * @returns {object} - 鏂囨湰涓婁笅鏂囧璞?   */
  buildTextContext(originalText) {
    const raw = String(originalText || '').trim();
    const normalized = raw.replace(/\s+/g, ' ');
    const lower = normalized.toLowerCase();
    return { raw, normalized, lower };
  }

  /**
   * 璁＄畻鍒悕鍖归厤娆℃暟
   * 
   * @param {array} aliases - 鍒悕鏁扮粍
   * @param {object} text - 鏂囨湰涓婁笅鏂?   * @returns {number} - 鍖归厤娆℃暟
   */
  countAliasHits(aliases = [], text) {
    return aliases.reduce((count, alias) => {
      if (!alias) {
        return count;
      }
      return text.lower.includes(String(alias).toLowerCase()) ? count + 1 : count;
    }, 0);
  }

  /**
   * 鍒ゆ柇鏄惁鍖呭惈浠讳綍鏈
   * 
   * @param {array} terms - 鏈鏁扮粍
   * @param {string} lowerText - 灏忓啓鏂囨湰
   * @returns {boolean} - 鏄惁鍖呭惈鏈
   */
  hasAnyTerm(terms = [], lowerText = '') {
    return terms.some(term => lowerText.includes(String(term).toLowerCase()));
  }

  /**
   * 鍒ゆ柇鏄惁鍖归厤浠讳綍妯″紡
   * 
   * @param {array} patterns - 妯″紡鏁扮粍
   * @param {string} rawText - 鍘熷鏂囨湰
   * @returns {boolean} - 鏄惁鍖归厤妯″紡
   */
  matchesAnyPattern(patterns = [], rawText = '') {
    return patterns.some(pattern => new RegExp(pattern, 'i').test(rawText));
  }

  /**
   * 鍒ゆ柇鏄惁鍖呭惈鏃堕棿鑼冨洿
   * 
   * @param {string} rawText - 鍘熷鏂囨湰
   * @returns {boolean} - 鏄惁鍖呭惈鏃堕棿鑼冨洿
   */
  hasTimeRange(rawText = '') {
    return /today|yesterday|last\s*\d+\s*(day|days|hour|hours)|浠婂ぉ|鏄ㄥぉ|鏈€杩憒杩囧幓/i.test(rawText);
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

module.exports = new ServiceModeDisambiguationService();

