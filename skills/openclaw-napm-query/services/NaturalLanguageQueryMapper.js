/**
 * NaturalLanguageQueryMapper.js
 * 
 * 鎻忚堪锛氳嚜鐒惰瑷€鏌ヨ鏄犲皠鏈嶅姟
 * 鍔熻兘锛氬皢鐢ㄦ埛鐨勮嚜鐒惰瑷€鏌ヨ杞崲涓虹粨鏋勫寲鐨勬煡璇㈠璞★紝鏀寔鎰忓浘璇嗗埆銆佹寚鏍囪В鏋愩€佸垎缁勮В鏋愩€? *       鏃堕棿鑼冨洿瑙ｆ瀽銆乀opN鏁伴噺瑙ｆ瀽绛夊姛鑳? * 浣滆€咃細绯荤粺鐢熸垚
 * 淇敼鏃ユ湡锛?026-04-15
 */

const fs = require('fs');
const path = require('path');

const MetricMappingService = require('./MetricMappingService');
const DimensionMappingService = require('./DimensionMappingService');
const CandidateSpecBuilder = require('./CandidateSpecBuilder');
const TimeUtils = require('../../../src/utils/TimeUtils');
const logger = require('../../../src/utils/logger');

/**
 * 鑷劧璇█鏌ヨ鏄犲皠绫? * 灏嗙敤鎴疯嚜鐒惰瑷€杈撳叆杞崲涓虹粨鏋勫寲鏌ヨ瀵硅薄
 */
class NaturalLanguageQueryMapper {
  /**
   * 鏋勯€犲嚱鏁?   * 鍔犺浇鑷劧璇█鏌ヨ鏄犲皠閰嶇疆鏂囦欢
   */
  constructor() {
    const configPath = path.join(__dirname, '../../../config/nl-query-mapping.v1.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    this.mappingConfig = JSON.parse(raw);
  }

  /**
   * 鏍稿績鏄犲皠鏂规硶锛屽皢鐢ㄦ埛闇€姹傝浆鎹负缁撴瀯鍖栨煡璇?   * @param {string} userRequirement - 鐢ㄦ埛杈撳叆鐨勮嚜鐒惰瑷€鏌ヨ
   * @returns {object} - 鏄犲皠缁撴灉锛屽寘鍚В鏋愬悗鐨勬煡璇㈠璞°€佸€欓€夎鏍笺€佺疆淇″害绛?   */
  map(userRequirement) {
    const text = this.normalizeText(userRequirement);
    if (!text.raw) {
      return {
        originalText: '',
        normalizedText: '',
        intent: null,
        candidateSpec: null,
        resolvedQuery: null,
        evidence: {},
        confidence: 0,
        questionPatterns: [],
        intentCandidates: [],
        metricDomainCandidates: [],
        metricCandidates: [],
        scopeHints: [],
        objectCandidates: []
      };
    }

    const questionPatterns = this.detectQuestionPatterns(text);
    const intentCandidates = this.resolveIntentCandidates(text, questionPatterns);
    const topCountInfo = this.resolveTopCountInfo(text);
    const topCount = topCountInfo.value;
    const service = this.resolveService(text, topCount, intentCandidates);
    const timeRangeInfo = this.resolveTimeRangeInfo(text);
    const timeRange = timeRangeInfo.value;
    const metricInfo = this.resolveMetricInfo(text);
    const metricDomainCandidates = this.resolveMetricDomainCandidates(text, metricInfo);
    const metric = metricInfo.metric;
    const group = this.resolveGroup(text);
    const objectCandidates = this.resolveObjectCandidates(text, group);
    const metricCandidates = this.resolveMetricCandidates(text, metricInfo);
    const scopeHints = this.extractScopeHints(text);
    const intent = this.inferIntentLabel(service, intentCandidates);
    const semanticConstraints = this.resolveSemanticConstraints({
      text,
      service,
      metricInfo,
      group,
      objectCandidates,
      scopeHints,
      topCount,
      timeRange
    });
    const granularity = this.resolveGranularity(service, timeRange.start, timeRange.end, text);
    const candidateSpec = CandidateSpecBuilder.build({
      originalText: userRequirement,
      text,
      service,
      metricInfo,
      group,
      topCount,
      timeRange,
      semanticConstraints,
      objectCandidates,
      metricCandidates,
      scopeHints,
      intent,
      intentCandidates,
      metricDomainCandidates
    });
    const resolvedQuery = this.buildResolvedQuery({
      originalText: userRequirement,
      service,
      timeRange,
      metricInfo,
      group,
      topCount,
      topCountInfo,
      timeRangeInfo,
      granularity,
      semanticConstraints,
      candidateSpec,
      objectCandidates,
      metricCandidates,
      scopeHints,
      intent
    });

    const evidence = {
      service,
      metric,
      group,
      timeRange,
      topCount,
      granularity,
      semanticConstraints,
      questionPatterns,
      selectedIntent: intentCandidates[0] || null,
      selectedMetricDomain: metricDomainCandidates[0] || null,
      selectedMetricCandidate: metricCandidates[0] || null,
      selectedObjectCandidate: objectCandidates[0] || null,
      scopeHints,
      metricResolution: metricInfo,
      groupResolution: group?.resolution || null,
      timeResolution: timeRangeInfo,
      topCountResolution: topCountInfo
    };

    const confidence = this.calculateConfidence(evidence);
    if (resolvedQuery) {
      resolvedQuery.resolutionHints = {
        ...(resolvedQuery.resolutionHints || {}),
        mapping: {
          confidence,
          lowConfidence: confidence < 0.78
        }
      };
    }

    logger.info('Natural language mapping completed', {
      originalText: userRequirement,
      resolvedQuery,
      candidateSpec,
      evidence,
      confidence
    });

    return {
      originalText: userRequirement,
      normalizedText: text.normalized,
      intent,
      candidateSpec,
      resolvedQuery,
      evidence,
      confidence,
      questionPatterns,
      intentCandidates,
      metricDomainCandidates,
      metricCandidates,
      scopeHints,
      objectCandidates,
      candidateGeneration: {
        questionPatterns,
        intent,
        intentCandidates,
        metricDomainCandidates,
        metricCandidates,
        scopeHints,
        objectCandidates
      }
    };
  }

  /**
   * 瑙勮寖鍖栨枃鏈緭鍏?   * @param {string} input - 鍘熷杈撳叆鏂囨湰
   * @returns {object} - 鍖呭惈 raw銆乶ormalized銆乴ower 涓変釜鐗堟湰鐨勬枃鏈璞?   */
  normalizeText(input) {
    const raw = String(input || '')
      .replace(/\u200b/g, ' ')
      .trim()
      .replace(/^\s*\d{1,2}[.\u3001]?\s*(?=[^\d])/u, '');
    let normalized = raw
      .replace(/\s+/g, ' ')
      .replace(/^@\S+\s*/u, '')
      .trim();

    if (!/^\d{1,3}(?:\.\d{1,3}){3}(?:\b|$)/.test(normalized)) {
      normalized = normalized.replace(/^(?:v(?:ersion)?\s*)?\d{1,2}(?:\.\d{1,2}){1,2}\s+/i, '').trim();
    }

    const lower = normalized.toLowerCase();
    return { raw: normalized, normalized, lower };
  }

  /**
   * 鎺ㄦ柇璇箟鎿嶄綔绫诲瀷锛堝幓闂硶娓呭崟鍖栵級
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @param {number|null} topCount - TopN 鏁伴噺
   * @returns {string} - operation: inventory/ranking/trend/average/query
   */
  inferSemanticOperation(text, topCount = null) {
    const raw = String(text?.raw || '');

    if (this.isSemanticInventoryIntent(text)) {
      return 'inventory';
    }

    if (/(?:瓒嬪娍|璧板娍|鍙樺寲|娉㈠姩|鏇茬嚎|鎸夋椂闂磡姣忓皬鏃秥鏃跺簭|timeseries|time\s*series|timevalues)/i.test(raw)) {
      return 'trend';
    }

    if (/(?:骞冲潎|鍧囧€紎avg|average|姒傝|overall|overview)/i.test(raw)) {
      return 'average';
    }

    if (this.looksLikeRankingIntent(text, topCount)) {
      return 'ranking';
    }

    return 'query';
  }

  /**
   * 鍒ゆ柇鏄惁涓鸿涔変笂鐨勫璞℃竻鍗曟煡璇紙鍏冩暟鎹?inventory锛?   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {boolean} - 鏄惁鍛戒腑 inventory
   */
  isSemanticInventoryIntent(text) {
    const raw = String(text?.raw || '').trim();
    if (!raw) {
      return false;
    }

    const inventoryVerbSignal = /(?:有什么|有哪些|都有什么|都有哪些|列表|清单|列出|包含|包括|存在|当前.*业务系统.*有|what.*list|list.*all)/i;
    const objectType = this.resolveSemanticObjectType(text, { allowUnknown: true });
    const quantitativeSignal = /(?:流量|吞吐|访问量|排行|排名|top|最高|最大|最慢|趋势|响应时间|时延|延迟|错误|失败|异常|丢包|重传)/i;
    const metadataExcludeSignal = /(?:指标|metric|metrics|维度|分组类型|对象类型|支持)/i;

    return Boolean(
      inventoryVerbSignal.test(raw)
      && objectType
      && !quantitativeSignal.test(raw)
      && !metadataExcludeSignal.test(raw)
    );
  }

  /**
   * 瑙ｆ瀽璇箟瀵硅薄绫诲瀷锛堝幓闂硶娓呭崟鍖栵級
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @param {object} options - 瑙ｆ瀽閫夐」
   * @param {boolean} options.allowUnknown - 鏈瘑鍒椂鏄惁鍏佽杩斿洖 null
   * @returns {string|null} - 瀵硅薄绫诲瀷
   */
  resolveSemanticObjectType(text, options = {}) {
    const raw = String(text?.raw || '');
    const lower = String(text?.lower || '');
    const allowUnknown = Boolean(options.allowUnknown);

    if (/(?:业务组|工作组|业务分组|businessgroup|business group)/i.test(raw)) {
      return 'BusinessGroup';
    }

    if (/(?:业务应用|(?:^|[^A-Za-z])(应用|app|application)(?:[^A-Za-z]|$))/i.test(raw)) {
      return 'Application';
    }

    if (/(?:网站|站点|web应用|webapplication|web\s*application|业务系统)/i.test(raw)) {
      return 'WebApplication';
    }

    if (/(?:^|[^A-Za-z])业务(?:[^A-Za-z]|$)/.test(raw)) {
      return 'WebApplication';
    }

    if (/(?:\d{1,3}\.){3}\d{1,3}/.test(raw) || lower.includes('ipaddress')) {
      return 'IPAddress';
    }

    if (allowUnknown) {
      return null;
    }
    return 'WebApplication';
  }

  /**
   * 瑙ｆ瀽鏈嶅姟绫诲瀷
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @param {number} topCount - TopN 鏁伴噺
   * @param {array} intentCandidates - 鎰忓浘鍊欓€夊垪琛?   * @returns {string} - 鏈嶅姟绫诲瀷锛坓roups/timeValues/averageValues/topValues锛?   */
  resolveService(text, topCount = null, intentCandidates = []) {
    const semanticOperation = this.inferSemanticOperation(text, topCount);

    if (semanticOperation === 'inventory') {
      return 'groups';
    }

    if (semanticOperation === 'trend') {
      return 'timeValues';
    }

    if (semanticOperation === 'average') {
      return 'averageValues';
    }

    if (semanticOperation === 'ranking') {
      return 'topValues';
    }

    if (this.isProtocolTrafficIntent(text)) {
      if (this.isProtocolTrafficTrendIntent(text)) {
        return 'timeValues';
      }

      if (this.isProtocolTrafficAverageIntent(text)) {
        return 'averageValues';
      }

      return 'topValues';
    }

    const scored = this.mappingConfig.services
      .map(item => ({
        service: item.service,
        score: this.scoreAliases(text, item.aliases)
      }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (best && best.score > 0) {
      return best.service;
    }

    const preferredIntent = Array.isArray(intentCandidates) ? intentCandidates[0] : null;
    if (preferredIntent?.service && Number(preferredIntent.score) >= 0.8) {
      return preferredIntent.service;
    }

    if (
      this.looksLikeRankingIntent(text, topCount) &&
      !/(鐡掑濞峾閸欐ê瀵瞸閺囪尙鍤巪timeseries|time\s*series|timevalues)/i.test(String(text?.raw || ''))
    ) {
      return 'topValues';
    }

    if (this.looksLikeSingularMetricLookup(text)) {
      return 'averageValues';
    }

    return this.mappingConfig.defaults.service;
  }

  /**
   * 妫€娴嬮棶棰樻ā寮?   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {array} - 鍖归厤鐨勯棶棰樻ā寮忓垪琛?   */
  detectQuestionPatterns(text) {
    const raw = String(text?.raw || '');
    const patterns = [];
    const semanticOperation = this.inferSemanticOperation(text);

    if (/(?:\u4e3a\u4ec0\u4e48|\u4e3a\u5565|\u600e\u4e48|\u5982\u4f55|\u6392\u67e5|\u8bca\u65ad|\u5f02\u5e38|\u5f88\u6162|\u5f88\u5361|\u504f\u6162|\u53d8\u6162|\u6709\u95ee\u9898|\u4e0d\u7a33\u5b9a)/i.test(raw)) {
      patterns.push({ key: 'diagnose', score: 0.88 });
    }
    if (semanticOperation === 'average' || /(?:\u6982\u89c8|\u6574\u4f53|\u5168\u5c40|\u5148\u770b\u4e00\u4e0b|overall|overview)/i.test(raw)) {
      patterns.push({ key: 'overview_first', score: 0.82 });
    }
    if (semanticOperation === 'ranking') {
      patterns.push({ key: 'ranking', score: 0.86 });
    }
    if (semanticOperation === 'trend') {
      patterns.push({ key: 'timeseries', score: 0.84 });
    }
    if (semanticOperation === 'average') {
      patterns.push({ key: 'average', score: 0.8 });
    }
    if (semanticOperation === 'inventory' || /(?:\u652f\u6301|\u5206\u7ec4\u7c7b\u578b|\u7ef4\u5ea6)/i.test(raw)) {
      patterns.push({ key: 'metadata', score: 0.86 });
    }

    if (patterns.length === 0) {
      patterns.push({ key: 'direct_query', score: 0.6 });
    }

    return patterns.sort((a, b) => b.score - a.score);
  }

  /**
   * 瑙ｆ瀽鎰忓浘鍊欓€夊垪琛?   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @param {array} questionPatterns - 闂妯″紡鍒楄〃
   * @returns {array} - 鎰忓浘鍊欓€夊垪琛紙鏈€澶?涓級
   */
  resolveIntentCandidates(text, questionPatterns = []) {
    const serviceScores = this.mappingConfig.services
      .map(item => ({
        key: this.mapServiceToIntent(item.service),
        service: item.service,
        score: this.scoreAliases(text, item.aliases),
        source: 'service_alias'
      }))
      .filter(item => item.score > 0);

    const patternScores = questionPatterns.map(item => ({
      key: item.key,
      service: this.mapPatternToService(item.key),
      score: item.score,
      source: 'question_pattern'
    }));

    const aggregate = new Map();
    [...serviceScores, ...patternScores].forEach((item) => {
      const existing = aggregate.get(item.key) || {
        key: item.key,
        service: item.service,
        score: 0,
        sources: []
      };
      existing.score = Number((existing.score + item.score).toFixed(2));
      existing.service = existing.service || item.service;
      existing.sources.push(item.source);
      aggregate.set(item.key, existing);
    });

    const candidates = Array.from(aggregate.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    if (candidates.length === 0) {
      return [{
        key: this.mapServiceToIntent(this.mappingConfig.defaults.service),
        service: this.mappingConfig.defaults.service,
        score: 0.5,
        sources: ['default']
      }];
    }

    return candidates;
  }

  /**
   * 瑙ｆ瀽鎸囨爣淇℃伅
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {object} - 鎸囨爣淇℃伅瀵硅薄
   */
  resolveMetricInfo(text) {
    const direction = this.resolveDirection(text);
    const candidates = this.mappingConfig.metricFamilies
      .map(item => ({
        item,
        score: this.scoreAliases(text, item.aliases)
      }))
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    if (best && best.score > 0) {
      const explicit = best.score > 0;
      const throughputMetric = this.resolveTrafficMetricOverride(text, direction);
      if (throughputMetric) {
        return {
          metric: throughputMetric,
          explicit: true,
          family: 'throughput',
          aliasScore: best.score,
          source: 'traffic_direction_override',
          defaulted: false
        };
      }

      if (best.item.metric) {
        return {
          metric: this.validateMetric(best.item.metric),
          explicit,
          family: best.item.family || null,
          aliasScore: best.score,
          source: 'metric_alias',
          defaulted: false
        };
      }

      if (direction === 'inbound' && best.item.inboundMetric) {
        return {
          metric: this.validateMetric(best.item.inboundMetric),
          explicit,
          family: best.item.family || null,
          aliasScore: best.score,
          source: 'metric_direction_alias',
          defaulted: false
        };
      }

      if (direction === 'outbound' && best.item.outboundMetric) {
        return {
          metric: this.validateMetric(best.item.outboundMetric),
          explicit,
          family: best.item.family || null,
          aliasScore: best.score,
          source: 'metric_direction_alias',
          defaulted: false
        };
      }

      return {
        metric: this.validateMetric(best.item.defaultMetric),
        explicit,
        family: best.item.family || null,
        aliasScore: best.score,
        source: 'metric_family_default',
        defaulted: false
      };
    }

    const implicitMetric = this.resolveImplicitSemanticMetric(text);
    if (implicitMetric) {
      return {
        metric: implicitMetric,
        explicit: true,
        family: 'implicit_semantic',
        aliasScore: 0.78,
        source: 'implicit_semantic',
        defaulted: false
      };
    }

    return {
      metric: this.mappingConfig.defaults.metric,
      explicit: false,
      family: null,
      aliasScore: 0,
      source: 'default_metric',
      defaulted: true
    };
  }

  /**
   * 瑙ｆ瀽鎸囨爣鍩熷€欓€夊垪琛?   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @param {object} metricInfo - 鎸囨爣淇℃伅瀵硅薄
   * @returns {array} - 鍩熷€欓€夊垪琛?   */
  resolveMetricDomainCandidates(text, metricInfo = {}) {
    const familyDomainMap = {
      throughput: 'traffic',
      traffic: 'traffic',
      packet_loss: 'network_quality'
    };
    const explicitMetric = metricInfo?.metric || null;
    const candidates = [];
    const pushed = new Set();

    const pushCandidate = (candidate) => {
      if (!candidate?.domain || pushed.has(candidate.domain)) {
        return;
      }
      pushed.add(candidate.domain);
      candidates.push(candidate);
    };

    if (metricInfo?.family && familyDomainMap[metricInfo.family]) {
      pushCandidate({
        domain: familyDomainMap[metricInfo.family],
        score: 0.88,
        source: 'metric_family',
        primaryMetrics: [explicitMetric].filter(Boolean)
      });
    }

    if (explicitMetric) {
      const dimensionDomain = DimensionMappingService.getMetricDomain(explicitMetric);
      pushCandidate({
        domain: dimensionDomain || 'generic_metric',
        score: 0.8,
        source: 'explicit_metric',
        primaryMetrics: [explicitMetric]
      });
    }

    const aliasDriven = [
      {
        domain: 'traffic',
        test: /(鍚炲悙|甯﹀|娴侀噺|throughput|bandwidth|traffic)/i,
        primaryMetrics: ['TPIO']
      },
      {
        domain: 'network_quality',
        test: /(涓㈠寘|閲嶄紶|rtt|鏃跺欢|寤惰繜|loss|latency)/i,
        primaryMetrics: ['TRTI', 'RTTI', 'PLI']
      },
      {
        domain: 'application_experience',
        test: /(鍝嶅簲鏃堕棿|浣撻獙|response time)/i,
        primaryMetrics: ['TRTI', 'PGTME']
      },
      {
        domain: 'web_experience',
        test: /(页面|网站|web|http|访问错误|慢页面)/i,
        primaryMetrics: ['PGTME', 'PGNPGE', 'PGHTTP500PCT']
      }
    ];

    aliasDriven.forEach((item) => {
      if (item.test.test(text.raw)) {
        pushCandidate({
          domain: item.domain,
          score: 0.72,
          source: 'alias_domain',
          primaryMetrics: item.primaryMetrics
        });
      }
    });

    return candidates.sort((a, b) => b.score - a.score);
  }

  inferIntentLabel(service = '', intentCandidates = []) {
    const byService = {
      topValues: 'topn',
      timeValues: 'trend',
      averageValues: 'average',
      groups: 'inventory',
      metrics: 'inventory'
    };
    if (byService[service]) {
      return byService[service];
    }
    const first = Array.isArray(intentCandidates) ? intentCandidates[0] : null;
    return String(first?.intent || first?.key || 'query').trim() || 'query';
  }

  resolveMetricCandidates(text, metricInfo = {}) {
    const raw = String(text?.raw || '');
    const candidates = [];
    const pushed = new Set();
    const push = (id, score, reason) => {
      const code = String(id || '').trim();
      if (!code || pushed.has(code)) {
        return;
      }
      pushed.add(code);
      candidates.push({
        id: code,
        score: Number(Math.max(0, Math.min(score, 0.99)).toFixed(2)),
        reason
      });
    };

    if (metricInfo?.metric) {
      push(metricInfo.metric, metricInfo.explicit ? 0.97 : 0.82, metricInfo.explicit ? 'explicit_metric_match' : 'default_metric_fallback');
    }

    const aliasMetrics = [
      { id: 'TPIO', test: /(鍚炲悙|鍚炲悙閲弢甯﹀|throughput|bandwidth|traffic)/i, reason: 'match_throughput' },
      { id: 'PGHTTP500', test: /(http\s*500|http500|5xx|500閿欒|500寮傚父)/i, reason: 'match_http500' },
      { id: 'PGHTTP500PCT', test: /(500閿欒鐜噟5xx閿欒鐜噟http\s*500\s*rate|5xx\s*rate)/i, reason: 'match_http500_ratio' },
      { id: 'PGTME', test: /(鍝嶅簲鏃堕棿|椤甸潰鏃跺欢|椤甸潰鑰楁椂|response time)/i, reason: 'match_response_time' },
      { id: 'PGNPGE', test: /(璁块棶閲弢璁块棶娆℃暟|椤甸潰璁块棶)/i, reason: 'match_page_visits' },
      { id: 'PLI', test: /(涓㈠寘|loss)/i, reason: 'match_packet_loss' }
    ];

    aliasMetrics.forEach((item) => {
      if (item.test.test(raw)) {
        push(item.id, metricInfo?.metric === item.id ? 0.98 : 0.91, item.reason);
      }
    });

    return candidates.sort((a, b) => b.score - a.score).slice(0, 6);
  }

  extractScopeHints(text = {}) {
    const raw = String(text?.raw || '');
    const hints = [];
    const push = (value) => {
      const normalized = String(value || '').trim();
      if (normalized && !hints.includes(normalized)) {
        hints.push(normalized);
      }
    };

    const protocolMatches = raw.match(/\b(?:HTTP|HTTPS|TCP|UDP|ICMP)\b/ig) || [];
    protocolMatches.forEach((item) => push(String(item).toUpperCase()));

    const quotedValue = this.extractQuotedValue(raw);
    if (quotedValue && !this.isInvalidGroupArgumentCandidate(quotedValue)) {
      push(quotedValue);
    }

    const labeledBusiness = this.extractLabeledObjectPhrase(raw, 'BusinessGroup');
    const labeledApp = this.extractLabeledObjectPhrase(raw, 'Application');
    const labeledWeb = this.extractLabeledObjectPhrase(raw, 'WebApplication');
    [labeledBusiness, labeledApp, labeledWeb].forEach((item) => {
      if (item && !this.isInvalidGroupArgumentCandidate(item)) {
        push(item);
      }
    });

    return hints.slice(0, 6);
  }

  /**
   * 鏍规嵁鏂瑰悜瑙ｆ瀽娴侀噺鎸囨爣瑕嗙洊
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @param {string} direction - 鏂瑰悜锛坕nbound/outbound/both锛?   * @returns {string|null} - 鎸囨爣鍚嶇О鎴杗ull
   */
  resolveTrafficMetricOverride(text, direction) {
    if (!this.shouldMapTrafficToThroughput(text)) {
      return null;
    }

    if (direction === 'inbound') {
      return 'TPI';
    }

    if (direction === 'outbound') {
      return 'TPO';
    }

    return 'TPIO';
  }

  /**
   * 鍒ゆ柇鏄惁搴旇灏嗘祦閲忔槧灏勪负鍚炲悙閲忔寚鏍?   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {boolean} - 鏄惁搴旇鏄犲皠
   */
  shouldMapTrafficToThroughput(text) {
    const raw = String(text?.raw || '');
    if (!/(娴侀噺|鎬绘祦閲弢traffic)/i.test(raw)) {
      return false;
    }

    if (/(瀛楄妭|byte|bytes|byte traffic)/i.test(raw)) {
      return false;
    }

    return true;
  }

  /**
   * 瑙ｆ瀽闅愬紡璇箟鎸囨爣
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {string|null} - 鎸囨爣鍚嶇О鎴杗ull
   */
  resolveImplicitSemanticMetric(text) {
    const raw = String(text?.raw || '');

    if (/(鎶ラ敊|閿欒|澶辫触|寮傚父|http|4xx|400|5xx|500)/i.test(raw)) {
      const isRatio = /(鐜噟姣斾緥|鍗犳瘮|percent|pct|rate)/i.test(raw);
      if (/(4xx|400)/i.test(raw)) {
        return isRatio ? 'PGHTTP400PCT' : 'PGHTTP400';
      }
      if (/(5xx|500)/i.test(raw)) {
        return isRatio ? 'PGHTTP500PCT' : 'PGHTTP500';
      }
      // 未明确 4xx/5xx 时维持默认：偏向服务端错误统计。
      return isRatio ? 'PGHTTP500PCT' : 'PGHTTP500';
    }

    if (/(最慢|很慢|变慢|偏慢|卡顿|很卡|耗时高|时延高|延迟高)/.test(raw)) {
      if (/(椤甸潰|缃戠珯|绔欑偣|缃戦〉|web)/i.test(raw)) {
        return 'PGTME';
      }

      if (/(涓氬姟绯荤粺|涓氬姟缁剕涓氬姟鍒嗙粍|涓氬姟搴旂敤|涓氬姟|绯荤粺)/.test(raw)) {
        return 'TRTI';
      }

      return 'TRTI';
    }

    return null;
  }

  /**
   * 鍒ゆ柇鏄惁涓轰笟鍔＄郴缁熸剰鍥?   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {boolean} - 鏄惁涓轰笟鍔＄郴缁熸剰鍥?   */
  isBusinessSystemIntent(text) {
    const raw = String(text?.raw || '');
    return /(?:\u4e1a\u52a1\u7ec4|\u5de5\u4f5c\u7ec4|\u4e1a\u52a1\u5206\u7ec4|businessgroup|business group)/i.test(raw);
  }

  /**
   * 鍒ゆ柇鏄惁涓衡€滀笟鍔★紙WebApplication锛夆€濇剰鍥?   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {boolean} - 鏄惁涓轰笟鍔★紙WebApplication锛夋剰鍥?   */
  isBusinessWebApplicationIntent(text) {
    const raw = String(text?.raw || '');
    // “业务应用”保留给 Application；“业务组/工作组/业务分组”保留给 BusinessGroup。
    if (/\u4e1a\u52a1\u5e94\u7528/.test(raw)) {
      return false;
    }

    if (/(?:\u4e1a\u52a1\u7ec4|\u5de5\u4f5c\u7ec4|\u4e1a\u52a1\u5206\u7ec4)/.test(raw)) {
      return false;
    }

    return /(?:^|[^A-Za-z])\u4e1a\u52a1(?:[^A-Za-z]|$)/.test(raw);
  }

  /**
   * 鍒ゆ柇鏄惁涓轰笟鍔″簲鐢ㄦ剰鍥?   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {boolean} - 鏄惁涓轰笟鍔″簲鐢ㄦ剰鍥?   */
  isBusinessApplicationIntent(text) {
    const raw = String(text?.raw || '');
    if (this.isSemanticInventoryIntent(text)) {
      return false;
    }

    if (this.isBusinessWebApplicationIntent(text)) {
      return false;
    }

    if (/\u4e1a\u52a1\u5e94\u7528/.test(raw)) {
      return true;
    }

    if (/(?:\u4e1a\u52a1\u7ec4|\u5de5\u4f5c\u7ec4|\u4e1a\u52a1\u5206\u7ec4|\u7f51\u7ad9|\u7ad9\u70b9|web\u5e94\u7528|webapplication)/i.test(raw)) {
      return false;
    }

    return /(?:^|[^A-Za-z])(\u5e94\u7528|app|application)(?:[^A-Za-z]|$)/i.test(raw);
  }

  /**
   * 鍒ゆ柇鏄惁涓虹綉绔欐剰鍥?   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {boolean} - 鏄惁涓虹綉绔欐剰鍥?   */
  isWebsiteIntent(text) {
    const raw = String(text?.raw || '');
    return /(缃戠珯搴旂敤|web搴旂敤|web绔欑偣|缃戠珯|绔欑偣|缃戦〉)/i.test(raw);
  }

  /**
   * 瑙ｆ瀽鏂瑰悜锛堝叆绔?鍑虹珯/鍙屽悜锛?   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {string} - 鏂瑰悜锛坕nbound/outbound/both锛?   */
  resolveDirection(text) {
    const inboundScore = this.scoreAliases(text, this.mappingConfig.directionAliases.inbound);
    const outboundScore = this.scoreAliases(text, this.mappingConfig.directionAliases.outbound);

    if (inboundScore > outboundScore && inboundScore > 0) {
      return 'inbound';
    }

    if (outboundScore > inboundScore && outboundScore > 0) {
      return 'outbound';
    }

    return 'both';
  }

  /**
   * 瑙ｆ瀽鍒嗙粍绫诲瀷
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {object} - 鍒嗙粍淇℃伅瀵硅薄
   */
  resolveGroup(text) {
    const buildGroup = (type, argument = null, resolution = {}) => ({
      type,
      argument,
      resolution: {
        explicit: Boolean(resolution.explicit),
        argument_explicit: Boolean(resolution.argumentExplicit),
        source: resolution.source || null,
        alias_score: Number(resolution.aliasScore || 0),
        defaulted: Boolean(resolution.defaulted)
      }
    });

    const namedBusinessGroup = this.extractNamedBusinessGroupScope(text.raw);
    if (namedBusinessGroup) {
      return buildGroup('BusinessGroup', namedBusinessGroup, {
        explicit: true,
        argumentExplicit: true,
        source: 'named_business_group'
      });
    }

    const implicitNamedObject = this.extractImplicitNamedObject(text);
    if (implicitNamedObject) {
      return buildGroup(implicitNamedObject.type, implicitNamedObject.argument, {
        explicit: true,
        argumentExplicit: Boolean(implicitNamedObject.argument),
        source: 'implicit_named_object'
      });
    }

    if (this.isSemanticInventoryIntent(text)) {
      const inventoryType = this.resolveSemanticObjectType(text, { allowUnknown: true }) || 'WebApplication';
      return buildGroup(inventoryType, null, {
        explicit: true,
        argumentExplicit: false,
        source: 'semantic_inventory'
      });
    }

    if (this.isBusinessSystemIntent(text)) {
      const argument = this.extractGroupArgument(text, 'BusinessGroup');
      return buildGroup('BusinessGroup', argument, {
        explicit: true,
        argumentExplicit: Boolean(argument),
        source: 'business_system_intent'
      });
    }

    if (this.isBusinessWebApplicationIntent(text)) {
      const argument = this.extractGroupArgument(text, 'WebApplication');
      return buildGroup('WebApplication', argument, {
        explicit: true,
        argumentExplicit: Boolean(argument),
        source: 'business_web_intent'
      });
    }

    if (this.isProtocolTrafficIntent(text)) {
      const argument = this.extractGroupArgument(text, 'Application');
      return buildGroup('Application', argument, {
        explicit: true,
        argumentExplicit: Boolean(argument),
        source: 'protocol_traffic_intent'
      });
    }

    if (this.isWebsiteIntent(text)) {
      const argument = this.extractGroupArgument(text, 'WebApplication');
      return buildGroup('WebApplication', argument, {
        explicit: true,
        argumentExplicit: Boolean(argument),
        source: 'website_intent'
      });
    }

    if (this.isBusinessApplicationIntent(text)) {
      const argument = this.extractGroupArgument(text, 'Application');
      return buildGroup('Application', argument, {
        explicit: true,
        argumentExplicit: Boolean(argument),
        source: 'business_application_intent'
      });
    }

    const candidates = this.mappingConfig.groupTypes
      .map(item => ({
        item,
        score: this.scoreAliases(text, item.aliases)
      }))
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    let groupType = best && best.score > 0 ? best.item.type : 'IPAddress';
    let groupExplicit = Boolean(best && best.score > 0);
    let groupSource = groupExplicit ? 'group_alias' : 'default_ipaddress';
    let groupAliasScore = best?.score || 0;
    const lower = text.lower || '';

    if (lower.includes('businessgroup') || lower.includes('business group')) {
      groupType = 'BusinessGroup';
      groupExplicit = true;
      groupSource = 'literal_token';
    } else if (lower.includes('webapplication') || lower.includes('web application')) {
      groupType = 'WebApplication';
      groupExplicit = true;
      groupSource = 'literal_token';
    } else if (lower.includes('prefix24') || lower.includes('prefix /24') || lower.includes('/24') || lower.includes('subnet')) {
      groupType = 'Prefix24';
      groupExplicit = true;
      groupSource = 'literal_token';
    } else if (lower.includes('ipaddress')) {
      groupType = 'IPAddress';
      groupExplicit = true;
      groupSource = 'literal_token';
    } else if (lower.includes('application') && !lower.includes('webapplication') && !lower.includes('web application')) {
      groupType = 'Application';
      groupExplicit = true;
      groupSource = 'literal_token';
    }

    if (
      (!best || best.score === 0) &&
      (
        text.raw.includes('搴旂敤')
        || text.raw.includes('涓氬姟')
        || text.lower.includes('application')
        || text.lower.includes('app')
      )
    ) {
      groupType = text.raw.includes('Web搴旂敤') || text.raw.includes('缃戠珯')
        ? 'WebApplication'
        : 'Application';
      groupExplicit = false;
      groupSource = 'generic_application_hint';
      groupAliasScore = 0;
    }

    const explicitQuotedArgument = this.extractQuotedValue(text.raw);
    if (explicitQuotedArgument) {
      if (/(web\s*application|web\s*搴旂敤|web搴旂敤|缃戠珯|绔欑偣)/i.test(text.raw)) {
        groupType = 'WebApplication';
        groupExplicit = true;
        groupSource = 'quoted_object_literal';
      } else if (/(businessgroup|business group|涓氬姟缁剕宸ヤ綔缁剕涓氬姟鍒嗙粍)/i.test(text.raw)) {
        groupType = 'BusinessGroup';
        groupExplicit = true;
        groupSource = 'quoted_object_literal';
      } else if (/(?:^|[^a-z])(application|app|搴旂敤|涓氬姟搴旂敤)/i.test(text.raw) && !/(web\s*application|web\s*搴旂敤|web搴旂敤)/i.test(text.raw)) {
        groupType = 'Application';
        groupExplicit = true;
        groupSource = 'quoted_object_literal';
      } else if (this.isBusinessWebApplicationIntent(text)) {
        groupType = 'WebApplication';
        groupExplicit = true;
        groupSource = 'quoted_object_literal';
      } else if (this.isBusinessApplicationIntent(text)) {
        groupType = 'Application';
        groupExplicit = true;
        groupSource = 'quoted_object_literal';
      }
    }
    const argument = explicitQuotedArgument && new Set(['BusinessGroup', 'WebApplication', 'Application', 'PageFamily']).has(groupType)
      ? explicitQuotedArgument
      : this.extractGroupArgument(text, groupType);

    return buildGroup(groupType, argument, {
      explicit: groupExplicit,
      argumentExplicit: Boolean(explicitQuotedArgument),
      source: groupSource,
      aliasScore: groupAliasScore,
      defaulted: !groupExplicit && groupSource === 'default_ipaddress'
    });
  }

  /**
   * 瑙ｆ瀽瀵硅薄鍊欓€夊垪琛?   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @param {object} selectedGroup - 宸查€夋嫨鐨勫垎缁?   * @returns {array} - 瀵硅薄鍊欓€夊垪琛?   */
  resolveObjectCandidates(text, selectedGroup) {
    const raw = String(text?.raw || '');
    const quotedValue = this.extractQuotedValue(raw);
    const implicitNamedObject = this.extractImplicitNamedObject(text);
    const explicitSignals = this.detectExplicitObjectSignals(text);
    const namedBusinessAnchor = this.extractNamedBusinessAnchor(raw);
    const hasConversationSignal = Boolean(explicitSignals.IPConversation);
    const hasExplicitClientServerIp = Boolean(raw.match(/(?:瀹㈡埛绔痋s*IP|鏈嶅姟绔痋s*IP|client\s*ip|server\s*ip|clientips|serverips)/i));

    const scoredCandidates = this.mappingConfig.groupTypes
      .map((item) => {
        const type = item.type;
        const aliasScore = this.scoreAliases(text, item.aliases);
        const aliasComponent = Math.min(aliasScore / 6, 0.48);
        let score = aliasComponent;
        const reasons = [];

        if (aliasComponent > 0) {
          reasons.push(`alias_match:${aliasScore.toFixed(2)}`);
        }

        if (selectedGroup?.type === type) {
          score += 0.22;
          reasons.push('selected_group_hint');
        }

        const explicit = explicitSignals[type];
        if (explicit) {
          score = Math.max(score, explicit.score);
          reasons.push(explicit.reason);
        }

        if (
          namedBusinessAnchor
          && !hasConversationSignal
          && !hasExplicitClientServerIp
          && ['BusinessGroup', 'WebApplication', 'Application', 'DefinedApp'].includes(type)
        ) {
          const anchorScoreMap = {
            Application: 0.78,
            BusinessGroup: 0.74,
            WebApplication: 0.72,
            DefinedApp: 0.7
          };
          score = Math.max(score, anchorScoreMap[type] || 0.68);
          reasons.push(`named_business_anchor:${namedBusinessAnchor}`);
        }

        if (type === 'IPAddress' && hasConversationSignal && !hasExplicitClientServerIp) {
          score = Math.min(score, 0.45);
          reasons.push('penalized_by_ipconversation_signal');
        }

        const argumentCandidate = quotedValue && this.groupTypeSupportsArgument(type)
          ? quotedValue
          : (
            namedBusinessAnchor && this.groupTypeSupportsArgument(type)
              ? namedBusinessAnchor
              : (
                selectedGroup?.type === type
                  ? selectedGroup?.argument
                  : (implicitNamedObject?.type === type ? implicitNamedObject?.argument : undefined)
              )
          );

        const normalizedScore = Number(Math.max(0.05, Math.min(score, 0.99)).toFixed(2));
        return {
          type,
          objectType: type,
          score: normalizedScore,
          reason: reasons.join('; ') || 'weak_alias_signal',
          argumentCandidate,
          source: explicit ? 'explicit_object_signal' : (aliasComponent > 0 ? 'alias_match' : 'fallback')
        };
      })
      .filter((item) => item.score > 0);

    const candidates = scoredCandidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    if (candidates.length > 0) {
      return candidates.slice(0, 6);
    }

    if (selectedGroup?.type) {
      return [{
        type: selectedGroup.type,
        objectType: selectedGroup.type,
        score: 0.5,
        reason: 'selected_group_fallback',
        argumentCandidate: selectedGroup.argument,
        source: 'selected_fallback'
      }];
    }

    return [];
  }

  extractNamedBusinessAnchor(rawText = '') {
    const raw = String(rawText || '').trim();
    if (!raw) {
      return null;
    }

    const protocolTokens = new Set([
      'http',
      'https',
      'dns',
      'ssh',
      'tcp',
      'udp',
      'icmp',
      'rtp',
      'sip',
      'rtsp'
    ]);
    const bannedTokens = new Set([
      '昨天',
      '今天',
      '最近',
      '近期',
      '当前',
      '目前',
      '现在',
      '哪些',
      '哪个',
      '哪一个',
      '什么',
      '谁'
    ]);

    const matches = Array.from(raw.matchAll(/([A-Za-z0-9_\-\u4e00-\u9fa5]{2,40})\s*的/g))
      .map((item) => String(item[1] || '').trim())
      .filter(Boolean);
    for (const token of matches) {
      const lower = token.toLowerCase();
      if (bannedTokens.has(token)) {
        continue;
      }
      if (protocolTokens.has(lower)) {
        continue;
      }
      if (/(?:top\d*|http\d{3}|4xx|5xx|ip|客户端|服务端|吞吐量|流量|时延|错误|报错|异常|趋势)/i.test(token)) {
        continue;
      }
      return token;
    }

    return null;
  }

  detectExplicitObjectSignals(text = {}) {
    const raw = String(text?.raw || '');
    const signals = {};
    const push = (type, score, reason) => {
      if (!signals[type] || signals[type].score < score) {
        signals[type] = {
          type,
          score: Number(Math.max(0, Math.min(score, 0.99)).toFixed(2)),
          reason
        };
      }
    };

    if (/(?:ip\s*会话|IP会话|会话(?:对象)?|ip\s*conversation)/i.test(raw)) {
      push('IPConversation', 0.96, 'explicit_object:IP会话');
      // 用户表达“IP会话”时可保留 IPAddress 低分候选，但不能盖过 IPConversation
      push('IPAddress', 0.45, 'ip_token_from_conversation_phrase');
    }

    if (/(?:客户端\s*ip|client\s*ip|clientips|clientip)/i.test(raw)) {
      push('IPAddress', 0.95, 'explicit_object:客户端IP');
    }

    if (/(?:服务端\s*ip|server\s*ip|serverips|serverip)/i.test(raw)) {
      push('IPAddress', 0.95, 'explicit_object:服务端IP');
    }

    if (/(?:工作组|业务组|businessgroup|business group)/i.test(raw)) {
      push('BusinessGroup', 0.96, 'explicit_object:业务组');
    }

    if (/(?:业务系统|web应用|webapplication|web application|网站|站点)/i.test(raw)) {
      push('WebApplication', 0.93, 'explicit_object:业务系统/web应用');
    }

    if (/(?:业务应用|(?:^|[^A-Za-z])(应用|app|application)(?:[^A-Za-z]|$))/i.test(raw)) {
      push('DefinedApp', 0.91, 'explicit_object:应用');
      push('Application', 0.86, 'explicit_object:应用_legacy');
    }

    if (!signals.IPConversation && /(?:\bip\b|IP地址|ip地址)/i.test(raw)) {
      push('IPAddress', 0.58, 'generic_ip_token');
    }

    return signals;
  }

  /**
   * 鍒ゆ柇鏄惁搴旇涓哄垎缁勫垪琛ㄩ檮鍔犲垎缁勮繃婊ゅ櫒
   * @param {string} originalText - 鍘熷鏂囨湰
   * @param {object} group - 鍒嗙粍瀵硅薄
   * @returns {boolean} - 鏄惁搴旇闄勫姞杩囨护鍣?   */
  shouldAttachGroupFilterForGroupListing(originalText, group = {}) {
    if (!group?.type) {
      return false;
    }

    if (group.argument) {
      return true;
    }

    if (group?.resolution?.explicit) {
      return true;
    }

    const raw = String(originalText || '');
    const lower = raw.toLowerCase();
    const genericTerms = new Set([
      '分组',
      'group',
      'groups',
      '对象',
      '维度',
      '类型',
      '列表',
      '全部',
      '支持',
      '有哪些'
    ]);
    const groupMeta = (this.mappingConfig.groupTypes || []).find(item => item.type === group.type);
    const explicitAliases = (groupMeta?.aliases || [])
      .map(alias => String(alias || '').trim())
      .filter(Boolean)
      .filter(alias => !genericTerms.has(alias) && !genericTerms.has(alias.toLowerCase()));

    return lower.includes(String(group.type || '').toLowerCase()) || explicitAliases.some(alias => (
      raw.includes(alias) || lower.includes(alias.toLowerCase())
    ));
  }

  /**
   * 鍒ゆ柇鏄惁涓哄懡鍚嶅璞″垪琛ㄦ煡璇?   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {boolean} - 鏄惁涓哄垪琛ㄦ煡璇?   */
  isNamedObjectListQuery(text) {
    return this.isSemanticInventoryIntent(text);
  }

  /**
   * 鍒ゆ柇鏄惁搴旇涓烘寚鏍囧垪琛ㄩ檮鍔犲垎缁勮繃婊ゅ櫒
   * @param {string} originalText - 鍘熷鏂囨湰
   * @param {object} group - 鍒嗙粍瀵硅薄
   * @returns {boolean} - 鏄惁搴旇闄勫姞杩囨护鍣?   */
  shouldAttachGroupFilterForMetricListing(originalText, group = {}) {
    if (!group?.type) {
      return false;
    }

    if (group.argument) {
      return true;
    }

    if (group?.resolution?.explicit) {
      return true;
    }

    const raw = String(originalText || '');
    const lower = raw.toLowerCase();
    const genericTerms = new Set([
      '指标',
      'metric',
      'metrics',
      '支持',
      '全部',
      '列表',
      '有哪些',
      '相关'
    ]);
    const groupMeta = (this.mappingConfig.groupTypes || []).find(item => item.type === group.type);
    const explicitAliases = (groupMeta?.aliases || [])
      .map(alias => String(alias || '').trim())
      .filter(Boolean)
      .filter(alias => !genericTerms.has(alias) && !genericTerms.has(alias.toLowerCase()));

    return lower.includes(String(group.type || '').toLowerCase()) || explicitAliases.some(alias => (
      raw.includes(alias) || lower.includes(alias.toLowerCase())
    ));
  }

  /**
   * 瑙ｆ瀽鏃堕棿鑼冨洿淇℃伅
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {object} - 鏃堕棿鑼冨洿淇℃伅瀵硅薄
   */
  resolveTimeRangeInfo(text) {
    for (const item of this.mappingConfig.timeRanges) {
      if (this.scoreAliases(text, item.aliases) > 0) {
        return {
          value: this.mapTimeRange(item.key),
          explicit: true,
          defaulted: false,
          source: 'time_alias'
        };
      }
    }

    return {
      value: this.mapTimeRange('last1hour'),
      explicit: false,
      defaulted: true,
      source: 'default_last1hour'
    };
  }

  /**
   * 瑙ｆ瀽鏃堕棿鑼冨洿
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {object} - 鏃堕棿鑼冨洿瀵硅薄
   */
  resolveTimeRange(text) {
    return this.resolveTimeRangeInfo(text).value;
  }

  /**
   * 鏄犲皠鏃堕棿鑼冨洿閿埌鏃堕棿鑼冨洿瀵硅薄
   * @param {string} key - 鏃堕棿鑼冨洿閿?   * @returns {object} - 鏃堕棿鑼冨洿瀵硅薄
   */
  mapTimeRange(key) {
    if (key === 'today') {
      return {
        key,
        ...TimeUtils.parseTimeRange('today')
      };
    }

    if (key === 'yesterday') {
      return {
        key,
        ...TimeUtils.parseTimeRange('yesterday')
      };
    }

    if (key === 'last30days') {
      return {
        key,
        ...TimeUtils.parseTimeRange('last30days')
      };
    }

    if (key === 'last1hour') {
      return {
        key,
        ...TimeUtils.parseTimeRange('last1hour')
      };
    }

    if (key === 'last24hours') {
      return {
        key,
        ...TimeUtils.parseTimeRange('last24hours')
      };
    }

    return {
      key: 'last7days',
      ...TimeUtils.parseTimeRange('last7days')
    };
  }

  /**
   * 瑙ｆ瀽 TopN 鏁伴噺淇℃伅
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {object} - TopN 鏁伴噺淇℃伅瀵硅薄
   */
  resolveTopCountInfo(text) {
    if (this.isProtocolTrafficIntent(text) && /(?:\u662f\u8c01|\u662f\u54ea\u4e2a|\u54ea\u4e2a|\u54ea\u4e00\u4e2a)/.test(text.raw)) {
      return {
        value: 1,
        explicit: true,
        defaulted: false,
        source: 'protocol_single_target'
      };
    }

    const match = text.raw.match(/(?:\u524d\s*|top\s*)(\d{1,4})/i);
    if (match?.[1]) {
      const count = Number(match[1]);
      return {
        value: Number.isFinite(count) && count > 0 ? count : this.mappingConfig.defaults.topCount,
        explicit: true,
        defaulted: false,
        source: 'top_count_literal'
      };
    }

    const chineseCount = this.extractChineseOrdinalTopCount(text.raw);
    if (Number.isFinite(chineseCount) && chineseCount > 0) {
      return {
        value: chineseCount,
        explicit: true,
        defaulted: false,
        source: 'top_count_literal_cn'
      };
    }

    if (/(?:\u54ea\u4e2a|\u54ea\u4e00\u4e2a|\u54ea\u53f0|\u54ea\u6761|\u54ea\u51e0\u4e2a)/.test(text.raw)) {
      return {
        value: 1,
        explicit: true,
        defaulted: false,
        source: 'singular_question'
      };
    }

    if (/(?:\u662f\u8c01|\u662f\u54ea\u4e2a|\u8c01)$/.test(text.raw)) {
      return {
        value: 1,
        explicit: true,
        defaulted: false,
        source: 'singular_question'
      };
    }

    if (/(?:\u6392\u884c|\u6392\u540d|top|\u6700\u6162|\u6700\u5361|\u6700\u5feb|\u6700\u597d|\u6700\u5dee|\u6700\u9ad8|\u6700\u4f4e|\u6700\u591a|\u6700\u5c11)/.test(text.raw)) {
      const count = Number(this.mappingConfig.defaults.topCount);
      return {
        value: Number.isFinite(count) && count > 0 ? count : this.mappingConfig.defaults.topCount,
        explicit: false,
        defaulted: true,
        source: 'ranking_default_top_count'
      };
    }

    return {
      value: null,
      explicit: false,
      defaulted: false,
      source: null
    };
  }

  /**
   * 瑙ｆ瀽 TopN 鏁伴噺
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {number|null} - TopN 鏁伴噺
   */
  resolveTopCount(text) {
    return this.resolveTopCountInfo(text).value;
  }

  /**
   * 瑙ｆ瀽鏃堕棿绮掑害
   * @param {string} service - 鏈嶅姟绫诲瀷
   * @param {number} start - 寮€濮嬫椂闂存埑
   * @param {number} end - 缁撴潫鏃堕棿鎴?   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {number|null} - 鏃堕棿绮掑害锛堢锛?   */
  resolveGranularity(service, start, end, text) {
    if (service !== 'timeValues') {
      return null;
    }

    const explicitSeconds = text.raw.match(/\u6bcf\s*(\d{1,5})\s*\u79d2|(\d{1,5})\s*\u79d2\u7c92\u5ea6/);
    if (explicitSeconds) {
      return Number(explicitSeconds[1] || explicitSeconds[2]);
    }

    const explicitMinutes = text.raw.match(/\u6bcf\s*(\d{1,4})\s*\u5206\u949f|(\d{1,4})\s*\u5206\u949f\u7c92\u5ea6/);
    if (explicitMinutes) {
      return Number(explicitMinutes[1] || explicitMinutes[2]) * 60;
    }

    const span = Number(end) - Number(start);
    const rule = this.mappingConfig.granularityRules.find(item => span <= item.maxSpanSeconds);
    return rule ? rule.granularity : 3600;
  }

  /**
   * 鍒ゆ柇鏄惁涓哄崗璁祦閲忔剰鍥?   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {boolean} - 鏄惁涓哄崗璁祦閲忔剰鍥?   */
  isProtocolTrafficIntent(text) {
    const raw = String(text?.raw || '');
    if (!/(tcp|udp|icmp)/i.test(raw)) {
      return false;
    }

    if (!/(?:\u6d41\u91cf|\u541e\u5410|\u5e26\u5bbd|traffic|throughput|\u6392\u884c|\u6392\u540d|top|\u4fe1\u606f|\u5206\u6790|\u60c5\u51b5)/i.test(raw)) {
      return false;
    }

    if (/(?:\u91cd\u542f|\u90e8\u7f72|\u914d\u7f6e|\u4ee3\u7801|\u6570\u636e\u5e93|sql|\u9501\u7b49\u5f85)/i.test(raw)) {
      return false;
    }

    return true;
  }

  /**
   * 鍒ゆ柇鏄惁涓哄崗璁祦閲忚秼鍔挎剰鍥?   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {boolean} - 鏄惁涓鸿秼鍔挎剰鍥?   */
  isProtocolTrafficTrendIntent(text) {
    const raw = String(text?.raw || '');
    return /(?:\u8d8b\u52bf|\u53d8\u5316|\u66f2\u7ebf|\u5386\u53f2|\u6309\u65f6\u95f4|\u65f6\u5e8f|trend|timeseries|time series)/i.test(raw);
  }

  /**
   * 鍒ゆ柇鏄惁涓哄崗璁祦閲忓钩鍧囧€兼剰鍥?   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {boolean} - 鏄惁涓哄钩鍧囧€兼剰鍥?   */
  isProtocolTrafficAverageIntent(text) {
    const raw = String(text?.raw || '');
    return /(?:\u5e73\u5747|\u5747\u503c|avg|average)/i.test(raw);
  }

  /**
   * 鎻愬彇鍒嗙粍鍙傛暟
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @param {string} groupType - 鍒嗙粍绫诲瀷
   * @returns {string|undefined} - 鍒嗙粍鍙傛暟鍊?   */
  extractGroupArgument(text, groupType) {
    if (
      this.isNamedObjectListQuery(text)
      && new Set(['BusinessGroup', 'WebApplication', 'Application']).has(groupType)
    ) {
      return undefined;
    }

    if (groupType === 'BusinessGroup') {
      const namedBusinessGroup = this.extractNamedBusinessGroupScope(text.raw);
      if (namedBusinessGroup) {
        return namedBusinessGroup;
      }
    }

    if (groupType === 'IPAddress' || groupType === 'ClientIPs') {
      const ipMatch = text.raw.match(/((?:\d{1,3}\.){3}\d{1,3})/);
      return ipMatch ? ipMatch[1] : undefined;
    }

    if (groupType === 'IPConversation') {
      const ipMatches = text.raw.match(/((?:\d{1,3}\.){3}\d{1,3})/g);
      if (ipMatches && ipMatches.length >= 2) {
        return `${ipMatches[0]}|${ipMatches[1]}`;
      }
    }

    const quoted = text.raw.match(/[\"'\u201c\u201d\u2018\u2019\u300c\u300d](.+?)[\"'\u201c\u201d\u2018\u2019\u300c\u300d]/);
    if (quoted) {
      return quoted[1];
    }

    const labeledObject = this.extractLabeledObjectPhrase(text.raw, groupType);
    if (labeledObject) {
      return labeledObject;
    }

    if (this.isBroadGroupReference(text.raw, groupType)) {
      return undefined;
    }

    if (groupType === 'BusinessGroup') {
      return this.extractSuffixValue(text.raw, ['\u4e1a\u52a1\u7ec4', '\u5de5\u4f5c\u7ec4', '\u4e1a\u52a1\u5206\u7ec4']);
    }

    if (groupType === 'WebApplication') {
      return this.extractSuffixValue(text.raw, ['Web\u5e94\u7528', 'web\u5e94\u7528', '\u7f51\u7ad9']);
    }

    if (groupType === 'Application') {
      return this.extractSuffixValue(text.raw, ['\u4e1a\u52a1\u5e94\u7528', '\u4e1a\u52a1', '\u5e94\u7528', '\u670d\u52a1\u5668\u5e94\u7528', '\u670d\u52a1\u5e94\u7528', 'app', 'application']);
    }

    return undefined;
  }

  /**
   * 鎻愬彇鍛藉悕涓氬姟缁勮寖鍥?   * @param {string} rawText - 鍘熷鏂囨湰
   * @returns {string|undefined} - 涓氬姟缁勫悕绉?   */
  extractNamedBusinessGroupScope(rawText) {
    const raw = String(rawText || '').trim();
    if (!raw) {
      return undefined;
    }

    const quoted = this.extractQuotedValue(raw);
    if (quoted && /\u7f51\u6bb5/.test(quoted) && !this.looksLikeIpScopedPrefix(quoted)) {
      return quoted;
    }

    const matches = Array.from(raw.matchAll(/([A-Za-z0-9_\-\u4e00-\u9fa5]{2,30}\u7f51\u6bb5)/g))
      .map(item => String(item[1] || '').trim())
      .filter(Boolean);

    const ignored = new Set(['\u8fd9\u4e2a\u7f51\u6bb5', '\u8be5\u7f51\u6bb5', '\u6b64\u7f51\u6bb5', '\u672c\u7f51\u6bb5']);
    const candidate = matches.find(item => !ignored.has(item) && !this.looksLikeIpScopedPrefix(item));
    return candidate || undefined;
  }

  /**
   * 鎻愬彇闅愬紡鍛藉悕瀵硅薄
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {object|null} - 闅愬紡瀵硅薄淇℃伅
   */
  extractImplicitNamedObject(text) {
    const raw = String(text?.raw || '').trim();
    if (!raw) {
      return null;
    }

    const candidates = [
      this.extractIpRankingAnchor(raw),
      this.extractStateDescriptionAnchor(raw),
      this.extractTrendAnchor(raw)
    ].filter(Boolean);

    for (const candidate of candidates) {
      const normalized = this.normalizeImplicitObjectCandidate(candidate.argument);
      if (!normalized || this.isInvalidGroupArgumentCandidate(normalized)) {
        continue;
      }

      const type = candidate.type || this.inferImplicitObjectType(normalized, text);
      if (!type) {
        continue;
      }

      return {
        type,
        argument: normalized
      };
    }

    return null;
  }

  /**
   * 鎻愬彇 IP 鎺掑悕閿氱偣
   * @param {string} raw - 鍘熷鏂囨湰
   * @returns {object|null} - IP 鎺掑悕閿氱偣淇℃伅
   */
  extractIpRankingAnchor(raw) {
    const patterns = [
      /^(?:查看|看一下|看看|查询|查一下|分析(?:一下)?|帮我看|帮我查)?\s*(?:访问|查看访问)?\s*([A-Za-z0-9_\-\u4e00-\u9fa5]{2,40})\s*(?:的)?\s*(?:前|第)?(?:[\u4e00-\u4e5d\u5341\u767e\d]+)?\s*(?:个)?\s*(?:IP|IP地址|客户端IP|服务端IP)(?:排行|排名|top\s*\d+)?/i,
      /^(?:查看|看一下|看看|查询|查一下|分析(?:一下)?|帮我看|帮我查)?\s*([A-Za-z0-9_\-\u4e00-\u9fa5]{2,40})\s*(?:的)?\s*(?:客户端IP|服务端IP|IP排行|IP排名|IP地址)/i
    ];

    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (match?.[1]) {
        return {
          argument: match[1]
        };
      }
    }

    return null;
  }

  /**
   * 鎻愬彇鐘舵€佹弿杩伴敋鐐?   * @param {string} raw - 鍘熷鏂囨湰
   * @returns {object|null} - 鐘舵€佹弿杩伴敋鐐逛俊鎭?   */
  extractStateDescriptionAnchor(raw) {
    const patterns = [
      /^([A-Za-z0-9_\-\u4e00-\u9fa5]{2,40})\s*(?:今天|昨天|最近|近期|当前|目前|现在).*(?:异常|有问题|不稳定|很卡|很慢|偏慢|变慢)/,
      /^([A-Za-z0-9_\-\u4e00-\u9fa5]{2,40})\s*(?:异常吗|有问题吗|稳定吗|卡吗|慢吗)/
    ];

    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (match?.[1]) {
        return {
          argument: match[1]
        };
      }
    }

    return null;
  }

  /**
   * 鎻愬彇瓒嬪娍閿氱偣
   * @param {string} raw - 鍘熷鏂囨湰
   * @returns {object|null} - 瓒嬪娍閿氱偣淇℃伅
   */
  extractTrendAnchor(raw) {
    const patterns = [
      /^(?:查看|看一下|看看|查询|查一下|分析(?:一下)?)?\s*([A-Za-z0-9_\-\u4e00-\u9fa5]{2,40})\s*(?:的)?\s*(?:响应时间|时延|流量|吞吐|访问量|错误率).*(?:趋势|变化|曲线)/i,
      /^([A-Za-z0-9_\-\u4e00-\u9fa5]{2,40})\s*(?:的)?\s*(?:趋势|变化|曲线)/i
    ];

    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (match?.[1]) {
        return {
          argument: match[1]
        };
      }
    }

    return null;
  }

  /**
   * 瑙勮寖鍖栭殣寮忓璞″€欓€夊€?   * @param {string} value - 鍊欓€夊€?   * @returns {string} - 瑙勮寖鍖栧悗鐨勫€?   */
  normalizeImplicitObjectCandidate(value) {
    return String(value || '')
      .trim()
      .replace(/^(?:(?:查看|看一下|看看|查询|查一下|分析(?:一下)?|帮我看|帮我查|帮我分析|访问|查看访问)\s*)+/, '')
      .replace(/(?:的)+$/, '')
      .trim();
  }

  looksLikeEmbeddedWebName(candidate = '') {
    const normalized = String(candidate || '').trim();
    if (!normalized) {
      return false;
    }

    const lower = normalized.toLowerCase();
    if (!lower.includes('web')) {
      return false;
    }

    if (/(?:web应用|webapplication|网站|站点)/i.test(normalized)) {
      return false;
    }

    return /[\u4e00-\u9fa5a-z0-9]web$/i.test(normalized)
      || /web[\u4e00-\u9fa5a-z0-9]/i.test(normalized);
  }

  isNamedAccessIpQuery(rawText = '') {
    const raw = String(rawText || '').trim();
    if (!raw) {
      return false;
    }

    return /访问.+(?:IP地址|IP|ip).*(?:排行|排名|top|前\s*[\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\d]+)/i.test(raw)
      || /(?:前\s*[\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\d]+\s*个\s*IP|top\s*\d+\s*ip).+访问/i.test(raw);
  }

  /**
   * 鎺ㄦ柇闅愬紡瀵硅薄绫诲瀷
   * @param {string} candidate - 鍊欓€夊€?   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {string|null} - 瀵硅薄绫诲瀷
   */
  inferImplicitObjectType(candidate, text) {
    const raw = String(text?.raw || '');
    const lowerCandidate = String(candidate || '').toLowerCase();

    if (!candidate) {
      return null;
    }

    if (/(业务组|业务分组|工作组)/.test(candidate)) {
      return 'BusinessGroup';
    }

    if (/(业务应用)/.test(candidate)) {
      return 'Application';
    }

    if (/(web应用|Web应用|网站|站点)/.test(candidate)) {
      return 'WebApplication';
    }

    if (/web/.test(lowerCandidate)) {
      if (
        this.isNamedAccessIpQuery(raw)
        || this.isBusinessApplicationIntent(text)
        || (
          this.looksLikeEmbeddedWebName(candidate)
          && !this.isBusinessWebApplicationIntent(text)
        )
      ) {
        return 'Application';
      }
      return 'WebApplication';
    }

    if (this.isWebsiteIntent(text)) {
      return 'WebApplication';
    }

    if (this.isBusinessWebApplicationIntent(text)) {
      return 'WebApplication';
    }

    if (this.isBusinessSystemIntent(text)) {
      return 'BusinessGroup';
    }

    if (this.isBusinessApplicationIntent(text)) {
      return 'Application';
    }

    if (/^[A-Z][A-Z0-9_\-]{1,20}$/.test(candidate)) {
      return 'Application';
    }

    if (/(今天|昨天|最近|近期|当前|目前|现在).*(异常|有问题|不稳定|很卡|很慢|偏慢|变慢)/.test(raw)) {
      return 'Application';
    }

    return null;
  }

  /**
   * 鍒ゆ柇鏄惁绫讳技 IP 浣滅敤鍩熷墠缂€
   * @param {string} value - 鍊?   * @returns {boolean} - 鏄惁绫讳技 IP 鍓嶇紑
   */
  looksLikeIpScopedPrefix(value) {
    return /(?:\d{1,3}\.){2}\d{1,3}(?:\.\d{1,3})?(?:\/24)?/.test(String(value || ''));
  }

  /**
   * 鍒ゆ柇鏄惁涓哄娉涘垎缁勫紩鐢?   * @param {string} rawText - 鍘熷鏂囨湰
   * @param {string} groupType - 鍒嗙粍绫诲瀷
   * @returns {boolean} - 鏄惁涓哄娉涘紩鐢?   */
  isBroadGroupReference(rawText, groupType) {
    const raw = String(rawText || '').trim();
    if (!raw) {
      return false;
    }

    if (!new Set(['BusinessGroup', 'WebApplication', 'Application']).has(groupType)) {
      return false;
    }

    if (this.extractQuotedValue(raw)) {
      return false;
    }

    if (this.extractLabeledObjectPhrase(raw, groupType)) {
      return false;
    }

    const genericLead = /(?:\u54ea\u4e2a|\u54ea\u4e00\u4e2a|\u54ea\u7c7b|\u54ea\u79cd|\u54ea\u5957|\u54ea\u4e9b|\u8c01|\u4ec0\u4e48|\u770b\u770b|\u770b\u4e00\u4e0b|\u5e2e\u6211\u770b|\u67e5\u8be2\u4e00\u4e0b|\u67e5\u4e00\u4e0b)/;
    const genericTail = /(?:\u662f\u8c01|\u662f\u54ea\u4e2a|\u6709\u54ea\u4e9b|\u600e\u4e48\u6837|\u5982\u4f55|\u60c5\u51b5|\u8d8b\u52bf|\u6392\u884c|\u6392\u540d|top\d*|top|\u5f02\u5e38|\u62a5\u9519|\u5931\u8d25|\u6700\u6162|\u6700\u5361|\u6700\u5feb|\u6700\u597d|\u6700\u5dee|\u6700\u9ad8|\u6700\u591a|\u6700\u5c11|\u6ce2\u52a8|\u6709\u95ee\u9898|\u4e0d\u7a33\u5b9a|\u5f88\u5361|\u5f88\u6162)/;
    const broadBusiness = /(?:\u4e1a\u52a1\u7ec4|\u5de5\u4f5c\u7ec4|\u4e1a\u52a1\u5206\u7ec4)/;
    const broadBusinessWeb = /(?:^|[^A-Za-z])\u4e1a\u52a1(?:[^\u7ec4\u7cfb\u7edfA-Za-z]|$)/;
    const broadWebsite = /(?:\u7f51\u7ad9|\u7ad9\u70b9|Web\u5e94\u7528|web\u5e94\u7528|web\u7ad9\u70b9)/i;
    const broadApplication = /(?:\u4e1a\u52a1\u5e94\u7528|(?:^|[^A-Za-z])(\u5e94\u7528|app|application)(?:[^A-Za-z]|$))/i;

    if (groupType === 'BusinessGroup' && broadBusiness.test(raw) && (genericLead.test(raw) || genericTail.test(raw))) {
      return true;
    }

    if (groupType === 'WebApplication' && (broadWebsite.test(raw) || broadBusinessWeb.test(raw)) && (genericLead.test(raw) || genericTail.test(raw))) {
      return true;
    }

    if (groupType === 'Application' && broadApplication.test(raw) && (genericLead.test(raw) || genericTail.test(raw))) {
      return true;
    }

    return false;
  }

  /**
   * 鎻愬彇鍚庣紑鍊?   * @param {string} rawText - 鍘熷鏂囨湰
   * @param {array} labels - 鏍囩鍒楄〃
   * @returns {string|undefined} - 鎻愬彇鐨勫€?   */
  extractSuffixValue(rawText, labels) {
    for (const label of labels) {
      const normalizedPattern = new RegExp(`${label}\s*(?:\u4e3a|\u662f|=|:|\uff1a)?\s*([A-Za-z0-9._\-\u4e00-\u9fa5]+)`);
      const normalizedMatch = rawText.match(normalizedPattern);
      if (normalizedMatch) {
        const normalizedCandidate = normalizedMatch[1];
        if (!this.isInvalidGroupArgumentCandidate(normalizedCandidate)) {
          return normalizedCandidate;
        }
      }

      const pattern = new RegExp(`${label}(?:\u4e3a|\u662f|=|:|\uff1a)?\s*([A-Za-z0-9._\-\u4e00-\u9fa5]+)`);
      const match = rawText.match(pattern);
      if (match) {
        const candidate = match[1];
        if (this.isInvalidGroupArgumentCandidate(candidate)) {
          continue;
        }
        return candidate;
      }
    }

    return undefined;
  }

  /**
   * 瑙ｆ瀽璇箟绾︽潫
   * @param {object} options - 閫夐」瀵硅薄
   * @returns {object} - 璇箟绾︽潫瀵硅薄
   */
  resolveSemanticConstraints({
    text,
    service,
    metricInfo,
    group,
    objectCandidates = [],
    scopeHints = [],
    topCount,
    timeRange
  }) {
    const targetObjectType = this.resolveTargetObjectType(text, group, service, objectCandidates);
    let anchorObject = this.resolveAnchorObject(text, group, targetObjectType);
    if (!anchorObject && group?.type && this.groupTypeSupportsArgument(group.type) && group.type !== targetObjectType) {
      const scopeArgument = (Array.isArray(scopeHints) ? scopeHints : [])
        .map((item) => String(item || '').trim())
        .find((item) => item && !this.isInvalidGroupArgumentCandidate(item));
      if (scopeArgument) {
        anchorObject = {
          type: group.type,
          argument: scopeArgument
        };
      }
    }
    const operation = this.resolveOperationMode(text, service);

    return {
      operation,
      anchorObject,
      targetObjectType,
      objectCandidates: Array.isArray(objectCandidates) ? objectCandidates.slice(0, 6) : [],
      scopeHints: Array.isArray(scopeHints) ? scopeHints.slice(0, 6) : [],
      metricHint: metricInfo?.family || metricInfo?.metric || null,
      topCount: topCount !== null && topCount !== undefined && Number.isFinite(Number(topCount))
        ? Number(topCount)
        : null,
      timeRange: timeRange ? {
        start: timeRange.start,
        end: timeRange.end
      } : null
    };
  }

  /**
   * 瑙ｆ瀽鎿嶄綔妯″紡
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @param {string} service - 鏈嶅姟绫诲瀷
   * @returns {string} - 鎿嶄綔妯″紡
   */
  resolveOperationMode(text, service) {
    if (service === 'groups') {
      return 'metadata_list';
    }

    if (service === 'timeValues') {
      return 'trend';
    }

    if (service === 'averageValues') {
      return 'overview';
    }

    if (this.looksLikeRankingIntent(text)) {
      return 'ranking';
    }

    return service === 'topValues' ? 'ranking' : 'direct_query';
  }

  /**
   * 瑙ｆ瀽鐩爣瀵硅薄绫诲瀷
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @param {object} group - 鍒嗙粍瀵硅薄
   * @param {string} service - 鏈嶅姟绫诲瀷
   * @returns {string|null} - 鐩爣瀵硅薄绫诲瀷
   */
    resolveTargetObjectType(text, group, service, objectCandidates = []) {
    const raw = String(text?.raw || '');
    const currentType = String(group?.type || '').trim();
    const normalizedCandidates = (Array.isArray(objectCandidates) ? objectCandidates : [])
      .map((item) => ({
        type: String(item?.type || item?.objectType || '').trim(),
        score: Number(item?.score || 0),
        reason: String(item?.reason || ''),
        source: String(item?.source || '')
      }))
      .filter((item) => item.type)
      .sort((a, b) => b.score - a.score);
    const explicitCandidate = normalizedCandidates.find((item) => (
      item.score >= 0.9
      || /explicit_object/i.test(item.reason)
      || item.source === 'explicit_object_signal'
    )) || null;
    const topCandidate = normalizedCandidates[0] || null;

    if (service === 'groups' || !currentType) {
      return explicitCandidate?.type || topCandidate?.type || currentType || null;
    }

    if (/(?:ip\s*会话|IP会话|会话对|conversation)/i.test(raw)) {
      return 'IPConversation';
    }

    if (/(?:客户端\s*IP|客户端IP|client\s*ip|clientips)/i.test(raw)) {
      return 'IPAddress';
    }

    if (/(?:服务端\s*IP|服务端IP|server\s*ip|serverips)/i.test(raw)) {
      return 'IPAddress';
    }

    if (
      /(?:IP地址|源IP|客户端IP|服务端IP|IP排行|IP排名|前\s*[一二两三四五六七八九十\d]+\s*个\s*IP|top\s*\d+\s*ip|\bip\b)/i.test(raw)
      && new Set(['WebApplication', 'Application', 'BusinessGroup', 'PageFamily']).has(currentType)
    ) {
      return 'IPAddress';
    }

    if (explicitCandidate) {
      return explicitCandidate.type;
    }

    if (topCandidate && topCandidate.score >= 0.72) {
      return topCandidate.type;
    }

    return currentType;
  }

  /**
   * 瑙ｆ瀽閿氱偣瀵硅薄
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @param {object} group - 鍒嗙粍瀵硅薄
   * @param {string} targetObjectType - 鐩爣瀵硅薄绫诲瀷
   * @returns {object|null} - 閿氱偣瀵硅薄
   */
  resolveAnchorObject(text, group, targetObjectType) {
    if (!group?.type || !group?.argument) {
      return null;
    }

    if (group.type === targetObjectType) {
      return null;
    }

    return {
      type: group.type,
      argument: group.argument
    };
  }

  /**
   * 鍒ゆ柇鏄惁绫讳技鎺掑悕鎰忓浘
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @param {number} topCount - TopN 鏁伴噺
   * @returns {boolean} - 鏄惁涓烘帓鍚嶆剰鍥?   */
  looksLikeRankingIntent(text, topCount = null) {
    const raw = String(text?.raw || '');
    if (!raw) {
      return false;
    }

    if (Number.isFinite(Number(topCount)) && Number(topCount) > 0) {
      return true;
    }

    return /(?:\u6392\u884c|\u6392\u540d|top|\u54ea\u4e2a|\u54ea\u4e00\u4e2a|\u54ea\u51e0\u4e2a|\u662f\u8c01|\u8c01\u6700\u591a|\u8c01\u6700\u6162|\u8c01\u6700\u9ad8|\u6700\u6162|\u6700\u5361|\u6700\u5feb|\u6700\u597d|\u6700\u5dee|\u6700\u9ad8|\u6700\u4f4e|\u6700\u591a|\u6700\u5c11|\u524d\s*[\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\d]+)/i.test(raw);
  }
  /**
   * 鎻愬彇涓枃搴忔暟 TopN 鏁伴噺
   * @param {string} rawText - 鍘熷鏂囨湰
   * @returns {number|null} - TopN 鏁伴噺
   */
  extractChineseOrdinalTopCount(rawText = '') {
    const raw = String(rawText || '');
    const match = raw.match(/\u524d\s*([\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\d]{1,3})\s*(?:\u4e2a|\u6761|\u540d|\u4f4d|\u5bb6|\u7ec4|\u9879)?/);
    if (!match?.[1]) {
      return null;
    }

    const token = String(match[1]).trim();
    if (/^\d+$/.test(token)) {
      return Number(token);
    }

    const map = {
      '\u4e00': 1,
      '\u4e8c': 2,
      '\u4e24': 2,
      '\u4e09': 3,
      '\u56db': 4,
      '\u4e94': 5,
      '\u516d': 6,
      '\u4e03': 7,
      '\u516b': 8,
      '\u4e5d': 9,
      '\u5341': 10
    };

    if (Object.prototype.hasOwnProperty.call(map, token)) {
      return map[token];
    }

    if (token.length === 2 && token.startsWith('\u5341') && map[token[1]]) {
      return 10 + map[token[1]];
    }

    if (token.length === 2 && token.endsWith('\u5341') && map[token[0]]) {
      return map[token[0]] * 10;
    }

    return null;
  }

  /**
   * 鎻愬彇甯︽爣绛剧殑瀵硅薄鐭
   * @param {string} rawText - 鍘熷鏂囨湰
   * @param {string} groupType - 鍒嗙粍绫诲瀷
   * @returns {string|undefined} - 瀵硅薄鐭
   */
  extractLabeledObjectPhrase(rawText, groupType) {
    const raw = String(rawText || '').trim();
    if (!raw) {
      return undefined;
    }

    const labelTokens = {
      BusinessGroup: ['业务组', '工作组', '业务分组'],
      WebApplication: ['业务', '业务系统', 'Web应用', 'web应用', 'webApplication', '网站', '站点'],
      Application: ['业务应用', '应用', 'app', 'application']
    };

    const labels = labelTokens[groupType];
    if (!Array.isArray(labels) || labels.length === 0) {
      return undefined;
    }

    const matches = [];
    const valueToken = '[A-Za-z0-9_\\.\\-\\u4e00-\\u9fa5]{1,40}';

    for (const label of labels) {
      const escapedLabel = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const suffixMatcher = new RegExp(`(${valueToken})\\s*${escapedLabel}`, 'ig');
      let suffixMatch = suffixMatcher.exec(raw);
      while (suffixMatch) {
        matches.push(String(suffixMatch[1] || '').trim());
        suffixMatch = suffixMatcher.exec(raw);
      }

      const prefixMatcher = new RegExp(`${escapedLabel}\\s*(?:为|是|=|:|：)?\\s*(${valueToken})`, 'ig');
      let prefixMatch = prefixMatcher.exec(raw);
      while (prefixMatch) {
        matches.push(String(prefixMatch[1] || '').trim());
        prefixMatch = prefixMatcher.exec(raw);
      }
    }

    const cleaned = matches
      .map((item) => item
        .replace(/^(?:(?:查看|看一下|看看|分析|查询|查一下|查|访问统计|关于|针对|帮我看|帮我查|帮我分析)\s*)+/, '')
        .replace(/(?:的)?(?:前\s*[\u4e00-\u4e5d\u5341\d]+\s*(?:个|条|名)?|top\s*\d+|排行|排名|趋势|情况|流量|性能|详情|信息|客户端IP|服务端IP|IP地址|IP)$/i, '')
        // 过滤“在系统中哪个业务”这类范围提示前缀，避免误当实体参数
        .replace(/^(?:在)?(?:系统中|系统里|系统内|当前系统中|当前系统里|本系统|全网中|网络中)\s*(?=(?:哪个|哪一个|哪类|哪种|哪些|什么|谁))/, '')
        .trim())
      .filter(item => item && !this.isInvalidGroupArgumentCandidate(item));

    return cleaned[0] || undefined;
  }

  /**
   * 鍒ゆ柇鏄惁涓烘棤鏁堝垎缁勫弬鏁板€欓€夊€?   * @param {string} value - 鍊欓€夊€?   * @returns {boolean} - 鏄惁鏃犳晥
   */
  isInvalidGroupArgumentCandidate(value) {
    const candidate = String(value || '').trim();
    if (!candidate) {
      return true;
    }

    if (/^(?:谁|哪个|哪一个|哪类|哪种|哪些|什么|这里|那里|这个|那个)$/u.test(candidate)) {
      return true;
    }

    if (/^(?:最慢|最卡|最快|最好|最差|最高|最低|最多|最少|最稳|最不稳|最异常|最严重|最明显)$/u.test(candidate)) {
      return true;
    }

    if (/^(?:很慢|很卡|有问题|异常|报错|失败|趋势|排行|排名|情况|怎么样|如何|波动|不稳定)$/u.test(candidate)) {
      return true;
    }

    if (/^(?:今天|昨天|最近|近期|当前|目前|现在)$/u.test(candidate)) {
      return true;
    }

    if (/^(?:(?:哪个|哪一个|哪类|哪种|哪些|什么|谁|查看|看一下|看看|分析|查询|查|访问|统计|关于|针对|报错最多的|失败最多的|最慢的|最卡的|最快的|最好的|最差的|最高的|最多的|最少的|前\s*[\u4e00-\u4e5d\u5341\d]+\s*个?)\s*)*(?:业务系统|业务组|业务分组|业务应用|业务|应用|Web应用|web应用|网站|站点)$/iu.test(candidate)) {
      return true;
    }

    if (/^(?:现在|当前|目前|今天|昨日|昨天|最近|近期)\s*(?:(?:哪个|哪一个|哪类|哪种|哪些|什么|谁)\s*)?(?:业务系统|业务组|业务分组|业务应用|业务|应用|Web应用|web应用|网站|站点)$/iu.test(candidate)) {
      return true;
    }

    if (/^(?:在)?(?:系统中|系统里|系统内|当前系统中|当前系统里|本系统|全网中|网络中)\s*(?:(?:哪个|哪一个|哪类|哪种|哪些|什么|谁)\s*)?(?:业务系统|业务组|业务分组|业务应用|业务|应用|Web应用|web应用|网站|站点)$/iu.test(candidate)) {
      return true;
    }

    if (/^(?:报错|错误|失败|异常|排名|排行|top\d*|top|趋势|流量|时延|延迟|响应|丢包|重传|http|4xx|5xx|400|500|最大|最小|最高|最低)$/iu.test(candidate)) {
      return true;
    }

    return /^(?:\u652f\u6301|\u652f\u6301\u7684|\u652f\u6301\u7684\u6307\u6807|\u6307\u6807|\u76f8\u5173|\u76f8\u5173\u6307\u6807|\u5217\u8868|\u5168\u90e8|\u6709\u54ea\u4e9b|\u67e5\u8be2)$/.test(candidate);
  }

  /**
   * 鏋勫缓鎸囨爣鍒楄〃杩囨护鍣?   * @param {object} metricInfo - 鎸囨爣淇℃伅瀵硅薄
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {object|null} - 鎸囨爣杩囨护鍣?   */
  buildMetricListFilter(metricInfo, text) {
    const familyMap = {
      throughput: ['TPI', 'TPO', 'TPIO'],
      traffic: ['BYTI', 'BYTO', 'BYTIO'],
      packet_loss: ['PLI', 'PLO']
    };
    const raw = String(text?.raw || '');
    const lower = raw.toLowerCase();

    const semanticFilters = [
      {
        label: 'http_error',
        test: /(http|https).*(閿欒|寮傚父|error)|\b4xx\b|\b5xx\b/i,
        metricCodes: ['PGHTTP400', 'PGHTTP500', 'PGHTTP400PCT', 'PGHTTP500PCT']
      },
      {
        label: 'response_time',
        test: /(鍝嶅簲鏃堕棿|椤甸潰鏃跺欢|椤甸潰鍝嶅簲|椤甸潰鑰楁椂|server response|response time)/i,
        metricCodes: ['TRTI', 'TRTO', 'PGTME', 'PGTMS', 'PGTMC']
      },
      {
        label: 'retransmission',
        test: /(閲嶄紶|retrans)/i,
        metricCodes: ['RDTI', 'RDTO', 'RTXI', 'RTXO']
      },
      {
        label: 'rtt',
        test: /(rtt|寰€杩旀椂闂磡鏃跺欢|鏃跺欢鍊紎latency)/i,
        metricCodes: ['RTTI', 'RTTO', 'TRTT', 'TRTT1', 'TRTT2']
      },
      {
        label: 'packet_loss',
        test: /(涓㈠寘|涓㈠寘鐜噟loss)/i,
        metricCodes: ['PLI', 'PLO']
      },
      {
        label: 'throughput',
        test: /(閸氱偛鎮檤鐢箑顔攟throughput|bandwidth)/i,
        metricCodes: ['TPI', 'TPO', 'TPIO']
      },
      {
        label: 'traffic',
        test: /(濞翠線鍣簗traffic)/i,
        metricCodes: ['BYTI', 'BYTO', 'BYTIO']
      }
    ];

    const semanticMatch = semanticFilters.find(item => item.test.test(raw) || item.test.test(lower));
    if (semanticMatch) {
      return {
        type: 'metric_codes',
        label: semanticMatch.label,
        metricCodes: semanticMatch.metricCodes
      };
    }

    if (!metricInfo?.explicit || !metricInfo.metric) {
      return null;
    }

    if (metricInfo.family && familyMap[metricInfo.family]) {
      return {
        type: 'metric_codes',
        label: metricInfo.family,
        metricCodes: familyMap[metricInfo.family]
      };
    }

    if (/rtt/i.test(raw) || ['RTTI', 'RTTO', 'TRTT', 'TRTT1', 'TRTT2'].includes(metricInfo.metric)) {
      return {
        type: 'metric_codes',
        label: 'rtt',
        metricCodes: ['RTTI', 'RTTO', 'TRTT', 'TRTT1', 'TRTT2']
      };
    }

    if (/http/i.test(raw) || String(metricInfo.metric).startsWith('PGHTTP')) {
      return {
        type: 'metric_codes',
        label: 'http',
        metricCodes: [
          'PGHTTP100', 'PGHTTP200', 'PGHTTP300', 'PGHTTP400', 'PGHTTP500',
          'PGHTTP100PCT', 'PGHTTP200PCT', 'PGHTTP300PCT', 'PGHTTP400PCT', 'PGHTTP500PCT',
          'PGNOBJE'
        ]
      };
    }

    const domainId = DimensionMappingService.getMetricDomain(metricInfo.metric);
    if (domainId) {
      const domainMeta = DimensionMappingService.getDomainMeta(domainId);
      return {
        type: 'domain',
        label: domainMeta?.label || domainId,
        domainId
      };
    }

    return {
      type: 'metric_codes',
      label: metricInfo.metric,
      metricCodes: [metricInfo.metric]
    };
  }

  /**
   * 鏋勫缓瑙ｆ瀽鍚庣殑鏌ヨ瀵硅薄
   * @param {object} options - 鏋勫缓閫夐」
   * @returns {object} - 瑙ｆ瀽鍚庣殑鏌ヨ瀵硅薄
   */
  buildResolvedQuery({
    originalText,
    service,
    timeRange,
    metricInfo,
    group,
    topCount,
    topCountInfo = null,
    timeRangeInfo = null,
    granularity,
    semanticConstraints = null,
    candidateSpec = null,
    objectCandidates = [],
    metricCandidates = [],
    scopeHints = [],
    intent = null
  }) {
    const metric = metricInfo.metric;
    const targetGroupType = semanticConstraints?.targetObjectType || group.type;
    const resolvedQuery = {
      service,
      start: timeRange.start,
      end: timeRange.end,
      format: this.mappingConfig.defaults.format,
      userRequirement: originalText,
      resolutionHints: {
        metric: {
          metric,
          explicit: Boolean(metricInfo?.explicit),
          defaulted: Boolean(metricInfo?.defaulted),
          family: metricInfo?.family || null,
          source: metricInfo?.source || null,
          aliasScore: Number(metricInfo?.aliasScore || 0)
        },
        group: {
          type: targetGroupType || null,
          argument: targetGroupType === group?.type ? (group?.argument || null) : null,
          explicit: Boolean(group?.resolution?.explicit),
          defaulted: Boolean(group?.resolution?.defaulted),
          source: group?.resolution?.source || null,
          aliasScore: Number(group?.resolution?.alias_score || 0),
          argumentExplicit: Boolean(group?.resolution?.argument_explicit),
          candidates: Array.isArray(objectCandidates)
            ? objectCandidates.slice(0, 4).map(item => ({
              objectType: item?.objectType || item?.type || null,
              score: Number(item?.score || 0),
              argumentCandidate: item?.argumentCandidate || item?.argument || null,
              source: item?.source || null
            })).filter(item => item.objectType)
            : []
        },
        time: {
          key: timeRange?.key || null,
          explicit: Boolean(timeRangeInfo?.explicit),
          defaulted: Boolean(timeRangeInfo?.defaulted),
          source: timeRangeInfo?.source || null
        },
        topCount: {
          value: topCount === null || topCount === undefined
            ? null
            : (Number.isFinite(Number(topCount)) ? Number(topCount) : null),
          explicit: Boolean(topCountInfo?.explicit),
          defaulted: Boolean(topCountInfo?.defaulted),
          source: topCountInfo?.source || null
        },
        metricCandidates: Array.isArray(metricCandidates) ? metricCandidates.slice(0, 6) : [],
        scopeHints: Array.isArray(scopeHints) ? scopeHints.slice(0, 6) : []
      }
    };

    if (intent) {
      resolvedQuery.intent = intent;
    }

    if (candidateSpec) {
      resolvedQuery.candidateSpec = candidateSpec;
    }

    if (Array.isArray(metricCandidates) && metricCandidates.length > 0) {
      resolvedQuery.metricCandidates = metricCandidates.slice(0, 6);
    }

    if (Array.isArray(scopeHints) && scopeHints.length > 0) {
      resolvedQuery.scopeHints = scopeHints.slice(0, 6);
    }

    if (semanticConstraints) {
      resolvedQuery.semanticConstraints = semanticConstraints;
      if (semanticConstraints.operation === 'ranking') {
        resolvedQuery.queryModeKey = 'ranking';
      } else if (semanticConstraints.operation === 'trend') {
        resolvedQuery.queryModeKey = 'trend';
      } else if (semanticConstraints.operation === 'overview') {
        resolvedQuery.queryModeKey = 'overview';
      }
    }

    if (service === 'metrics') {
      const metricFilter = this.buildMetricListFilter(metricInfo, { raw: originalText });
      if (metricFilter) {
        resolvedQuery.metricFilter = metricFilter;
      }
      if (this.shouldAttachGroupFilterForMetricListing(originalText, group)) {
        resolvedQuery.groups = [{ type: group.type, argument: group.argument }];
      }
      return resolvedQuery;
    }

    if (service === 'groups') {
      const lower = String(originalText || '').toLowerCase();
      resolvedQuery.topLevelOnly = /椤跺眰|涓€绾top-level|top level|root/.test(String(originalText || '')) &&
        /鍒嗙粍|瀵硅薄|缁村害|group|type/.test(lower);
      if (this.shouldAttachGroupFilterForGroupListing(originalText, group)) {
        resolvedQuery.groups = [{ type: group.type, argument: group.argument }];
      }
      return resolvedQuery;
    }

    resolvedQuery.metric = metric;
    resolvedQuery.metrics = [metric];
    resolvedQuery.groups = [{
      type: targetGroupType,
      argument: targetGroupType === group.type ? group.argument : undefined
    }];

    if (semanticConstraints?.anchorObject) {
      resolvedQuery.contextGroups = [{
        type: semanticConstraints.anchorObject.type,
        argument: semanticConstraints.anchorObject.argument
      }];
    }

    if (service === 'topValues') {
      resolvedQuery.topCount = topCount;
    }

    if (service === 'timeValues') {
      resolvedQuery.granularity = granularity;
    }

    return resolvedQuery;
  }

  /**
   * 璁＄畻缃俊搴?   * @param {object} evidence - 璇佹嵁瀵硅薄
   * @returns {number} - 缃俊搴﹀垎鏁?   */
  calculateConfidence(evidence) {
    let score = 0.2;

    if (evidence.service) {
      score += 0.2;
    }
    if (evidence.metric) {
      score += 0.2;
    }
    if (evidence.group && evidence.group.type) {
      score += 0.15;
    }
    if (evidence.timeRange && evidence.timeRange.start && evidence.timeRange.end) {
      score += 0.15;
    }
    if (evidence.topCount || evidence.granularity) {
      score += 0.1;
    }
    if (Array.isArray(evidence.questionPatterns) && evidence.questionPatterns.length > 0) {
      score += 0.05;
    }
    if (evidence.selectedIntent?.score >= 0.8) {
      score += 0.05;
    }

    if (evidence.metricResolution?.explicit === false) {
      score -= evidence.metricResolution?.defaulted ? 0.14 : 0.08;
    }

    if (evidence.groupResolution?.explicit === false) {
      score -= evidence.groupResolution?.defaulted ? 0.18 : 0.1;
    }

    if (evidence.timeResolution?.explicit === false && evidence.service === 'timeValues') {
      score -= 0.06;
    }

    return Number(Math.max(0.2, Math.min(score, 0.95)).toFixed(2));
  }

  /**
   * 鏄犲皠鏈嶅姟绫诲瀷鍒版剰鍥?   * @param {string} service - 鏈嶅姟绫诲瀷
   * @returns {string} - 鎰忓浘绫诲瀷
   */
  mapServiceToIntent(service) {
    const mapping = {
      topValues: 'ranking',
      timeValues: 'timeseries',
      averageValues: 'average',
      groups: 'metadata_groups',
      metrics: 'metadata_metrics'
    };
    return mapping[service] || service || 'direct_query';
  }

  /**
   * 鏄犲皠妯″紡閿埌鏈嶅姟绫诲瀷
   * @param {string} patternKey - 妯″紡閿?   * @returns {string} - 鏈嶅姟绫诲瀷
   */
  mapPatternToService(patternKey) {
    const mapping = {
      ranking: 'topValues',
      timeseries: 'timeValues',
      average: 'averageValues',
      metadata: 'groups',
      overview_first: 'averageValues',
      diagnose: 'averageValues',
      direct_query: this.mappingConfig.defaults.service
    };
    return mapping[patternKey] || this.mappingConfig.defaults.service;
  }

  /**
   * 鍒ゆ柇鍒嗙粍绫诲瀷鏄惁鏀寔鍙傛暟
   * @param {string} groupType - 鍒嗙粍绫诲瀷
   * @returns {boolean} - 鏄惁鏀寔鍙傛暟
   */
  groupTypeSupportsArgument(groupType) {
    return new Set(['BusinessGroup', 'WebApplication', 'Application', 'Prefix24', 'IPAddress', 'IPConversation']).has(groupType);
  }

  /**
   * 楠岃瘉鎸囨爣浠ｇ爜
   * @param {string} metricCode - 鎸囨爣浠ｇ爜
   * @returns {string} - 楠岃瘉鍚庣殑鎸囨爣浠ｇ爜
   */
  validateMetric(metricCode) {
    if (MetricMappingService.isValidMetricCode(metricCode)) {
      return metricCode;
    }

    return this.mappingConfig.defaults.metric;
  }

  /**
   * 鎻愬彇寮曞彿涓殑鍊?   * @param {string} rawText - 鍘熷鏂囨湰
   * @returns {string|undefined} - 鎻愬彇鐨勫€?   */
  extractQuotedValue(rawText) {
    const values = Array.from(String(rawText || '').matchAll(/["'`\u201c\u201d\u2018\u2019\u300c\u300d]([^"'`\u201c\u201d\u2018\u2019\u300c\u300d]+)["'`\u201c\u201d\u2018\u2019\u300c\u300d]/g))
      .map(item => String(item[1] || '').trim())
      .filter(Boolean);
    return values[0];
  }

  /**
   * 璁＄畻鍒悕鍖归厤鍒嗘暟
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @param {array} aliases - 鍒悕鍒楄〃
   * @returns {number} - 鍖归厤鍒嗘暟
   */
  scoreAliases(text, aliases = []) {
    return aliases.reduce((score, alias) => {
      if (!alias) {
        return score;
      }

      const rawMatch = text.raw.includes(alias);
      const lowerMatch = text.lower.includes(String(alias).toLowerCase());

      if (rawMatch || lowerMatch) {
        return score + Math.max(String(alias).length / 10, 1);
      }

      return score;
    }, 0);
  }

  /**
   * 鍒ゆ柇鏄惁绫讳技鍗曚竴鎸囨爣鏌ヨ
   * @param {object} text - 瑙勮寖鍖栨枃鏈璞?   * @returns {boolean} - 鏄惁涓哄崟涓€鎸囨爣鏌ヨ
   */
  looksLikeSingularMetricLookup(text) {
    const hasTopIntent = this.mappingConfig.services
      .find(item => item.service === 'topValues')
      ?.aliases?.some(alias => text.lower.includes(String(alias).toLowerCase()));
    const hasTrendIntent = this.mappingConfig.services
      .find(item => item.service === 'timeValues')
      ?.aliases?.some(alias => text.lower.includes(String(alias).toLowerCase()));
    const hasListIntent = ['groups', 'metrics']
      .flatMap(service => this.mappingConfig.services.find(item => item.service === service)?.aliases || [])
      .some(alias => text.lower.includes(String(alias).toLowerCase()));
    const metricIntent = (this.mappingConfig.metricFamilies || []).some(item => (
      (item.aliases || []).some(alias => text.lower.includes(String(alias).toLowerCase()))
    )) || /(http.*閿欒鐜噟閿欒鐜噟鎴愬姛鐜噟鍝嶅簲鏁皘response count)/i.test(text.raw);

    return Boolean(metricIntent && !hasTopIntent && !hasTrendIntent && !hasListIntent);
  }
}

module.exports = new NaturalLanguageQueryMapper();




