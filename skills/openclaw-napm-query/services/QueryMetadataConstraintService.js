/**
 * QueryMetadataConstraintService.js
 * 
 * 鏌ヨ鍏冩暟鎹害鏉熸湇鍔? * 
 * 璐熻矗瀵规煡璇㈣繘琛岃鑼冨寲鍜岀害鏉熸鏌ワ紝鍖呮嫭锛? * - 鎸囨爣瀛楁瑙勮寖鍖? * - 鍒嗙粍瀛楁瑙勮寖鍖? * - TopCount 瑙勮寖鍖? * - 鏃堕棿绮掑害瑙勮寖鍖? * - 鍏煎鎬ф鏌ュ拰淇
 * 
 * 淇敼鏃ユ湡锛?026-04-15
 */
const DimensionMappingService = require('./DimensionMappingService');
const MetricMappingService = require('./MetricMappingService');
const { SUPPORTED_GRANULARITIES } = require('../../../src/constants/metricDomains');

/**
 * QueryMetadataConstraintService 绫? * 璐熻矗瀵规煡璇㈣繘琛岃鑼冨寲鍜岀害鏉熸鏌? */
class QueryMetadataConstraintService {
  /**
   * 绾︽潫鏌ヨ锛堜富鍏ュ彛鏂规硶锛?   * 
   * 瀵规煡璇㈣繘琛屽叏闈㈢殑瑙勮寖鍖栧鐞嗭紝鍖呮嫭鎸囨爣銆佸垎缁勩€乀opCount銆佺矑搴︾瓑瀛楁鐨勮鑼冨寲锛?   * 骞惰繘琛屽吋瀹规€ф鏌ャ€?   * 
   * @param {object} query - 鏌ヨ瀵硅薄
   * @param {string} originalText - 鍘熷鏂囨湰
   * @returns {object} - 绾︽潫澶勭悊缁撴灉
   */
  constrain(query, originalText = '') {
    const baseQuery = this.cloneQuery(query);
    const warnings = [];
    const corrections = [];

    if (!baseQuery || !baseQuery.service) {
      return {
        query: baseQuery,
        warnings: ['query_missing_or_invalid'],
        corrections,
        compatibility: null
      };
    }

    // 鎵ц鍚勭被瑙勮寖鍖栧鐞?    this.normalizeMetricFields(baseQuery, corrections);
    this.normalizeGroupFields(baseQuery, originalText, warnings, corrections);
    this.normalizeTopCount(baseQuery, corrections);
    this.normalizeGranularity(baseQuery, corrections);
    const compatibility = this.buildCompatibility(baseQuery, warnings, corrections);

    return {
      query: baseQuery,
      warnings,
      corrections,
      compatibility
    };
  }

  /**
   * 娣辨嫹璐濇煡璇㈠璞?   * 
   * @param {object} query - 鏌ヨ瀵硅薄
   * @returns {object} - 鎷疯礉鍚庣殑鏌ヨ瀵硅薄
   */
  cloneQuery(query) {
    return query ? JSON.parse(JSON.stringify(query)) : query;
  }

  /**
   * 褰掍竴鍖栧巻鍙查仐鐣欑殑椤跺眰瀵硅薄绫诲瀷銆?   * 璇存槑锛氬綋鍓嶅厓鏁版嵁椤跺眰浣跨敤 DefinedApp锛屼笉鍐嶇洿鎺ヤ娇鐢?Application銆?   *
   * @param {string} groupType - 鍒嗙粍绫诲瀷
   * @param {number} index - 鍒嗙粍绱㈠紩
   * @returns {string} - 褰掍竴鍖栧悗鐨勫垎缁勭被鍨?   */
  normalizeLegacyGroupType(groupType, index = 0) {
    const raw = String(groupType || '').trim();
    if (!raw) {
      return raw;
    }

    if (index === 0 && raw === 'Application') {
      return 'DefinedApp';
    }

    return raw;
  }

  /**
   * 瑙勮寖鍖栨寚鏍囧瓧娈?   * 
   * @param {object} query - 鏌ヨ瀵硅薄
   * @param {array} corrections - 淇璁板綍鏁扮粍
   */
  normalizeMetricFields(query, corrections) {
    if (query.service === 'metrics' || query.service === 'groups') {
      delete query.metric;
      delete query.metrics;
      return;
    }

    if (query.metric && !MetricMappingService.isValidMetricCode(query.metric)) {
      corrections.push({
        field: 'metric',
        action: 'fallback_to_default_metric',
        from: query.metric,
        to: 'TPIO'
      });
      query.metric = 'TPIO';
    }

    if (!Array.isArray(query.metrics) || query.metrics.length === 0) {
      if (query.metric) {
        query.metrics = [query.metric];
        corrections.push({
          field: 'metrics',
          action: 'mirror_metric_field',
          to: query.metrics
        });
      } else {
        query.metrics = ['TPIO'];
        corrections.push({
          field: 'metrics',
          action: 'fallback_to_default_metric',
          to: query.metrics
        });
      }
    }

    query.metrics = query.metrics.map(metric => (
      MetricMappingService.isValidMetricCode(metric) ? metric : 'TPIO'
    ));

    if (!query.metric && query.service === 'topValues') {
      query.metric = query.metrics[0];
      corrections.push({
        field: 'metric',
        action: 'derive_from_metrics',
        to: query.metric
      });
    }
  }

  /**
   * 瑙勮寖鍖栧垎缁勫瓧娈?   * 
   * @param {object} query - 鏌ヨ瀵硅薄
   * @param {string} originalText - 鍘熷鏂囨湰
   * @param {array} warnings - 璀﹀憡璁板綍鏁扮粍
   * @param {array} corrections - 淇璁板綍鏁扮粍
   */
  normalizeGroupFields(query, originalText, warnings, corrections) {
    if (query.service === 'metrics') {
      if (!Array.isArray(query.groups) || query.groups.length === 0) {
        delete query.groups;
        return;
      }
    }

    if (query.service === 'groups' && (!Array.isArray(query.groups) || query.groups.length === 0)) {
      delete query.groups;
      return;
    }

    if (!Array.isArray(query.groups) || query.groups.length === 0) {
      query.groups = [{ type: 'IPAddress' }];
      corrections.push({
        field: 'groups',
        action: 'fallback_to_default_group',
        to: query.groups
      });
    }

    query.groups = query.groups.map((group, index) => {
      const normalized = {
        type: this.normalizeLegacyGroupType(group.type || 'IPAddress', index)
      };

      if (group.argument) {
        normalized.argument = group.argument;
      }

      const dimension = DimensionMappingService.getObjectDimension(normalized.type);
      if (!dimension) {
        warnings.push(`unknown_group_type:${normalized.type}`);
        if (index === 0) {
          normalized.type = 'IPAddress';
          corrections.push({
            field: 'groups.type',
            action: 'fallback_to_IPAddress',
            to: 'IPAddress'
          });
        } else {
          corrections.push({
            field: `groups[${index}].type`,
            action: 'preserve_unknown_intermediate_group',
            to: normalized.type
          });
        }
      }

      if (normalized.type === 'TotalTraffic') {
        delete normalized.argument;
      }

      if (normalized.type === 'IPConversation' && normalized.argument && !normalized.argument.includes('|')) {
        const matches = String(originalText).match(/((?:\d{1,3}\.){3}\d{1,3})/g);
        if (matches && matches.length >= 2) {
          normalized.argument = `${matches[0]}|${matches[1]}`;
          corrections.push({
            field: 'groups.argument',
            action: 'normalize_ip_conversation_argument',
            to: normalized.argument
          });
        }
      }

      return normalized;
    });
  }

  /**
   * 瑙勮寖鍖?TopCount
   * 
   * @param {object} query - 鏌ヨ瀵硅薄
   * @param {array} corrections - 淇璁板綍鏁扮粍
   */
  normalizeTopCount(query, corrections) {
    if (query.service !== 'topValues') {
      return;
    }

    const original = Number(query.topCount || 20);
    const normalized = Math.max(1, Math.min(original, 1000));
    if (normalized !== original || !query.topCount) {
      corrections.push({
        field: 'topCount',
        action: 'normalize_top_count',
        from: query.topCount,
        to: normalized
      });
    }
    query.topCount = normalized;
  }

  /**
   * 瑙勮寖鍖栨椂闂寸矑搴?   * 
   * @param {object} query - 鏌ヨ瀵硅薄
   * @param {array} corrections - 淇璁板綍鏁扮粍
   */
  normalizeGranularity(query, corrections) {
    if (query.service !== 'timeValues') {
      return;
    }

    const current = Number(query.granularity || 0);
    if (SUPPORTED_GRANULARITIES.includes(current)) {
      return;
    }

    const span = Number(query.end) - Number(query.start);
    let target = 3600;
    if (span <= 6 * 3600) {
      target = 60;
    } else if (span <= 3 * 24 * 3600) {
      target = 300;
    } else if (span <= 30 * 24 * 3600) {
      target = 3600;
    } else {
      target = 86400;
    }

    corrections.push({
      field: 'granularity',
      action: 'normalize_granularity',
      from: query.granularity,
      to: target
    });
    query.granularity = target;
  }

  /**
   * 鏋勫缓鍏煎鎬т俊鎭?   * 
   * @param {object} query - 鏌ヨ瀵硅薄
   * @param {array} warnings - 璀﹀憡璁板綍鏁扮粍
   * @param {array} corrections - 淇璁板綍鏁扮粍
   * @returns {object|null} - 鍏煎鎬т俊鎭璞?   */
  buildCompatibility(query, warnings, corrections) {
    if (query.service === 'metrics' || query.service === 'groups') {
      return null;
    }

    const metric = query.metric || (Array.isArray(query.metrics) ? query.metrics[0] : null);
    if (!metric) {
      return null;
    }

    const domainId = DimensionMappingService.getMetricDomain(metric);
    const domainMeta = DimensionMappingService.getDomainMeta(domainId);
    const compatibleObjects = DimensionMappingService.getObjectsForMetric(metric, {
      onlySupportedByCurrentSkill: true
    });
    const preferredObjects = DimensionMappingService.getPreferredObjectsForMetric(metric)
      .filter(item => compatibleObjects.includes(item));
    const currentGroup = Array.isArray(query.groups) && query.groups[0] ? query.groups[0].type : null;
    const isCompatible = currentGroup ? compatibleObjects.includes(currentGroup) : false;
    const explicitTarget = this.extractExplicitTargetObjectType(query);
    const shouldPreserveExplicitTarget = Boolean(
      explicitTarget
      && currentGroup
      && explicitTarget === currentGroup
    );

    if (!isCompatible && compatibleObjects.length > 0) {
      if (shouldPreserveExplicitTarget) {
        warnings.push(`metric_group_incompatible_but_preserve_explicit_target:${metric}:${currentGroup}`);
      } else {
        const fallbackGroup = this.pickFallbackGroup(query.userRequirement || '', compatibleObjects, preferredObjects);
        warnings.push(`metric_group_incompatible:${metric}:${currentGroup}`);
        if (fallbackGroup && fallbackGroup !== currentGroup) {
          query.groups[0].type = fallbackGroup;
          delete query.groups[0].argument;
          corrections.push({
            field: 'groups[0].type',
            action: 'replace_with_compatible_group',
            from: currentGroup,
            to: fallbackGroup
          });
        }
      }
    }

    return {
      metric,
      domainId,
      domainLabel: domainMeta ? domainMeta.label : null,
      compatibleObjects,
      preferredObjects,
      selectedGroup: query.groups[0].type,
      isCompatible: compatibleObjects.length === 0 ? true : compatibleObjects.includes(query.groups[0].type)
    };
  }

  extractExplicitTargetObjectType(query = {}) {
    const fromSemantic = String(query?.semanticConstraints?.targetObjectType || '').trim();
    if (fromSemantic) {
      return fromSemantic;
    }

    const fromCandidate = String(query?.candidateSpec?.semantic_constraints?.targetObjectType || '').trim();
    if (fromCandidate) {
      return fromCandidate;
    }

    return null;
  }

  /**
   * 閫夋嫨鍥為€€鍒嗙粍绫诲瀷
   * 
   * @param {string} originalText - 鍘熷鏂囨湰
   * @param {array} compatibleObjects - 鍏煎鐨勫璞＄被鍨嬪垪琛?   * @param {array} preferredObjects - 棣栭€夌殑瀵硅薄绫诲瀷鍒楄〃
   * @returns {string} - 鍥為€€鍒嗙粍绫诲瀷
   */
  pickFallbackGroup(originalText, compatibleObjects, preferredObjects) {
    const dimensions = DimensionMappingService.getSupportedObjectDimensions();
    const preferred = preferredObjects.length > 0 ? preferredObjects : compatibleObjects;

    for (const item of preferred) {
      const meta = dimensions.find(dimension => dimension.key === item);
      if (!meta) {
        continue;
      }

      if (meta.aliases.some(alias => String(originalText).toLowerCase().includes(String(alias).toLowerCase()))) {
        return item;
      }
    }

    return preferred[0] || compatibleObjects[0] || 'IPAddress';
  }

  /**
   * 浣跨敤鍔ㄦ€佸厓鏁版嵁绾︽潫鏌ヨ
   * 
   * @param {object} query - 鏌ヨ瀵硅薄
   * @param {object} metadataReview - 鍔ㄦ€佸厓鏁版嵁瀹℃煡缁撴灉
   * @returns {object} - 绾︽潫澶勭悊缁撴灉
   */
  async constrainWithDynamicMetadata(query, metadataReview) {
    const constrained = this.cloneQuery(query);
    const warnings = [];
    const corrections = [];

    if (!metadataReview) {
      return {
        query: constrained,
        warnings,
        corrections,
        dynamicReview: null
      };
    }

    if (Array.isArray(metadataReview.granularities) && metadataReview.granularities.length > 0 && constrained.service === 'timeValues') {
      const value = Number(constrained.granularity);
      if (!metadataReview.granularities.includes(value)) {
        const fallback = metadataReview.granularities[0];
        corrections.push({
          field: 'granularity',
          action: 'replace_with_dynamic_supported_granularity',
          from: constrained.granularity,
          to: fallback
        });
        constrained.granularity = fallback;
      }
    }

    if (Array.isArray(metadataReview.metricsForGroup) && metadataReview.metricsForGroup.length > 0 && constrained.metric) {
      const currentMetricSupported = metadataReview.metricsForGroup.some(item => item.id === constrained.metric);
      if (!currentMetricSupported) {
        warnings.push(`metric_not_in_dynamic_metrics_for_group:${constrained.metric}`);
      }
    }

    if (Array.isArray(metadataReview.groupArguments) && metadataReview.groupArguments.length > 0) {
      const firstGroup = Array.isArray(constrained.groups) && constrained.groups[0] ? constrained.groups[0] : null;
      if (firstGroup && firstGroup.argument) {
        const matched = metadataReview.groupArguments.some(item => String(item.value).toLowerCase() === String(firstGroup.argument).toLowerCase());
        if (!matched) {
          warnings.push(`group_argument_not_in_dynamic_metadata:${firstGroup.type}:${firstGroup.argument}`);
        }
      }
    }

    return {
      query: constrained,
      warnings,
      corrections,
      dynamicReview: metadataReview
    };
  }
}

module.exports = new QueryMetadataConstraintService();

