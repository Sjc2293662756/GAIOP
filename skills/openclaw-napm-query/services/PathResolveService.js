/**
 * PathResolveService.js
 * 
 * 璺緞瑙ｆ瀽鏈嶅姟
 * 
 * 璐熻矗瑙ｆ瀽鍜屽鐞嗗垎缁勮矾寰勪俊鎭紝灏嗚矾寰勮鍒掑拰瑙ｆ瀽鍚庣殑鏌ヨ杞崲涓烘爣鍑嗗寲鐨勮矾寰勮В鏋愮粨鏋溿€? * 
 * 淇敼鏃ユ湡锛?026-04-15
 */

/**
 * PathResolveService 绫? * 璐熻矗瑙ｆ瀽鍒嗙粍璺緞淇℃伅
 */
class PathResolveService {
  /**
   * 娣辨嫹璐濆璞?   * 
   * @param {any} value - 瑕佹嫹璐濈殑鍊?   * @returns {any} - 鎷疯礉鍚庣殑鍊?   */
  clone(value) {
    return value && typeof value === 'object'
      ? JSON.parse(JSON.stringify(value))
      : value;
  }

  /**
   * 瑙ｆ瀽璺緞淇℃伅
   * 
   * 灏嗚矾寰勮鍒掑拰瑙ｆ瀽鍚庣殑鏌ヨ杞崲涓烘爣鍑嗗寲鐨勮矾寰勮В鏋愮粨鏋滐紝
   * 鎻愬彇鍒嗙粍璺緞銆佺洰鏍囧垎缁勩€佸€欓€夋ā鏉跨瓑淇℃伅銆?   * 
   * @param {object} input - 杈撳叆鍙傛暟瀵硅薄
   * @param {object} input.pathPlan - 璺緞璁″垝瀵硅薄
   * @param {object} input.resolvedQuery - 瑙ｆ瀽鍚庣殑鏌ヨ瀵硅薄
   * @returns {object} - 璺緞瑙ｆ瀽缁撴灉瀵硅薄
   */
  resolve(input = {}) {
    const pathPlan = input.pathPlan || null;
    const resolvedQuery = input.resolvedQuery || null;
    const groups = Array.isArray(resolvedQuery?.groups) ? resolvedQuery.groups : [];
    const plannedGroups = Array.isArray(pathPlan?.plannedGroups) ? pathPlan.plannedGroups : groups;
    const selectedPath = plannedGroups.map(item => item?.type).filter(Boolean);
    const evidence = pathPlan?.evidence || {};

    return {
      version: 'v1',
      stage: 'path_resolve',
      status: pathPlan ? 'resolved' : 'unavailable',
      mode: pathPlan?.pathMode || null,
      should_apply: Boolean(pathPlan?.shouldApply),
      confidence: Number(pathPlan?.confidence || 0),
      selected_path: selectedPath,
      selected_groups: this.clone(plannedGroups),
      target_group: evidence?.targetGroup || groups[groups.length - 1]?.type || null,
      initial_target_group: evidence?.initialTargetGroup || groups[groups.length - 1]?.type || null,
      template_candidates: this.clone(pathPlan?.templateCandidates || []),
      overview_convergence_paths: this.clone(pathPlan?.overviewConvergencePaths || []),
      scope_context_groups: this.clone(evidence?.scopeContextGroups || []),
      extracted_arguments: this.clone(evidence?.extractedArguments || {}),
      candidates: this.clone(pathPlan?.candidates || []),
      evidence: this.clone(evidence)
    };
  }
}

module.exports = new PathResolveService();

