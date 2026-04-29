class ClarificationGateService {
  clone(value) {
    return value && typeof value === 'object'
      ? JSON.parse(JSON.stringify(value))
      : value;
  }

  toScore(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  mapObjectTypeLabel(type = '') {
    const mapping = {
      IPAddress: 'IP地址',
      ConnectedIP: '对端IP',
      ClientIPs: '客户端IP',
      Prefix24: '网段',
      IPConversation: 'IP会话',
      Application: '应用',
      DefinedApp: '应用',
      WebApplication: 'Web应用',
      BusinessGroup: '业务组',
      TotalTraffic: '总流量'
    };
    return mapping[String(type || '').trim()] || String(type || '').trim() || '对象';
  }

  mapMetricLabel(metric = '') {
    const mapping = {
      TPIO: '总吞吐量',
      TPI: '入方向吞吐量',
      TPO: '出方向吞吐量',
      PKIO: '包流量',
      TRTI: '服务器响应时间',
      RTTI: '网络时延',
      PLI: '丢包率',
      PLO: '出方向丢包率',
      PGTME: '页面时延',
      PGNPGE: '页面访问量'
    };
    return mapping[String(metric || '').trim()] || String(metric || '').trim() || '指标';
  }

  buildReplyText(baseQuery = '', suffix = '') {
    const base = String(baseQuery || '').trim();
    const token = String(suffix || '').trim();
    if (!base) {
      return token || null;
    }
    if (!token || base.includes(token)) {
      return base;
    }
    return `${base} ${token}`.trim();
  }

  buildDefaultGate(extra = {}) {
    return {
      required: false,
      blocking: false,
      source: null,
      reason: null,
      question: null,
      options: [],
      evidence: null,
      ...extra
    };
  }

  buildExecutionGuardGate(resolvedQuery = null) {
    const guard = resolvedQuery?.executionGuard;
    if (!guard?.blockExecution) {
      return null;
    }

    const details = guard?.details || {};
    const suggestedCandidates = Array.isArray(details?.suggestedCandidates)
      ? details.suggestedCandidates
      : [];
    const baseQuery = String(resolvedQuery?.userRequirement || '').trim();

    return {
      required: true,
      blocking: true,
      source: 'execution_guard',
      reason: guard.code || 'execution_guard_blocked',
      question: guard.message || '当前查询对象无法直接确认，请补充更准确的对象名称。',
      options: suggestedCandidates
        .map((item, index) => {
          const value = String(item?.value || item?.label || '').trim();
          if (!value) {
            return null;
          }
          return {
            key: `execution_guard_option_${index + 1}`,
            label: String(item?.label || value).trim(),
            value,
            replyText: this.buildReplyText(baseQuery, value),
            confidence: item?.confidence ?? null
          };
        })
        .filter(Boolean),
      evidence: this.clone(guard)
    };
  }

  buildEntityGate(entityResolve, resolvedQuery = null) {
    if (!entityResolve?.clarification?.required) {
      return null;
    }

    const selectedEntity = entityResolve.selected_entity || {};
    const baseQuery = String(resolvedQuery?.userRequirement || '').trim();
    const options = Array.isArray(entityResolve?.clarification?.suggested_candidates)
      ? entityResolve.clarification.suggested_candidates
      : [];

    return {
      required: true,
      blocking: true,
      source: 'entity',
      reason: entityResolve?.clarification?.reason || 'entity_disambiguation_required',
      question: selectedEntity.type && selectedEntity.value
        ? `我识别到了“${selectedEntity.value}”，但还不能确定它对应的${this.mapObjectTypeLabel(selectedEntity.type)}，请确认一下。`
        : '我还不能唯一确认你要查询的对象，请再明确一点。',
      options: options
        .map((item, index) => {
          const value = String(item?.value || item?.label || '').trim();
          if (!value) {
            return null;
          }
          return {
            key: `entity_option_${index + 1}`,
            label: String(item?.label || value).trim(),
            value,
            replyText: this.buildReplyText(baseQuery, value),
            confidence: item?.confidence ?? null
          };
        })
        .filter(Boolean),
      evidence: {
        selected_entity: this.clone(selectedEntity),
        metadata_validation: this.clone(entityResolve?.metadata_validation || null)
      }
    };
  }

  buildObjectGate(resolvedQuery = null) {
    const hints = resolvedQuery?.resolutionHints?.group;
    const candidates = Array.isArray(hints?.candidates) ? hints.candidates : [];
    if (!hints || hints.explicit !== false || candidates.length < 2) {
      return null;
    }

    const filtered = candidates
      .filter((item) => item?.objectType || item?.type)
      .map((item) => ({
        type: String(item?.objectType || item?.type || '').trim(),
        score: this.toScore(item?.score),
        argument: item?.argumentCandidate || item?.argument || null
      }))
      .filter((item) => item.type)
      .sort((left, right) => right.score - left.score)
      .slice(0, 4);

    if (filtered.length < 2) {
      return null;
    }

    const best = filtered[0];
    const currentType = String(
      hints?.type
      || resolvedQuery?.groups?.[0]?.type
      || ''
    ).trim();
    const current = filtered.find((item) => item.type === currentType) || best;
    const lead = Number((best.score - current.score).toFixed(2));
    const shouldClarify = Boolean(
      hints?.defaulted
      || current.score < 0.78
      || lead < 0.2
    );

    if (!shouldClarify) {
      return null;
    }

    const baseQuery = String(resolvedQuery?.userRequirement || '').trim();
    return {
      required: true,
      blocking: true,
      source: 'object',
      reason: hints?.defaulted ? 'object_type_defaulted' : 'object_type_low_confidence',
      question: '当前问法里的对象类型还不够明确，请确认你要查的是哪一类对象。',
      options: filtered.map((item, index) => ({
        key: `object_option_${index + 1}`,
        label: this.mapObjectTypeLabel(item.type),
        value: item.type,
        replyText: this.buildReplyText(baseQuery, this.mapObjectTypeLabel(item.type)),
        confidence: item.score
      })),
      evidence: {
        current_type: currentType || null,
        lead,
        candidates: this.clone(filtered)
      }
    };
  }

  buildPathGate(pathResolve, resolvedQuery = null) {
    const candidates = Array.isArray(pathResolve?.template_candidates)
      ? pathResolve.template_candidates
      : [];
    const confidence = this.toScore(pathResolve?.confidence);

    if (!pathResolve || candidates.length < 2 || confidence >= 0.75) {
      return null;
    }

    const baseQuery = String(resolvedQuery?.userRequirement || '').trim();
    return {
      required: true,
      blocking: true,
      source: 'path',
      reason: 'path_ambiguous',
      question: '当前查询路径还有多种可能，请确认你希望按哪条对象路径来查。',
      options: candidates.slice(0, 3).map((item, index) => {
        const pathText = Array.isArray(item?.path)
          ? item.path.join(' > ')
          : String(item?.label || item?.templateId || `path_${index + 1}`);
        return {
          key: `path_option_${index + 1}`,
          label: pathText,
          value: pathText,
          replyText: this.buildReplyText(baseQuery, pathText),
          confidence: this.toScore(item?.score, null)
        };
      }),
      evidence: {
        confidence,
        selected_path: this.clone(pathResolve?.selected_path || []),
        template_candidates: this.clone(candidates.slice(0, 3))
      }
    };
  }

  buildMetricGate(metricResolve, resolvedQuery = null) {
    const suggestions = Array.isArray(metricResolve?.suggestions) ? metricResolve.suggestions : [];
    const domainCandidates = Array.isArray(metricResolve?.metric_domain_candidates)
      ? metricResolve.metric_domain_candidates
      : [];
    const selectedMetric = String(metricResolve?.selected_metric || resolvedQuery?.metric || '').trim();

    if (selectedMetric) {
      return null;
    }

    const options = suggestions.length > 0
      ? suggestions
      : domainCandidates.flatMap((item) => Array.isArray(item?.primaryMetrics) ? item.primaryMetrics.map((metric) => ({ metric })) : []);

    const deduped = [];
    const seen = new Set();
    options.forEach((item) => {
      const metric = String(item?.metric || item?.id || item?.value || '').trim();
      if (metric && !seen.has(metric)) {
        seen.add(metric);
        deduped.push({
          metric,
          confidence: item?.confidence ?? item?.score ?? null
        });
      }
    });

    if (deduped.length < 2) {
      return null;
    }

    const baseQuery = String(resolvedQuery?.userRequirement || '').trim();
    return {
      required: true,
      blocking: true,
      source: 'metric',
      reason: 'metric_ambiguous',
      question: '当前指标语义还不够明确，请确认你要查的具体指标。',
      options: deduped.slice(0, 4).map((item, index) => ({
        key: `metric_option_${index + 1}`,
        label: this.mapMetricLabel(item.metric),
        value: item.metric,
        replyText: this.buildReplyText(baseQuery, item.metric),
        confidence: item.confidence
      })),
      evidence: {
        metric_domain_candidates: this.clone(domainCandidates),
        suggestions: this.clone(suggestions)
      }
    };
  }

  buildTimeGate(timeResolve, resolvedQuery = null) {
    const start = Number(resolvedQuery?.start || timeResolve?.time_range?.start || 0);
    const end = Number(resolvedQuery?.end || timeResolve?.time_range?.end || 0);
    if (start > 0 && end > 0 && end >= start) {
      return null;
    }

    const baseQuery = String(resolvedQuery?.userRequirement || '').trim();
    return {
      required: true,
      blocking: false,
      source: 'time',
      reason: 'time_range_missing',
      question: '时间范围还不够明确，我先用默认时间窗口也可以；如果你要指定，请补充时间范围。',
      options: [
        {
          key: 'time_option_1',
          label: '最近1小时',
          value: '最近1小时',
          replyText: this.buildReplyText(baseQuery, '最近1小时'),
          confidence: null
        },
        {
          key: 'time_option_2',
          label: '最近24小时',
          value: '最近24小时',
          replyText: this.buildReplyText(baseQuery, '最近24小时'),
          confidence: null
        }
      ],
      evidence: this.clone(timeResolve)
    };
  }

  assess(input = {}) {
    const resolvedQuery = input.resolvedQuery || null;
    const entityResolve = input.entityResolve || null;
    const pathResolve = input.pathResolve || null;
    const metricResolve = input.metricResolve || null;
    const timeResolve = input.timeResolve || null;

    const gate = this.buildExecutionGuardGate(resolvedQuery)
      || this.buildEntityGate(entityResolve, resolvedQuery)
      || this.buildObjectGate(resolvedQuery)
      || this.buildPathGate(pathResolve, resolvedQuery)
      || this.buildMetricGate(metricResolve, resolvedQuery)
      || this.buildTimeGate(timeResolve, resolvedQuery);

    return gate || this.buildDefaultGate();
  }
}

module.exports = new ClarificationGateService();
