/**
 * QueryMetadataConstraintService.js
 *
 * 负责在执行前对查询对象做静态元数据约束和兼容性修正。
 * 主要处理指标字段、分组字段、TopCount、粒度以及“指标-对象”兼容关系，
 * 让后续执行链路拿到更稳定的 query shape。
 */
const DimensionMappingService = require('./DimensionMappingService');
const MetricMappingService = require('./MetricMappingService');
const { SUPPORTED_GRANULARITIES } = require('../src/constants/metricDomains');
const {
  isBusinessObjectType,
  getOwnedMetricIdsForObjectType
} = require('../src/constants/objectMetricOwnership');

/**
 * QueryMetadataConstraintService 类
 * 负责对查询进行规范化和兼容性检查
 */
class QueryMetadataConstraintService {
  /**
   * 约束查询（主入口方法）
   * 
   * 对查询进行全面的规范化处理，包括指标、分组、TopCount、粒度等字段的规范化，
   * 并进行兼容性检查。
   * 
   * @param {object} query - 查询对象
   * @param {string} originalText - 原始文本
   * @returns {object} - 约束处理结果
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

    // 依次执行各类字段规范化与兼容性修正。
    this.normalizeMetricFields(baseQuery, corrections);
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
   * 深拷贝查询对象
   * 
   * @param {object} query - 查询对象
   * @returns {object} - 拷贝后的查询对象
   */
  cloneQuery(query) {
    return query ? JSON.parse(JSON.stringify(query)) : query;
  }

  shouldAllowMetadataRepair(query = {}) {
    return Boolean(
      query?.executionOptions?.allowMetadataRepair === true
      || query?.executionHints?.allowMetadataRepair === true
    );
  }

  /**
   * 统一化卷云遗留的维度对象类型。
   * 说明：当前元数据维度使用 DefinedApp，不再直接使用 Application。
   *
   * @param {string} groupType - 分组类型
   * @param {number} index - 分组索引
   * @returns {string} - 统一化后的分组类型
   */
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
   * 规范化指标字段
   * 
   * @param {object} query - 查询对象
   * @param {array} corrections - 修正记录数组
   */
  normalizeMetricFields(query, corrections) {
    if (query.service === 'metrics' || query.service === 'groups') {
      delete query.metric;
      delete query.metrics;
      return;
    }

    const allowMetadataRepair = this.shouldAllowMetadataRepair(query);

    if (query.metric && !MetricMappingService.isValidMetricCode(query.metric)) {
      if (!allowMetadataRepair) {
        corrections.push({
          field: 'metric',
          action: 'preserve_invalid_metric_without_repair',
          from: query.metric
        });
        return;
      }

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
      } else if (allowMetadataRepair) {
        query.metrics = ['TPIO'];
        corrections.push({
          field: 'metrics',
          action: 'fallback_to_default_metric',
          to: query.metrics
        });
      } else {
        corrections.push({
          field: 'metrics',
          action: 'preserve_missing_metrics_without_repair'
        });
        return;
      }
    }

    query.metrics = query.metrics
      .map(metric => {
        if (MetricMappingService.isValidMetricCode(metric)) {
          return metric;
        }
        if (allowMetadataRepair) {
          corrections.push({
            field: 'metrics',
            action: 'fallback_invalid_metric_to_default',
            from: metric,
            to: 'TPIO'
          });
          return 'TPIO';
        }
        corrections.push({
          field: 'metrics',
          action: 'preserve_invalid_metric_without_repair',
          from: metric
        });
        return metric;
      })
      .filter(Boolean);

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
   * 规范化分组字段
   * 
   * @param {object} query - 查询对象
   * @param {string} originalText - 原始文本
   * @param {array} warnings - 警告记录数组
   * @param {array} corrections - 修正记录数组
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

    const allowMetadataRepair = this.shouldAllowMetadataRepair(query);

    if (!Array.isArray(query.groups) || query.groups.length === 0) {
      if (!allowMetadataRepair) {
        warnings.push('missing_groups_without_repair');
        return;
      }

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
          if (!allowMetadataRepair) {
            corrections.push({
              field: 'groups.type',
              action: 'preserve_unknown_group_without_repair',
              to: normalized.type
            });
            return normalized;
          }

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
   * 规范化 TopCount
   * 
   * @param {object} query - 查询对象
   * @param {array} corrections - 修正记录数组
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
   * 规范化时间粒度
   * 
   * @param {object} query - 查询对象
   * @param {array} corrections - 修正记录数组
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
   * 构建兼容性信息
   * 
   * @param {object} query - 查询对象
   * @param {array} warnings - 警告记录数组
   * @param {array} corrections - 修正记录数组
   * @returns {object|null} - 兼容性信息对象
   */
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
    if (!currentGroup) {
      warnings.push(`metric_group_missing:${metric}`);
      return {
        metric,
        domainId,
        domainLabel: domainMeta ? domainMeta.label : null,
        compatibleObjects,
        preferredObjects,
        selectedGroup: null,
        isCompatible: false
      };
    }

    const isCompatible = currentGroup ? compatibleObjects.includes(currentGroup) : false;
    const explicitTarget = this.extractExplicitTargetObjectType(query);
    const shouldPreserveExplicitTarget = Boolean(
      explicitTarget
      && currentGroup
      && explicitTarget === currentGroup
    );
    const businessOwnershipViolation = Boolean(
      currentGroup
      && isBusinessObjectType(currentGroup)
      && !getOwnedMetricIdsForObjectType(currentGroup).includes(String(metric || '').trim().toUpperCase())
    );

    if ((businessOwnershipViolation || !isCompatible) && compatibleObjects.length > 0) {
      if (shouldPreserveExplicitTarget) {
        warnings.push(`metric_group_incompatible_but_preserve_explicit_target:${metric}:${currentGroup}`);
      } else {
        const fallbackGroup = this.pickFallbackGroup(query.userRequirement || '', compatibleObjects, preferredObjects);
        warnings.push(
          businessOwnershipViolation
            ? `metric_group_ownership_incompatible:${metric}:${currentGroup}`
            : `metric_group_incompatible:${metric}:${currentGroup}`
        );
        if (fallbackGroup && fallbackGroup !== currentGroup && this.shouldAllowMetadataRepair(query)) {
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

  // 提取 query 中显式给出的目标对象类型，用于兼容性修正时判断是否应保留用户意图。
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
   * 选择降级分组类型
   * 
   * @param {string} originalText - 原始文本
   * @param {array} compatibleObjects - 兼容的对象类型列表
   * @param {array} preferredObjects - 首选的对象类型列表
   * @returns {string} - 降级分组类型
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
   * 使用动态元数据约束查询
   * 
   * @param {object} query - 查询对象
   * @param {object} metadataReview - 动态元数据审核结果
   * @returns {object} - 约束处理结果
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
        const scopedGroupArguments = this.filterGroupArgumentsByObjectNamespace(
          metadataReview.groupArguments,
          firstGroup.type
        );
        const matched = scopedGroupArguments.some(item => String(item.value).toLowerCase() === String(firstGroup.argument).toLowerCase());
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

  filterGroupArgumentsByObjectNamespace(groupArguments = [], groupType = '') {
    const expected = this.normalizeLegacyGroupType(groupType, 0);
    const scoped = groupArguments.filter((item) => this.isGroupArgumentInObjectNamespace(item, expected));
    return scoped.length > 0 ? scoped : groupArguments;
  }

  isGroupArgumentInObjectNamespace(item = {}, expected = '') {
    if (!expected) {
      return true;
    }

    const types = [
      item.requestedObjectType,
      item.effectiveObjectType,
      item.objectType,
      item.type
    ].map(value => this.normalizeLegacyGroupType(value, 0)).filter(Boolean);

    if (types.length === 0) {
      return true;
    }

    return types.includes(expected);
  }
}

module.exports = new QueryMetadataConstraintService();
