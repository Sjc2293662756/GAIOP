/**
 * ResolvedSpecBuilder.js
 * 
 * 瑙ｆ瀽瑙勬牸鏋勫缓鍣? * 
 * 璐熻矗浠庣綉鍏宠姹傚拰鏄犲皠缁撴灉涓瀯寤鸿鑼冨寲鐨勮В鏋愯鏍煎璞★紝
 * 鏁村悎璇箟绾︽潫銆佸疄浣撹В鏋愩€佹寚鏍囪В鏋愩€佽矾寰勮В鏋愮瓑淇℃伅銆? * 
 * 淇敼鏃ユ湡锛?026-04-16
 */

/**
 * ResolvedSpecBuilder 绫? * 鏋勫缓瑙勮寖鍖栫殑瑙ｆ瀽瑙勬牸瀵硅薄
 */
class ResolvedSpecBuilder {
  /**
   * 娣辨嫹璐濆璞?   * 
   * @param {any} value - 瑕佹嫹璐濈殑鍊?   * @returns {any} - 鎷疯礉鍚庣殑鍊?   */
  clone(value) {
    return value && typeof value === 'object'
      ? JSON.parse(JSON.stringify(value))
      : value;
  }

  /**
   * 瑙勮寖鍖栧彲閫夋暟瀛楀€?   * 
   * @param {any} value - 寰呰鑼冨寲鐨勫€?   * @returns {number|null} - 瑙勮寖鍖栧悗鐨勬暟瀛楁垨null
   */
  normalizeOptionalNumber(value) {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : null;
  }

  /**
   * 鏋勫缓瑙ｆ瀽瑙勬牸瀵硅薄
   * 
   * 浠庣綉鍏宠姹傚拰鏄犲皠缁撴灉涓彁鍙栧苟鏁村悎鎵€鏈夌浉鍏充俊鎭紝鏋勫缓瑙勮寖鍖栫殑瑙ｆ瀽瑙勬牸銆?   * 
   * @param {object} gatewayRequest - 缃戝叧璇锋眰瀵硅薄
   * @param {object} mappingResult - 鏄犲皠缁撴灉瀵硅薄
   * @returns {object|null} - 瑙ｆ瀽瑙勬牸瀵硅薄
   */
  build(gatewayRequest = {}, mappingResult = null) {
    if (!gatewayRequest || typeof gatewayRequest !== 'object') {
      return null;
    }

    const request = gatewayRequest;
    const candidateSpec = mappingResult?.candidateSpec
      || request.candidateSpec
      || mappingResult?.resolvedQuery?.candidateSpec
      || null;
    const semanticConstraints = request.semanticConstraints
      || mappingResult?.resolvedQuery?.semanticConstraints
      || candidateSpec?.semantic_constraints
      || null;
    const groups = Array.isArray(request.groups) ? request.groups : [];
    const contextGroups = Array.isArray(request.contextGroups) ? request.contextGroups : [];
    const terminalGroup = groups[groups.length - 1] || null;

    return {
      version: 'v1',
      operation: semanticConstraints?.operation || candidateSpec?.operation || null,
      query_mode: request.queryModeKey || request.service || candidateSpec?.query_mode || null,
      service: request.service || null,
      anchor_object: semanticConstraints?.anchorObject
        || (request.entityResolve?.selected_entity?.has_argument
          ? {
            type: request.entityResolve.selected_entity.type || null,
            value: request.entityResolve.selected_entity.value || null
          }
          : null),
      target_object_type: semanticConstraints?.targetObjectType
        || terminalGroup?.type
        || candidateSpec?.target_hint
        || null,
      context_path: this.clone(contextGroups),
      execution_path: this.clone(groups),
      clarification_gate: this.clone(request.clarificationGate || null),
      entity_resolve: this.clone(request.entityResolve || null),
      metric: request.metric || (Array.isArray(request.metrics) ? request.metrics[0] : null),
      metrics: Array.isArray(request.metrics) ? request.metrics.slice() : [],
      metric_resolve: this.clone(request.metricResolve || null),
      metric_semantic: this.clone(request.metricSemantic || null),
      object_semantic: this.clone(request.objectSemantic || null),
      path_resolve: this.clone(request.pathResolve || null),
      path_planning: this.clone(request.pathPlanning || null),
      time_resolve: this.clone(request.timeResolve || null),
      time_range: {
        key: request.timeResolve?.time_range?.key || request.timeRangeKey || candidateSpec?.hints?.time_range?.key || null,
        start: request.timeResolve?.time_range?.start || request.start || null,
        end: request.timeResolve?.time_range?.end || request.end || null
      },
      top_count: this.normalizeOptionalNumber(request.topCount),
      granularity: this.normalizeOptionalNumber(request.granularity ?? request.timeResolve?.granularity?.value),
      candidate_spec: this.clone(candidateSpec),
      semantic_constraints: this.clone(semanticConstraints)
    };
  }
}

module.exports = new ResolvedSpecBuilder();

