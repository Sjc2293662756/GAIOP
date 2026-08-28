/**
 * ClarificationGateService.js
 *
 * 负责在查询执行前判断是否需要向用户发起澄清。
 * 它会综合执行保护、实体识别、对象类型、路径、指标和时间范围等信息，
 * 生成统一的 clarification gate 结果，供上层决定是继续执行还是先追问。
 */
class ClarificationGateService {
  // 深拷贝简单对象，避免在构造 evidence 时污染原始输入。
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

  // 组合用户原始问句和候选补充词，生成可直接回填到对话中的澄清回复文本。
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

  // 生成默认 gate 结构，作为所有澄清判断分支的统一返回底座。
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

  /**
   * 基于 executionGuard 构造阻断型澄清 gate。
   * 这类 gate 通常说明当前对象或路径无法直接执行，优先级最高。
   */
  buildExecutionGuardGate(resolvedQuery = null) {
    const guard = resolvedQuery?.executionGuard;
    if (!guard?.blockExecution) {
      return null;
    }

    const semanticOperation = String(
      resolvedQuery?.semanticConstraints?.operation
      || resolvedQuery?.candidateSpec?.semantic_constraints?.operation
      || ''
    ).trim().toLowerCase();
    const isOverviewQuery = resolvedQuery?.service === 'overview'
      || resolvedQuery?.queryModeKey === 'overview'
      || semanticOperation === 'overview';
    if (isOverviewQuery && String(guard?.code || '').trim() === 'SCOPED_DESCENT_UNRESOLVED') {
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

  /**
   * 基于实体消歧结果构造澄清 gate。
   * 当识别到了实体，但无法唯一确认其真实对象时，提示用户二次确认。
   */
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

  /**
   * 当对象类型存在多个高相近候选时，构造对象类型澄清 gate。
   */
  buildObjectGate(resolvedQuery = null) {
    const semanticOperation = String(
      resolvedQuery?.semanticConstraints?.operation
      || resolvedQuery?.candidateSpec?.semantic_constraints?.operation
      || ''
    ).trim().toLowerCase();
    const isOverviewQuery = resolvedQuery?.service === 'overview'
      || resolvedQuery?.queryModeKey === 'overview'
      || semanticOperation === 'overview';
    if (isOverviewQuery) {
      return null;
    }

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

  /**
   * 当路径规划候选过多且置信度不足时，要求用户确认查询路径。
   */
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

  /**
   * 当指标解析没有收敛到唯一指标时，构造指标澄清 gate。
   */
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

  /**
   * 当查询对象参数策略要求补充或拒绝参数时，构造执行前澄清 gate。
   */
  buildArgumentPolicyGate(argumentPolicy, resolvedQuery = null) {
    if (!argumentPolicy || argumentPolicy.ok !== false) {
      return null;
    }

    const details = argumentPolicy.details || {};
    const groupType = String(details.groupType || '').trim();
    const argument = String(details.argument || '').trim();
    const label = this.mapObjectTypeLabel(groupType);
    let question = argumentPolicy.message || null;
    if (argumentPolicy.code === 'GROUP_ARGUMENT_REQUIRED') {
      question = `查询${label}的趋势或平均值需要指定具体${label}名称，请补充对象名称。`;
    } else if (argumentPolicy.code === 'GROUP_ARGUMENT_FORBIDDEN') {
      question = '总流量是全局范围，不需要携带具体对象参数；请删除该参数，或改为查询具体对象。';
    } else if (argumentPolicy.code === 'INVALID_GROUP_ARGUMENT') {
      question = argument
        ? `未在 NAPM 目录中找到${label}“${argument}”，请确认名称或从候选对象中选择。`
        : `未能确认要查询的${label}，请补充具体对象名称。`;
    }

    const baseQuery = String(resolvedQuery?.userRequirement || '').trim();
    const candidates = Array.isArray(details.candidates) ? details.candidates : [];
    return {
      required: true,
      blocking: true,
      source: 'query_argument_policy',
      reason: argumentPolicy.reason || 'query_argument_policy_failed',
      code: argumentPolicy.code || null,
      question,
      options: candidates.slice(0, 5).map((item, index) => {
        const value = String(item?.value || item?.label || '').trim();
        return value
          ? {
              key: `group_argument_option_${index + 1}`,
              label: String(item?.label || value).trim(),
              value,
              replyText: this.buildReplyText(baseQuery, value),
              confidence: item?.confidence ?? null
            }
          : null;
      }).filter(Boolean),
      evidence: this.clone(argumentPolicy)
    };
  }

  /**
   * 当时间范围缺失时，给出非阻断型时间建议。
   */
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

  /**
   * 主入口：按固定优先级依次评估各种澄清信号，返回第一个命中的 gate。
   */
  assess(input = {}) {
    const resolvedQuery = input.resolvedQuery || null;
    const entityResolve = input.entityResolve || null;
    const pathResolve = input.pathResolve || null;
    const metricResolve = input.metricResolve || null;
    const timeResolve = input.timeResolve || null;
    const argumentPolicy = input.argumentPolicy || null;

    const gate = this.buildExecutionGuardGate(resolvedQuery)
      || this.buildEntityGate(entityResolve, resolvedQuery)
      || this.buildObjectGate(resolvedQuery)
      || this.buildPathGate(pathResolve, resolvedQuery)
      || this.buildMetricGate(metricResolve, resolvedQuery)
      || this.buildArgumentPolicyGate(argumentPolicy, resolvedQuery)
      || this.buildTimeGate(timeResolve, resolvedQuery);

    return gate || this.buildDefaultGate();
  }
}

module.exports = new ClarificationGateService();
