/**
 * CandidateSpecBuilder
 *
 * Build a lightweight semantic candidate snapshot for later auditing,
 * clarification, and narration. This structure is intentionally stable:
 * downstream services only rely on a small set of fields.
 */
class CandidateSpecBuilder {
  clone(value) {
    return value && typeof value === 'object'
      ? JSON.parse(JSON.stringify(value))
      : value;
  }

  normalizeText(input = {}) {
    const raw = String(input.raw || input.originalText || '').trim();
    const normalized = String(input.normalized || raw).trim();
    const lower = String(input.lower || normalized.toLowerCase()).trim();
    return { raw, normalized, lower };
  }

  pushUnique(target, value) {
    const normalized = String(value || '').trim();
    if (normalized && !target.includes(normalized)) {
      target.push(normalized);
    }
  }

  buildObjectPhrases({ text, group, semanticConstraints, objectCandidates }) {
    const phrases = [];
    this.pushUnique(phrases, semanticConstraints?.anchorObject?.argument);
    this.pushUnique(phrases, semanticConstraints?.anchorObject?.value);
    this.pushUnique(phrases, group?.argument);

    (Array.isArray(objectCandidates) ? objectCandidates : []).forEach((item) => {
      this.pushUnique(phrases, item?.argumentCandidate);
      this.pushUnique(phrases, item?.argument);
      this.pushUnique(phrases, item?.value);
      this.pushUnique(phrases, item?.label);
    });

    if (phrases.length === 0 && group?.type) {
      this.pushUnique(phrases, group.type);
    }

    if (phrases.length === 0 && text?.raw) {
      const ipMatches = text.raw.match(/(?:\d{1,3}\.){3}\d{1,3}/g) || [];
      ipMatches.forEach((item) => this.pushUnique(phrases, item));
    }

    return phrases;
  }

  buildMetricPhrases({ text, metricInfo, metricCandidates }) {
    const phrases = [];
    this.pushUnique(phrases, metricInfo?.metric);
    this.pushUnique(phrases, metricInfo?.family);
    this.pushUnique(phrases, metricInfo?.source);

    (Array.isArray(metricCandidates) ? metricCandidates : []).forEach((item) => {
      this.pushUnique(phrases, item?.id);
      this.pushUnique(phrases, item?.label);
      this.pushUnique(phrases, item?.reason);
    });

    const aliasMap = [
      { pattern: /(服务器响应时间|响应时间|response\s*time)/i, value: 'server_response_time' },
      { pattern: /(时延|延时|latency|rtt)/i, value: 'latency' },
      { pattern: /(流量|吞吐|带宽|throughput|traffic)/i, value: 'traffic' },
      { pattern: /(包流量|包数量|数据包|pps|pkio)/i, value: 'packet_traffic' },
      { pattern: /(丢包|loss)/i, value: 'packet_loss' },
      { pattern: /(页面|web|http)/i, value: 'web_experience' }
    ];

    aliasMap.forEach((item) => {
      if (item.pattern.test(String(text?.raw || ''))) {
        this.pushUnique(phrases, item.value);
      }
    });

    return phrases;
  }

  extractTimePhrase(text = {}) {
    const raw = String(text.raw || '');
    const match = raw.match(/(今天|昨日|昨天|本周|上周|最近\s*\d+\s*(?:分钟|小时|天)|近\s*\d+\s*(?:分钟|小时|天)|过去\s*\d+\s*(?:分钟|小时|天)|最近|近24小时|近1小时)/i);
    return match ? match[1] : null;
  }

  inferOperationFromService(service = '') {
    const normalized = String(service || '').trim();
    if (normalized === 'groups' || normalized === 'metrics') {
      return 'inventory';
    }
    if (normalized === 'topValues') {
      return 'ranking';
    }
    if (normalized === 'timeValues') {
      return 'trend';
    }
    if (normalized === 'averageValues') {
      return 'query';
    }
    if (normalized === 'overview') {
      return 'overview';
    }
    return null;
  }

  inferTaskType({ service, operation, metricInfo, group }) {
    if (service === 'groups' || operation === 'inventory') {
      return 'metadata_list';
    }
    if (service === 'metrics') {
      return 'metric_inventory';
    }
    if (service === 'topValues' || operation === 'ranking') {
      return 'ranking_query';
    }
    if (service === 'timeValues' || operation === 'trend') {
      return 'trend_query';
    }
    if (service === 'overview' || operation === 'overview') {
      return 'overview_query';
    }
    if (metricInfo?.metric && group?.type) {
      return 'metric_query';
    }
    return 'query';
  }

  inferTimeRangeKey(text = {}, timeRange = null) {
    const raw = String(text.raw || '');

    if (/今天/i.test(raw)) return 'today';
    if (/(昨日|昨天)/i.test(raw)) return 'yesterday';
    if (/本周/i.test(raw)) return 'thisWeek';
    if (/上周/i.test(raw)) return 'lastWeek';
    if (/(最近|近|过去)\s*24\s*小时/i.test(raw)) return 'last24hours';
    if (/(最近|近|过去)\s*1\s*小时/i.test(raw)) return 'last1hour';

    if (timeRange?.start && timeRange?.end) {
      const span = Number(timeRange.end) - Number(timeRange.start);
      if (span >= 3500 && span <= 3700) {
        return 'last1hour';
      }
      if (span >= 86000 && span <= 87000) {
        return 'last24hours';
      }
    }

    return null;
  }

  build(input = {}) {
    const text = this.normalizeText(input.text || { originalText: input.originalText });
    const service = String(input.service || '').trim() || null;
    const semanticConstraints = input.semanticConstraints && typeof input.semanticConstraints === 'object'
      ? this.clone(input.semanticConstraints)
      : null;
    const group = input.group && typeof input.group === 'object' ? this.clone(input.group) : null;
    const metricInfo = input.metricInfo && typeof input.metricInfo === 'object' ? this.clone(input.metricInfo) : null;
    const timeRange = input.timeRange && typeof input.timeRange === 'object' ? this.clone(input.timeRange) : null;
    const objectCandidates = Array.isArray(input.objectCandidates) ? this.clone(input.objectCandidates) : [];
    const intentCandidates = Array.isArray(input.intentCandidates) ? this.clone(input.intentCandidates) : [];
    const metricDomainCandidates = Array.isArray(input.metricDomainCandidates) ? this.clone(input.metricDomainCandidates) : [];
    const metricCandidates = Array.isArray(input.metricCandidates) ? this.clone(input.metricCandidates) : [];
    const scopeHints = Array.isArray(input.scopeHints) ? this.clone(input.scopeHints) : [];
    const intent = String(input.intent || '').trim() || null;
    const operation = String(
      semanticConstraints?.operation
      || this.inferOperationFromService(service)
      || ''
    ).trim() || null;
    const topCount = Number.isFinite(Number(input.topCount)) && Number(input.topCount) > 0
      ? Number(input.topCount)
      : null;

    return {
      version: 'v1',
      source_hint: metricInfo?.source || null,
      query_mode: service,
      object_phrases: this.buildObjectPhrases({
        text,
        group,
        semanticConstraints,
        objectCandidates
      }),
      target_hint: semanticConstraints?.targetObjectType || group?.type || null,
      metric_phrases: this.buildMetricPhrases({
        text,
        metricInfo,
        metricCandidates
      }),
      time_phrase: this.extractTimePhrase(text),
      operation,
      intent,
      top_count: topCount,
      task_type: this.inferTaskType({
        service,
        operation,
        metricInfo,
        group
      }),
      semantic_constraints: semanticConstraints,
      hints: {
        group_type_hint: group?.type || null,
        group_argument_hint: group?.argument || null,
        metric_code_hint: metricInfo?.metric || null,
        metric_family_hint: metricInfo?.family || null,
        time_range: timeRange
          ? {
              start: timeRange.start || null,
              end: timeRange.end || null,
              key: this.inferTimeRangeKey(text, timeRange)
            }
          : null
      },
      candidate_inputs: {
        intent,
        intent_candidates: intentCandidates.slice(0, 5),
        metric_domain_candidates: metricDomainCandidates.slice(0, 5),
        metric_candidates: metricCandidates.slice(0, 6),
        scope_hints: scopeHints.slice(0, 6),
        object_candidates: objectCandidates.slice(0, 5)
      }
    };
  }
}

module.exports = new CandidateSpecBuilder();
