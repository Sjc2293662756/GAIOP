/**
 * RequirementParserService.js
 *
 * NAPM skill 运行时执行服务。
 *
 * 当前主职责是把已经结构化的查询对象收口为可执行的 NAPM 请求，并负责：
 * - 执行前校验与收口
 * - 对象 / 指标 / service mode / 时间参数对齐
 * - 调用 NAPM / NetInside API
 * - 返回执行结果与调试摘要
 *
 * 说明：
 * - 文件中仍保留较多 `gatewayRequest` 历史命名，当前表示“运行时执行查询对象”，
 *   不代表旧项目级 gateway 仍是现行主链。
 */
const fs = require('fs');
const path = require('path');

const MetricMappingService = require('./MetricMappingService');
const NapmClient = require('./NapmClient');
const GroupBuilder = require('./GroupBuilder');
const QueryValidator = require('./QueryValidator');
const NapmMetadataService = require('./NapmMetadataService');
const GroupPathPlannerService = require('./GroupPathPlannerService');
const QueryMetadataConstraintService = require('./QueryMetadataConstraintService');
const ResolutionSpecService = require('./ResolutionSpecService');
// const ScopedDescentProbeService = require('./ScopedDescentProbeService');
const CsvParser = require('../../../src/utils/CsvParser');
const TimeUtils = require('../../../src/utils/TimeUtils');
const logger = require('../../../src/utils/logger');
const { logAudit, buildSafeUrl, maskSensitiveParams, buildOrderedParams } = require('../../../src/utils/auditLogger');
const {
  filterMetricsForObjectType,
  rankMetricIdsForObjectType,
  resolveMetricOwnershipObjectType,
  isMetricCompatibleWithGroupPath
} = require('../../../src/constants/objectMetricOwnership');
const {
  normalizeSemanticMetricDomainToken
} = require('../../../src/constants/metricDomains');

/**
 * RequirementParserService 类
 * 当前 skill 运行时中的核心执行服务，负责将结构化查询执行为 NAPM 请求。
 */
class RequirementParserService {
  // 初始化执行期依赖，包括元数据服务、路径规划器和稳定模板缓存。
  constructor() {
    this.metricMappingService = MetricMappingService;
    this.napmClient = new NapmClient();
    this.groupBuilder = GroupBuilder;
    this.queryValidator = QueryValidator;
    this.napmMetadataService = NapmMetadataService;
    this.groupPathPlannerService = GroupPathPlannerService;
    this.queryMetadataConstraintService = QueryMetadataConstraintService;
    this.assertDependencyContracts();
    this.gatewayTemplatesDisabled = this.resolveGatewayTemplateDisableFlag();
    this.stableQueryTemplates = this.loadStableQueryTemplates();
  }

  assertDependencyContracts() {
    const requiredFunctions = {
      filterMetricsForObjectType,
      rankMetricIdsForObjectType,
      resolveMetricOwnershipObjectType,
      isMetricCompatibleWithGroupPath
    };
    const missing = Object.entries(requiredFunctions)
      .filter(([, fn]) => typeof fn !== 'function')
      .map(([name]) => name);

    if (missing.length === 0) {
      return true;
    }

    const error = new Error(`Dependency contract mismatch: objectMetricOwnership missing functions: ${missing.join(', ')}`);
    error.code = 'DEPENDENCY_CONTRACT_MISMATCH';
    error.details = {
      module: 'src/constants/objectMetricOwnership',
      missing
    };
    throw error;
  }

  /**
   * 按首层对象类型过滤指标库存，优先保留与当前对象归属兼容的指标。
   */
  filterMetricInventoryForOwnership(groups = [], metrics = []) {
    const items = Array.isArray(metrics) ? metrics : [];
    const firstType = String(groups?.[0]?.type || '').trim();
    if (!firstType) {
      return items;
    }
    return filterMetricsForObjectType(firstType, items);
  }

  resolveGatewayTemplateDisableFlag() {
    const raw = String(
      process.env.DISABLE_GATEWAY_TEMPLATES
      || process.env.NAPM_DISABLE_GATEWAY_TEMPLATES
      || ''
    ).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(raw);
  }

  areGatewayTemplatesDisabled() {
    return Boolean(this.gatewayTemplatesDisabled);
  }

  shouldAllowPathRepair(query = {}) {
    return Boolean(
      query?.executionOptions?.allowPathRepair === true
      || query?.executionHints?.allowPathRepair === true
      || query?.pathPlanning?.allowExecutionRepair === true
    );
  }

  shouldAllowMetadataRepair(query = {}) {
    return Boolean(
      query?.executionOptions?.allowMetadataRepair === true
      || query?.executionHints?.allowMetadataRepair === true
    );
  }

  shouldAllowServiceFallback(query = {}) {
    return Boolean(
      query?.executionOptions?.allowServiceFallback === true
      || query?.executionHints?.allowServiceFallback === true
    );
  }

  shouldAllowInventoryFallback(query = {}) {
    return Boolean(
      query?.executionOptions?.allowInventoryFallback === true
      || query?.executionHints?.allowInventoryFallback === true
    );
  }

  shouldAllowStableTemplateRepair(query = {}) {
    return Boolean(
      query?.executionOptions?.allowStableTemplateRepair === true
      || query?.executionHints?.allowStableTemplateRepair === true
    );
  }

  /**
   * 加载稳定查询模板。
   * 只读取 resolution spec 中的模板定义；旧版独立 JSON 配置已下线。
   */
  loadStableQueryTemplates() {
    if (this.areGatewayTemplatesDisabled()) {
      logger.warn('Gateway stable templates are disabled by environment flag.');
      return [];
    }

    try {
      const specTemplates = ResolutionSpecService.getTemplateSpec();
      const specEnabled = specTemplates?.stableQueryTemplatesEnabledInSkillRuntime;
      const specTemplateList = Array.isArray(specTemplates?.stableQueryTemplates)
        ? specTemplates.stableQueryTemplates
        : [];

      if (specEnabled === false) {
        logger.warn('Gateway stable templates are disabled by resolution spec switch.');
        return [];
      }

      if (specTemplateList.length > 0) {
        return specTemplateList
          .map((template) => this.normalizeStableTemplateDefinition(template))
          .filter(Boolean);
      }

      return [];
    } catch (error) {
      logger.warn('Failed to load stable query templates:', error.message);
      return [];
    }
  }

  normalizeStableTemplateAllowedGroupPaths(pathLists = []) {
    const items = Array.isArray(pathLists) ? pathLists : [];
    const seen = new Set();
    const normalizedPaths = [];

    items.forEach((pathTypes) => {
      const normalized = this.normalizeTopLevelGroupPath(pathTypes);
      if (!Array.isArray(normalized) || normalized.length === 0) {
        return;
      }
      const key = normalized.join('>');
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      normalizedPaths.push(normalized);
    });

    return normalizedPaths;
  }

  normalizeStableTemplateInferredArguments(inferredArguments = null) {
    if (!inferredArguments || typeof inferredArguments !== 'object') {
      return inferredArguments;
    }

    const normalized = { ...inferredArguments };
    if (normalized.Application && !normalized.DefinedApp) {
      normalized.DefinedApp = normalized.Application;
    }
    return normalized;
  }

  /**
   * 归一化稳定模板定义，统一 groupPath、allowedGroupPaths、metric 列表和推断参数。
   * 这里也会做一次指标归属兼容性校验，避免模板在运行时生成不可执行请求。
   */
  normalizeStableTemplateDefinition(template = null) {
    if (!template || typeof template !== 'object') {
      return null;
    }

    const normalized = JSON.parse(JSON.stringify(template));
    const bindings = normalized.bindings && typeof normalized.bindings === 'object'
      ? normalized.bindings
      : {};

    const normalizedGroupPath = this.normalizeTopLevelGroupPath(bindings.groupPath);
    if (Array.isArray(normalizedGroupPath) && normalizedGroupPath.length > 0) {
      bindings.groupPath = normalizedGroupPath;
    }

    const normalizedAllowedGroupPaths = this.normalizeStableTemplateAllowedGroupPaths([
      ...(Array.isArray(normalized.allowedGroupPaths) ? normalized.allowedGroupPaths : []),
      ...(Array.isArray(bindings.allowedGroupPaths) ? bindings.allowedGroupPaths : []),
      ...(Array.isArray(bindings.groupPath) && bindings.groupPath.length > 0 ? [bindings.groupPath] : [])
    ]);
    if (normalizedAllowedGroupPaths.length > 0) {
      normalized.allowedGroupPaths = normalizedAllowedGroupPaths.map((pathTypes) => pathTypes.slice());
      bindings.allowedGroupPaths = normalizedAllowedGroupPaths.map((pathTypes) => pathTypes.slice());
    }

    if (
      (!Array.isArray(bindings.groupPath) || bindings.groupPath.length === 0)
      && normalizedAllowedGroupPaths.length === 1
    ) {
      bindings.groupPath = normalizedAllowedGroupPaths[0].slice();
    }

    const metricList = [
      ...(Array.isArray(bindings.primaryMetrics) ? bindings.primaryMetrics : []),
      ...(Array.isArray(bindings.metrics) ? bindings.metrics : []),
      ...(bindings.metric ? [bindings.metric] : []),
      ...(Array.isArray(bindings.auxMetrics) ? bindings.auxMetrics : [])
    ]
      .map((metricId) => String(metricId || '').trim().toUpperCase())
      .filter(Boolean);

    const ownershipObjectType = resolveMetricOwnershipObjectType(
      Array.isArray(bindings.groupPath)
        ? bindings.groupPath.map((type) => ({ type }))
        : [],
      bindings.groupPath?.[0] || ''
    );
    const rankedMetrics = ownershipObjectType
      ? rankMetricIdsForObjectType(ownershipObjectType, metricList)
      : Array.from(new Set(metricList));

    if (rankedMetrics.length > 0) {
      bindings.metrics = rankedMetrics.slice();
      bindings.metric = rankedMetrics[0];
      bindings.primaryMetrics = Array.isArray(bindings.primaryMetrics) && bindings.primaryMetrics.length > 0
        ? rankedMetrics.filter((metricId) => bindings.primaryMetrics.includes(metricId))
        : [rankedMetrics[0]];
      bindings.auxMetrics = rankedMetrics.filter((metricId) => !bindings.primaryMetrics.includes(metricId));
    }

    if (
      ownershipObjectType
      && bindings.metric
      && !isMetricCompatibleWithGroupPath(
        Array.isArray(bindings.groupPath) ? bindings.groupPath.map((type) => ({ type })) : [],
        bindings.metric,
        ownershipObjectType
      )
    ) {
      logger.warn('Skip stable template due to metric ownership incompatibility', {
        templateId: normalized.id || null,
        metric: bindings.metric,
        groupPath: bindings.groupPath || []
      });
      return null;
    }

    const normalizedMetricDomainToken = normalizeSemanticMetricDomainToken(
      normalized.metricDomainToken || normalized.metricDomain || ''
    );
    if (normalizedMetricDomainToken) {
      normalized.metricDomainToken = normalizedMetricDomainToken;
    }

    normalized.inferredArguments = this.normalizeStableTemplateInferredArguments(normalized.inferredArguments);
    normalized.bindings = bindings;
    return normalized;
  }

  // 生成适合审计日志输出的请求摘要，避免在日志中打印整份运行时对象。
  buildGatewayRequestSummary(gatewayRequest) {
    if (!gatewayRequest) {
      return null;
    }

    return {
      service: gatewayRequest.service,
      start: gatewayRequest.start,
      end: gatewayRequest.end,
      metric: gatewayRequest.metric,
      topMetric: gatewayRequest.topMetric || null,
      metrics: gatewayRequest.metrics,
      metricFilter: gatewayRequest.metricFilter || null,
      topCount: gatewayRequest.topCount,
      granularity: gatewayRequest.granularity,
      groups: gatewayRequest.groups,
      stableTemplate: gatewayRequest.stableTemplate || null,
      executionBinding: gatewayRequest.executionBinding || null,
      intentResult: gatewayRequest.intentResult || null,
      semanticResolutionResult: gatewayRequest.semanticResolutionResult || null,
      executionGuard: gatewayRequest.executionGuard || null,
      candidateGeneration: gatewayRequest.candidateGeneration || null,
      candidateSpec: gatewayRequest.candidateSpec || null,
      resolvedSpec: gatewayRequest.resolvedSpec || null,
      entityResolve: gatewayRequest.entityResolve || null,
      clarificationGate: gatewayRequest.clarificationGate || null,
      timeResolve: gatewayRequest.timeResolve || null,
      metricResolve: gatewayRequest.metricResolve || null,
      metricSemantic: gatewayRequest.metricSemantic || null,
      objectSemantic: gatewayRequest.objectSemantic || null,
      pathResolve: gatewayRequest.pathResolve || null,
      pathPlanning: gatewayRequest.pathPlanning || null,
      semanticConstraints: gatewayRequest.semanticConstraints || null
    };
  }

  buildExecutionDataSummary(data) {
    const rows = Array.isArray(data) ? data : [];
    return {
      rowCount: rows.length,
      sampleRows: rows.slice(0, 3)
    };
  }

  buildUpstreamPathGuard(gatewayRequest, error) {
    const message = String(error?.message || '');
    const groups = Array.isArray(gatewayRequest?.groups) ? gatewayRequest.groups : [];
    const looksLikeInvalidGroup = /status code 400/i.test(message)
      || /requires a valid group/i.test(message)
      || /invalid group/i.test(message)
      || /group .* not .* support/i.test(message);
    if (!looksLikeInvalidGroup || groups.length < 2) {
      return null;
    }

    const pathText = this.formatGroupPathWithArguments(groups);
    const service = String(gatewayRequest?.service || 'unknown');
    const metric = gatewayRequest?.metric || (Array.isArray(gatewayRequest?.metrics) ? gatewayRequest.metrics[0] : null);
    const candidatePaths = this.collectMetadataPathCandidates(gatewayRequest, pathText);

    return {
      code: 'UPSTREAM_GROUP_PATH_NOT_SUPPORTED',
      message: `NAPM upstream rejected the path ${pathText} for ${service} queries.`,
      details: {
        service,
        metric,
        groups,
        path: pathText,
        objectArgument: groups[0]?.argument || null,
        candidatePaths,
        upstreamMessage: message
      }
    };
  }

  formatGroupPathWithArguments(groups = []) {
    if (!Array.isArray(groups) || groups.length === 0) {
      return '-';
    }

    return groups
      .map((item) => {
        if (!item?.type) {
          return null;
        }
        const argument = String(item.argument ?? '').trim();
        return argument ? `${item.type}(${argument})` : item.type;
      })
      .filter(Boolean)
      .join(' -> ');
  }

  collectMetadataPathCandidates(gatewayRequest = {}, currentPath = '') {
    const candidates = new Set();

    const addPathText = (value) => {
      const normalized = String(value || '').trim();
      if (!normalized || normalized === currentPath) {
        return;
      }
      candidates.add(normalized);
    };

    const addPathTypes = (pathTypes) => {
      const normalizedPath = this.normalizeTopLevelGroupPath(pathTypes);
      if (!Array.isArray(normalizedPath) || normalizedPath.length === 0) {
        return;
      }
      addPathText(normalizedPath.join(' -> '));
    };

    const addPathCollection = (items) => {
      if (!Array.isArray(items)) {
        return;
      }
      items.forEach((item) => {
        if (!item) {
          return;
        }
        addPathText(item.pathText);
        addPathTypes(item.path);
        addPathTypes(item.groupPath);
      });
    };

    addPathCollection(gatewayRequest?.pathResolve?.overview_convergence_paths);
    addPathCollection(gatewayRequest?.pathResolve?.candidates);
    addPathCollection(gatewayRequest?.pathPlanning?.overviewConvergencePaths);
    addPathCollection(gatewayRequest?.pathPlanning?.templateCandidates);

    if (Array.isArray(gatewayRequest?.executionBinding?.allowedGroupPaths)) {
      gatewayRequest.executionBinding.allowedGroupPaths.forEach((pathTypes) => addPathTypes(pathTypes));
    }
    addPathTypes(gatewayRequest?.stableTemplate?.bindings?.groupPath);
    if (Array.isArray(gatewayRequest?.stableTemplate?.bindings?.allowedGroupPaths)) {
      gatewayRequest.stableTemplate.bindings.allowedGroupPaths.forEach((pathTypes) => addPathTypes(pathTypes));
    }
    if (Array.isArray(gatewayRequest?.stableTemplate?.allowedGroupPaths)) {
      gatewayRequest.stableTemplate.allowedGroupPaths.forEach((pathTypes) => addPathTypes(pathTypes));
    }

    return Array.from(candidates).slice(0, 5);
  }

  /**
   * 基于动态元数据结果对查询做最后一轮收口。
   * 主要补齐 group argument、修正 metric，并把路径规划结果落回最终请求。
   */
  applyMetadataDrivenFinalization(query, dynamicMetadataReview = null, baseResult = null, pathPlan = null) {
    if (!query || typeof query !== 'object') {
      return query;
    }

    const request = JSON.parse(JSON.stringify(query));
    const scopeHints = Array.from(new Set([
      ...(Array.isArray(baseResult?.scopeHints) ? baseResult.scopeHints : []),
      ...(Array.isArray(baseResult?.candidateGeneration?.scopeHints) ? baseResult.candidateGeneration.scopeHints : []),
      ...(Array.isArray(request?.scopeHints) ? request.scopeHints : []),
      ...(Array.isArray(request?.semanticConstraints?.scopeHints) ? request.semanticConstraints.scopeHints : [])
    ].map((item) => String(item || '').trim()).filter(Boolean)));

    const plannedGroups = this.shouldAllowPathRepair(request) && Array.isArray(pathPlan?.plannedGroups)
      ? pathPlan.plannedGroups
      : [];
    if (plannedGroups.length > 0) {
      request.groups = plannedGroups.map((item) => ({
        type: item?.type,
        argument: item?.argument
      }));
      const targetType = plannedGroups[plannedGroups.length - 1]?.type || null;
      if (targetType) {
        request.semanticConstraints = {
          ...(request.semanticConstraints && typeof request.semanticConstraints === 'object' ? request.semanticConstraints : {}),
          targetObjectType: targetType
        };
      }
    }

    const firstGroup = Array.isArray(request.groups) && request.groups[0] ? request.groups[0] : null;
    if (
      this.shouldAllowMetadataRepair(request)
      && firstGroup
      && !firstGroup.argument
      && Array.isArray(dynamicMetadataReview?.groupArguments)
      && dynamicMetadataReview.groupArguments.length > 0
    ) {
      const matchedHint = scopeHints.find((hint) => (
        !this.looksLikePureTimeScopeHint(hint) &&
        dynamicMetadataReview.groupArguments.some((item) => (
          String(item?.value || '').toLowerCase() === hint.toLowerCase()
          || String(item?.label || '').toLowerCase() === hint.toLowerCase()
        ))
      ));
      if (matchedHint) {
        const matchedCandidate = dynamicMetadataReview.groupArguments.find((item) => (
          String(item?.value || '').toLowerCase() === matchedHint.toLowerCase()
          || String(item?.label || '').toLowerCase() === matchedHint.toLowerCase()
        ));
        firstGroup.argument = matchedCandidate?.value || matchedHint;
      }
    }

    const supportedMetrics = Array.isArray(dynamicMetadataReview?.metricsForGroup)
      ? dynamicMetadataReview.metricsForGroup
      : [];
    if (supportedMetrics.length > 0) {
      const supportedMetricSet = new Set(supportedMetrics.map((item) => String(item?.id || '').trim()).filter(Boolean));
      const metricCandidates = [
        ...(Array.isArray(baseResult?.metricCandidates) ? baseResult.metricCandidates : []),
        ...(Array.isArray(request?.metricCandidates) ? request.metricCandidates : []),
        ...(Array.isArray(baseResult?.candidateSpec?.candidate_inputs?.metric_candidates)
          ? baseResult.candidateSpec.candidate_inputs.metric_candidates
          : [])
      ]
        .map((item) => String(item?.id || item || '').trim())
        .filter(Boolean);

      const currentMetric = String(request.metric || '').trim();
      const currentSupported = currentMetric && supportedMetricSet.has(currentMetric);
      if (!currentSupported) {
        const matchedMetric = metricCandidates.find((metricId) => supportedMetricSet.has(metricId))
          || String(supportedMetrics[0]?.id || '').trim()
          || null;
        if (matchedMetric && this.shouldAllowMetadataRepair(request)) {
          request.metric = matchedMetric;
          request.metrics = [matchedMetric];
        }
      }
    }

    if (scopeHints.length > 0) {
      request.scopeHints = scopeHints.slice(0, 6);
    }

    return request;
  }

  looksLikePureTimeScopeHint(value = '') {
    const text = String(value || '').trim();
    if (!text) {
      return false;
    }

    return /^(?:今天|今日|昨天|昨日|前天|刚刚|刚才|现在|目前|当前|最近|近(?:1|2|3|4|6|8|12|24|48|72)?(?:小时|天|周)|本(?:小时|日|天|周|月)|上(?:小时|日|天|周|月)|下(?:小时|日|天|周|月))$/i.test(text);
  }

  isMultilevelGroupsInventoryQuery(query = {}) {
    const service = String(query?.service || '').trim();
    const groups = Array.isArray(query?.groups) ? query.groups.filter(Boolean) : [];
    const operation = String(
      query?.semanticConstraints?.operation
      || query?.candidateSpec?.semantic_constraints?.operation
      || ''
    ).trim().toLowerCase();

    return service === 'groups'
      && groups.length >= 2
      && operation === 'metadata_list';
  }

  buildMetricCandidatesFromMetadataReview(metadataReview = null, gatewayRequest = {}) {
    const supportedMetrics = Array.isArray(metadataReview?.metricsForGroup)
      ? metadataReview.metricsForGroup
      : [];
    if (supportedMetrics.length === 0) {
      return [];
    }

    const groups = Array.isArray(gatewayRequest?.groups)
      ? gatewayRequest.groups.filter(Boolean)
      : [];
    const allowRuntimeSupportedFallback = groups.length >= 2;
    const ownershipObjectType = resolveMetricOwnershipObjectType(
      groups,
      groups[0]?.type || ''
    );

    const preferredIds = [
      gatewayRequest?.topMetric,
      gatewayRequest?.metric,
      ...(Array.isArray(gatewayRequest?.metrics) ? gatewayRequest.metrics : []),
      ...supportedMetrics.map((item) => item?.id)
    ]
      .map((item) => String(item || '').trim())
      .filter(Boolean);

    const rankedPreferredIds = rankMetricIdsForObjectType(ownershipObjectType, preferredIds);
    const runtimeSupportedIds = [];
    const runtimeSupportedSeen = new Set();

    preferredIds.forEach((metricId) => {
      if (!metricId || runtimeSupportedSeen.has(metricId)) {
        return;
      }
      const matched = supportedMetrics.some((item) => String(item?.id || '').trim() === metricId);
      if (!matched) {
        return;
      }
      runtimeSupportedSeen.add(metricId);
      runtimeSupportedIds.push(metricId);
    });

    supportedMetrics.forEach((item) => {
      const metricId = String(item?.id || '').trim();
      if (!metricId || runtimeSupportedSeen.has(metricId)) {
        return;
      }
      runtimeSupportedSeen.add(metricId);
      runtimeSupportedIds.push(metricId);
    });

    const seen = new Set();
    const ranked = [];

    rankedPreferredIds.forEach((metricId) => {
      if (seen.has(metricId)) {
        return;
      }
      const matched = supportedMetrics.find((item) => String(item?.id || '').trim() === metricId);
      if (!matched) {
        return;
      }
      seen.add(metricId);
      ranked.push(metricId);
    });

    supportedMetrics.forEach((item) => {
      const metricId = String(item?.id || '').trim();
      if (!metricId || seen.has(metricId)) {
        return;
      }
      if (
        ownershipObjectType
        && !isMetricCompatibleWithGroupPath(gatewayRequest?.groups, metricId, ownershipObjectType)
      ) {
        return;
      }
      seen.add(metricId);
      ranked.push(metricId);
    });

    if (allowRuntimeSupportedFallback) {
      // 对多层路径来说，metricsForGroup 更接近上游真实可执行能力。
      // 因此先保留静态归属兼容指标，再补入运行时确认可用的候选，避免误杀。
      runtimeSupportedIds.forEach((metricId) => {
        if (seen.has(metricId)) {
          return;
        }
        seen.add(metricId);
        ranked.push(metricId);
      });
    }

    return ranked;
  }

  buildInventoryRowsFromTopValues(rows = []) {
    const deduped = new Map();
    const items = Array.isArray(rows) ? rows : [];

    items.forEach((row) => {
      const label = String(
        row?.group?.argument
        || row?.group?.label
        || row?.label
        || row?.object
        || row?.value
        || ''
      ).trim();
      if (!label || deduped.has(label)) {
        return;
      }

      deduped.set(label, {
        label,
        value: label,
        type: row?.group?.key || row?.group?.type || null
      });
    });

    return Array.from(deduped.values());
  }

  /**
   * 当多层 groups 查询无法直接拿到子对象清单时，尝试改走 topValues 做清单兜底。
   */
  async tryExecuteInventoryFallback(gatewayRequest, metadataReview = null, requestContext = null) {
    if (!this.shouldAllowInventoryFallback(gatewayRequest)) {
      return null;
    }

    if (!this.isMultilevelGroupsInventoryQuery(gatewayRequest)) {
      return null;
    }

    const metricCandidates = this.buildMetricCandidatesFromMetadataReview(metadataReview, gatewayRequest);
    if (metricCandidates.length === 0) {
      return null;
    }

    for (const metricId of metricCandidates.slice(0, 6)) {
      const fallbackRequest = {
        ...JSON.parse(JSON.stringify(gatewayRequest)),
        service: 'topValues',
        metric: metricId,
        metrics: [metricId],
        topMetric: metricId,
        topCount: gatewayRequest?.topCount || 200
      };

      const result = await this.executeDirectGatewayRequest(fallbackRequest, requestContext);
      if (!result?.ok) {
        continue;
      }

      const inventoryRows = this.buildInventoryRowsFromTopValues(result.data);
      if (inventoryRows.length === 0) {
        continue;
      }
      return {
        ok: true,
        service: 'groups',
        data: inventoryRows,
        requestUrl: result.requestUrl,
        requestParams: result.requestParams,
        requestParamsMasked: result.requestParamsMasked,
        warnings: [
          {
            code: 'MULTILEVEL_GROUPS_INVENTORY_FALLBACK',
            message: `The upstream groups service did not provide child inventory for this multilevel path, so topValues(${metricId}) was used as a scoped inventory fallback.`
          }
        ]
      };
    }

    return null;
  }

  // 为 averageValues 多层路径构造 topValues 回退请求，尽量保住可执行性。
  buildMultilevelDataServiceFallbackQuery(gatewayRequest = {}, metadataReview = null) {
    if (!this.shouldAllowServiceFallback(gatewayRequest)) {
      return null;
    }

    const groups = Array.isArray(gatewayRequest?.groups) ? gatewayRequest.groups.filter(Boolean) : [];
    if (groups.length < 2) {
      return null;
    }

    const service = String(gatewayRequest?.service || '').trim();
    if (service !== 'averageValues') {
      return null;
    }

    const supportedMetrics = this.buildMetricCandidatesFromMetadataReview(metadataReview, gatewayRequest);
    const selectedMetric = supportedMetrics[0]
      || String(gatewayRequest?.metric || gatewayRequest?.metrics?.[0] || '').trim();
    if (!selectedMetric) {
      return null;
    }

    const fallback = JSON.parse(JSON.stringify(gatewayRequest));
    fallback.service = 'topValues';
    fallback.metric = selectedMetric;
    fallback.metrics = [selectedMetric];
    fallback.topMetric = selectedMetric;
    fallback.topCount = gatewayRequest?.topCount || 20;
    fallback.executionFallback = {
      strategy: 'multilevel_to_topvalues',
      originalService: service,
      originalMetric: gatewayRequest?.metric || gatewayRequest?.metrics?.[0] || null,
      fallbackMetric: selectedMetric
    };
    return fallback;
  }

  buildMultiLevelServiceCompatibilityWarning(gatewayRequest = {}, fallbackQuery = {}) {
    const groups = this.formatGroupPathWithArguments(gatewayRequest?.groups || []);
    const originalService = String(gatewayRequest?.service || '').trim() || 'unknown';
    const fallbackMetric = String(
      fallbackQuery?.metric
      || fallbackQuery?.metrics?.[0]
      || fallbackQuery?.topMetric
      || ''
    ).trim();

    return {
      code: 'MULTILEVEL_SERVICE_COMPATIBILITY_FALLBACK',
      message: `The upstream ${originalService} service is not stable for the multilevel path ${groups}, so the query was executed with topValues${fallbackMetric ? `(${fallbackMetric})` : ''} instead.`
    };
  }

  /**
   * 执行前做一次动态元数据审查，提前发现组对象、指标和路径是否真实可用。
   */
  async reviewGatewayRequestMetadata(gatewayRequest = {}) {
    if (!gatewayRequest || typeof gatewayRequest !== 'object') {
      return null;
    }

    try {
      return await this.napmMetadataService.reviewQuery(gatewayRequest);
    } catch (error) {
      logger.warn('Dynamic metadata review failed before execution', {
        error: error.message
      });
      return null;
    }
  }

  /**
   * 统一准备执行态查询。
   * 这里会依次做形态归一化、静态约束、动态约束、最终收口，以及回退链路预判。
   */
  async prepareGatewayExecution(gatewayRequest = {}, requestContext = null) {
    const normalizedQuery = this.normalizeTopLevelQueryShape(gatewayRequest);
    const staticConstraint = this.queryMetadataConstraintService.constrain(
      normalizedQuery,
      normalizedQuery?.userRequirement || ''
    );
    let preparedQuery = staticConstraint?.query || normalizedQuery;
    const metadataReview = await this.reviewGatewayRequestMetadata(preparedQuery);
    const dynamicConstraint = await this.queryMetadataConstraintService.constrainWithDynamicMetadata(
      preparedQuery,
      metadataReview
    );
    preparedQuery = this.applyMetadataDrivenFinalization(
      dynamicConstraint?.query || preparedQuery,
      metadataReview,
      preparedQuery,
      preparedQuery?.pathPlanning || null
    );

    const inventoryFallback = await this.tryExecuteInventoryFallback(preparedQuery, metadataReview, requestContext);
    const serviceFallbackQuery = this.buildMultilevelDataServiceFallbackQuery(preparedQuery, metadataReview);

    return {
      query: preparedQuery,
      metadataReview,
      staticConstraint,
      dynamicConstraint,
      inventoryFallback,
      serviceFallbackQuery
    };
  }

  normalizeExecutableQueryShape(gatewayRequest = {}) {
    const query = gatewayRequest && typeof gatewayRequest === 'object'
      ? this.normalizeExecutableQueryShape(gatewayRequest)
      : {};

    if (query.service === 'metrics' || query.service === 'groups') {
      delete query.metric;
      delete query.metrics;
      delete query.topMetric;
      return query;
    }

    const metricCandidates = [
      ...(Array.isArray(query.metrics) ? query.metrics : []),
      query.metric,
      query.topMetric
    ].map((metricId) => String(metricId || '').trim()).filter(Boolean);

    const seen = new Set();
    const normalizedMetrics = [];
    metricCandidates.forEach((metricId) => {
      const normalizedMetric = metricId.toUpperCase();
      if (seen.has(normalizedMetric)) {
        return;
      }
      seen.add(normalizedMetric);
      normalizedMetrics.push(normalizedMetric);
    });

    if (normalizedMetrics.length > 0) {
      query.metrics = normalizedMetrics;
    } else {
      delete query.metrics;
    }

    if (query.metric) {
      query.metric = String(query.metric).trim().toUpperCase();
    } else if (normalizedMetrics.length > 0) {
      query.metric = normalizedMetrics[0];
    }

    if (query.service === 'topValues') {
      if (query.topMetric) {
        query.topMetric = String(query.topMetric).trim().toUpperCase();
      } else if (query.metric) {
        query.topMetric = query.metric;
      } else if (normalizedMetrics.length > 0) {
        query.topMetric = normalizedMetrics[0];
      }
    }

    return query;
  }

  buildMetricCsv(queryRequest = {}, service = '') {
    const metrics = Array.isArray(queryRequest.metrics)
      ? queryRequest.metrics.map((metricId) => String(metricId || '').trim()).filter(Boolean)
      : [];
    if (metrics.length > 0) {
      return metrics.join(',');
    }

    const fallbackMetric = String(
      queryRequest.metric
      || (service === 'topValues' ? queryRequest.topMetric : '')
      || ''
    ).trim();
    if (fallbackMetric) {
      return fallbackMetric;
    }

    const error = new Error(`Metrics are required for ${service || queryRequest.service || 'query'} execution`);
    error.code = 'QUERY_SHAPE_INVALID';
    error.details = {
      service: service || queryRequest.service || null,
      metric: queryRequest.metric || null,
      topMetric: queryRequest.topMetric || null,
      metrics: queryRequest.metrics || null
    };
    throw error;
  }

  buildExecutionFailureError(error) {
    const localCodes = new Set([
      'QUERY_SHAPE_INVALID',
      'DEPENDENCY_CONTRACT_MISMATCH',
      'METADATA_ARGUMENT_TYPE_UNRESOLVED',
      'INVALID_METADATA_INVENTORY_ARGUMENT'
    ]);
    const code = localCodes.has(error?.code) ? error.code : 'NAPM_UPSTREAM_ERROR';
    return {
      code,
      message: error?.message || String(error),
      ...(error?.details ? { details: error.details } : {})
    };
  }

  /**
   * 直接执行网关请求。
   * 这个阶段不再改写语义，只负责参数校验、请求组装、上游调用、审计记录和错误收口。
   *
   * @param {object} gatewayRequest - 已结构化的执行态查询对象
   * @param {object} requestContext - 请求上下文
   * @returns {Promise<object>} - 上游执行结果、调试参数与错误信息
   */
  async executeDirectGatewayRequest(gatewayRequest, requestContext = null) {
    // 网关仅负责按上游结构化参数执行查询，不在本地改写查询语义或执行策略。
    const passthroughGatewayRequest = gatewayRequest && typeof gatewayRequest === 'object'
      ? JSON.parse(JSON.stringify(gatewayRequest))
      : {};
    const response = {
      ok: false,
      service: null,
      data: null,
      error: null,
      metadata: null,
      requestParams: null,
      requestParamsMasked: null
    };

    try {
      logger.info('\n========================================');
      logger.info('=== 语义网关调用 ===');
      logger.info('正在解析网关请求 JSON...');

      const queryRequest = {
        service: passthroughGatewayRequest.service,
        start: passthroughGatewayRequest.start,
        end: passthroughGatewayRequest.end,
        metric: passthroughGatewayRequest.metric,
        topMetric: passthroughGatewayRequest.topMetric || null,
        metrics: passthroughGatewayRequest.metrics,
        topCount: passthroughGatewayRequest.topCount,
        granularity: passthroughGatewayRequest.granularity,
        format: passthroughGatewayRequest.format,
        userRequirement: passthroughGatewayRequest.userRequirement,
        groups: passthroughGatewayRequest.groups ? passthroughGatewayRequest.groups.map(g => ({
          type: g.type,
          argument: g.argument
        })) : []
      };

      const attachDebugRequestInfo = (params = {}) => {
        const fullParams = {
          UserName: this.napmClient.username,
          Password: this.napmClient.password,
          ...params
        };
        response.requestParams = { ...params };
        response.requestParamsMasked = maskSensitiveParams(fullParams);
        response.requestUrl = buildSafeUrl(this.napmClient.baseUrl, fullParams);
      };

      const metadataGroups = queryRequest.groups.map((group) => ({
        ...group,
        type: this.groupBuilder.parseGroupType(group?.type) || group?.type || null
      }));

      if (queryRequest.service === 'metrics' && metadataGroups.length > 0) {
        const metadataParams = {
          type: 'metricsForGroup',
          start: queryRequest.start,
          end: queryRequest.end,
          json: 'true',
          ...this.groupBuilder.buildGroupParams(metadataGroups)
        };
        attachDebugRequestInfo(metadataParams);
        const metadataMetrics = await this.napmMetadataService.getMetricsForGroupPath(metadataGroups);
        const ownedMetrics = this.filterMetricInventoryForOwnership(metadataGroups, metadataMetrics);
        response.ok = true;
        response.service = queryRequest.service;
        response.data = ownedMetrics;
        logAudit('napm_metadata_metrics_for_group_completed', {
          gatewayRequest: this.buildGatewayRequestSummary({ ...queryRequest, groups: metadataGroups }),
          execution: this.buildExecutionDataSummary(ownedMetrics),
          params: response.requestParamsMasked,
          url: response.requestUrl
        }, requestContext);
        return response;
      }

      if (queryRequest.service === 'groups' && metadataGroups.length === 1) {
        const firstGroup = metadataGroups[0] || {};
        const firstType = String(firstGroup.type || '').trim();
        const firstArgument = String(firstGroup.argument || '').trim();
        let namedList = null;
        let metadataTypeForDebug = 'groups';
        let metadataParams = null;
        let instanceProviderMetadata = null;

        instanceProviderMetadata = await this.napmMetadataService.resolveObjectInstanceProviderMetadata(firstType);
        if (instanceProviderMetadata) {
          this.assertMetadataInventoryArgumentContract(firstType, firstArgument, instanceProviderMetadata);
          namedList = await this.napmMetadataService.listObjectInstances(firstType, firstArgument);
          metadataTypeForDebug = instanceProviderMetadata.apiType;
        }

        if (Array.isArray(namedList)) {
          if (metadataTypeForDebug === 'groups') {
            metadataParams = {
              type: 'groups',
              start: queryRequest.start,
              end: queryRequest.end,
              json: 'true',
              ...this.groupBuilder.buildGroupParams(metadataGroups)
            };
          } else if (metadataTypeForDebug === 'groupArguments') {
            metadataParams = {
              type: 'groupArguments',
              argumentType: instanceProviderMetadata.argumentType,
              json: 'true'
            };
          } else {
            metadataParams = {
              type: metadataTypeForDebug,
              json: 'true'
            };
          }
          attachDebugRequestInfo(metadataParams);
          response.ok = true;
          response.service = queryRequest.service;
          response.data = namedList;
          response.metadata = instanceProviderMetadata;
          logAudit('napm_metadata_named_groups_completed', {
            gatewayRequest: this.buildGatewayRequestSummary({ ...queryRequest, groups: metadataGroups }),
            execution: this.buildExecutionDataSummary(namedList),
            metadata: instanceProviderMetadata,
            params: response.requestParamsMasked,
            url: response.requestUrl
          }, requestContext);
          return response;
        }
      }

      logger.info('正在验证请求参数...');
      this.queryValidator.validateGatewayRequest(passthroughGatewayRequest);

      const params = {
        type: queryRequest.service,
        start: queryRequest.start,
        end: queryRequest.end,
        json: 'true'
      };

      if (queryRequest.service === 'topValues') {
        params.topMetric = queryRequest.topMetric || queryRequest.metric;
        params.metrics = this.buildMetricCsv(queryRequest, queryRequest.service);
        params.topCount = queryRequest.topCount || 20;
      } else if (queryRequest.service === 'averageValues') {
        params.metrics = this.buildMetricCsv(queryRequest, queryRequest.service);
      } else if (queryRequest.service === 'timeValues') {
        params.metrics = this.buildMetricCsv(queryRequest, queryRequest.service);
        params.granularity = queryRequest.granularity;
      }

      if (queryRequest.groups && queryRequest.groups.length > 0) {
        Object.assign(params, this.groupBuilder.buildGroupParams(queryRequest.groups));
      }

      logger.info('正在构建 URL...');
      const fullParams = {
        UserName: this.napmClient.username,
        Password: this.napmClient.password,
        ...params
      };
      response.requestParams = { ...params };
      response.requestParamsMasked = maskSensitiveParams(fullParams);
      const url = buildSafeUrl(this.napmClient.baseUrl, fullParams);
      response.requestUrl = url;
      logger.info('拼接好的 URL:');
      logger.info(url);
      logger.info('========================================');

      logAudit('napm_api_request_built', {
        gatewayRequest: this.buildGatewayRequestSummary(queryRequest),
        params: maskSensitiveParams(fullParams),
        url
      }, requestContext);

      logger.info('正在请求 URL...');
      const rawPayload = await this.napmClient.get(params);
      const csvText = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);
      logger.info('请求到的数据:');
      logger.info(typeof rawPayload === 'string' ? rawPayload.substring(0, 200) + (rawPayload.length > 200 ? '...' : '') : JSON.stringify(rawPayload).substring(0, 200));
      logger.info('数据长度:', csvText.length);

      logger.info('正在解析数据...');
      const data = this.parseNapmPayload(rawPayload);
      logger.info('解析到数据行数:', data.length);
      logger.info('解析后的数据:');
      logger.info(JSON.stringify(data.slice(0, 3), null, 2));

      response.ok = true;
      response.service = queryRequest.service;
      response.data = data;

      logAudit('napm_execution_completed', {
        gatewayRequest: this.buildGatewayRequestSummary(queryRequest),
        execution: this.buildExecutionDataSummary(data)
      }, requestContext);

      logger.info('网关请求执行成功。');
      logger.info('========================================\n');

      return response;
    } catch (error) {
      logger.error('网关请求执行失败:', error.message);
      const upstreamGuard = this.buildUpstreamPathGuard(gatewayRequest, error);
      if (upstreamGuard) {
        response.error = upstreamGuard;
        logAudit('napm_execution_blocked_by_upstream_path_guard', {
          gatewayRequest: this.buildGatewayRequestSummary(gatewayRequest),
          error: upstreamGuard
        }, requestContext);
        logger.info('========================================\n');
        return response;
      }

      response.error = this.buildExecutionFailureError(error);
      logAudit('napm_execution_failed', {
        gatewayRequest: this.buildGatewayRequestSummary(gatewayRequest),
        error: response.error
      }, requestContext);
      logger.info('========================================\n');
      return response;
    }
  }

  assertMetadataInventoryArgumentContract(objectType = '', argument = '', provider = {}) {
    const normalizedArgument = String(argument || '').trim();
    if (!normalizedArgument) {
      return;
    }

    if (!this.isAllInventorySentinel(normalizedArgument)) {
      return;
    }

    const error = new Error('Metadata inventory list-all queries must omit group.argument; argument:"all" is not a valid object keyword.');
    error.code = 'INVALID_METADATA_INVENTORY_ARGUMENT';
    error.details = {
      service: 'groups',
      queryModeKey: 'metadata',
      objectType: objectType || null,
      argument: normalizedArgument,
      providerType: provider?.providerType || null,
      apiType: provider?.apiType || null,
      expectedShape: {
        service: 'groups',
        queryModeKey: 'metadata',
        groups: [{ type: objectType || provider?.effectiveObjectType || null }]
      }
    };
    throw error;
  }

  isAllInventorySentinel(value = '') {
    return /^(all|\*|__all__)$/i.test(String(value || '').trim());
  }

  /**
   * 执行完整网关请求主链。
   * 先跑准备阶段，再尝试直接执行，必要时启用库存兜底或 service 级回退。
   */
  async executeGatewayRequest(gatewayRequest, requestContext = null) {
    const prepared = await this.prepareGatewayExecution(gatewayRequest, requestContext);
    if (prepared?.inventoryFallback) {
      return prepared.inventoryFallback;
    }

    const directResult = await this.executeDirectGatewayRequest(prepared?.query || gatewayRequest, requestContext);
    if (this.isMultilevelGroupsInventoryQuery(prepared?.query || gatewayRequest) && directResult?.ok) {
      return {
        ...directResult,
        ok: false,
        error: {
          code: 'MULTILEVEL_GROUPS_INVENTORY_NOT_EXECUTABLE',
          message: `The multilevel path ${this.formatGroupPathWithArguments((prepared?.query || gatewayRequest)?.groups || [])} exists structurally, but upstream could not return a stable child-object inventory for it.`
        }
      };
    }
    if (directResult?.ok) {
      return directResult;
    }

    if (prepared?.serviceFallbackQuery) {
      const fallbackResult = await this.executeDirectGatewayRequest(prepared.serviceFallbackQuery, requestContext);
      if (fallbackResult?.ok) {
        const warning = this.buildMultiLevelServiceCompatibilityWarning(
          prepared?.query || gatewayRequest,
          prepared.serviceFallbackQuery
        );
        return {
          ...fallbackResult,
          warnings: [warning]
        };
      }
    }

    return directResult;
  }

  // 仅在 WebApplication 单对象明细查询被 averageValues 拒绝时启用 topValues 行过滤回退。
  shouldUseTopValuesDetailFallback(gatewayRequest, error) {
    return Boolean(
      gatewayRequest?.service === 'averageValues' &&
      Array.isArray(gatewayRequest?.groups) &&
      gatewayRequest.groups.length === 1 &&
      gatewayRequest.groups[0]?.type === 'WebApplication' &&
      gatewayRequest.groups[0]?.argument &&
      /status code 400/i.test(String(error?.message || ''))
    );
  }

  /**
   * 用 topValues 拉大样本后在本地做目标对象过滤，兼容部分上游不支持的单对象明细场景。
   */
  async executeTopValuesDetailFallback(gatewayRequest, requestContext = null) {
    const [targetGroup] = gatewayRequest.groups || [];
    const params = {
      type: 'topValues',
      start: gatewayRequest.start,
      end: gatewayRequest.end,
      json: 'true',
      topMetric: gatewayRequest.topMetric || gatewayRequest.metric,
      metrics: Array.isArray(gatewayRequest.metrics) ? gatewayRequest.metrics.join(',') : gatewayRequest.metric,
      topCount: 500,
      groupType1: targetGroup.type,
      numGroups: 1
    };

    const fullParams = {
      UserName: this.napmClient.username,
      Password: this.napmClient.password,
      ...params
    };

    const requestUrl = buildSafeUrl(this.napmClient.baseUrl, fullParams);

    logAudit('napm_execution_fallback_built', {
      strategy: 'top_values_detail_filter',
      gatewayRequest: this.buildGatewayRequestSummary(gatewayRequest),
      params: maskSensitiveParams(fullParams),
      url: requestUrl
    }, requestContext);

    const rawPayload = await this.napmClient.get(params);
    const data = this.parseNapmPayload(rawPayload);
    const matchedRows = data.filter(row => this.matchTopValuesFallbackRow(row, targetGroup.argument));

    return {
      data: matchedRows,
      requestUrl,
      requestParams: { ...params },
      requestParamsMasked: maskSensitiveParams(fullParams)
    };
  }

  matchTopValuesFallbackRow(row, targetArgument) {
    const normalizedTarget = this.normalizeFallbackValue(targetArgument);
    return Object.values(row || {}).some(value => this.normalizeFallbackValue(value) === normalizedTarget);
  }

  normalizeFallbackValue(value) {
    return String(value || '').trim().toLowerCase();
  }

  /**
   * 解析 NAPM 返回载荷。
   * 支持数组 JSON、对象 JSON、以及 CSV 字符串三种常见格式。
   *
   * @param {any} rawPayload - 上游原始响应
   * @returns {array} - 标准化后的数据行数组
   */
  parseNapmPayload(rawPayload) {
    if (Array.isArray(rawPayload)) {
      return rawPayload;
    }

    if (rawPayload && typeof rawPayload === 'object') {
      return [rawPayload];
    }

    if (typeof rawPayload === 'string') {
      const trimmed = rawPayload.trim();
      if (!trimmed) {
        return [];
      }

      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed;
        }
        if (parsed && typeof parsed === 'object') {
          return [parsed];
        }
      } catch (error) {
        return CsvParser.parseSync(trimmed);
      }
    }

    return [];
  }

  buildUrl(params) {
    return buildSafeUrl(this.napmClient.baseUrl, {
      UserName: this.napmClient.username,
      Password: this.napmClient.password,
      ...params
    });
  }

  /**
   * 构造轻量意图结果对象，供外部记录“用户在问什么”而不是“最终怎么执行”。
   *
   * @param {object} partialQuery - 当前阶段的部分查询对象
   * @param {string} userRequirement - 用户原始需求文本
   * @returns {object} - 意图摘要结果
   */
  buildIntentResult(partialQuery, userRequirement = '') {
    const query = partialQuery && typeof partialQuery === 'object' ? partialQuery : {};
    const text = String(userRequirement || '').trim();
    const service = String(query?.service || '').trim() || null;
    const groups = Array.isArray(query?.groups) ? query.groups : [];
    const groupPath = groups.map((item) => String(item?.type || '').trim()).filter(Boolean);
    const metric = String(query?.metric || query?.metrics?.[0] || '').trim() || null;
    const candidateGeneration = query?.candidateGeneration || null;
    const intentScore = Number(candidateGeneration?.intentCandidates?.[0]?.score || 0);
    const confidence = Number(Math.min(Math.max(intentScore, 0.45), 0.99).toFixed(2));

    const userIntent = (() => {
      if (service === 'topValues') return 'topn';
      if (service === 'timeValues') return 'timeseries';
      if (service === 'averageValues') return 'average';
      if (service === 'metrics' || service === 'groups') return 'metadata';
      return 'query';
    })();

    const questionType = (() => {
      const metricCode = String(metric || '').toUpperCase();
      if (service === 'overview') return 'overview';
      if (/(慢|延迟|时延|响应时间)/.test(text) || ['TRTI', 'RTTI', 'PGTME', 'PGTMS'].includes(metricCode)) return 'slow';
      if (/(错|失败|异常|5xx|4xx)/i.test(text) || metricCode.startsWith('PGHTTP')) return 'error';
      if (/(丢包|loss|drop)/i.test(text) || ['PLI', 'PLO', 'PLIAVG', 'PLOAVG'].includes(metricCode)) return 'loss';
      if (service === 'topValues' || /(最高|最大|top|排行|前\d+)/i.test(text)) return 'topn';
      if (service === 'timeValues' || /(趋势|变化|走势|波动|最近)/.test(text)) return 'trend';
      return 'query';
    })();

    return {
      objectType: 'IntentResult',
      userIntent,
      questionType,
      service,
      scopeHint: groupPath.join('>') || null,
      preferOverviewFirst: service === 'overview' || query?.queryModeKey === 'overview',
      stableTemplateId: query?.stableTemplate?.id || null,
      candidateGeneration,
      metricDomainCandidates: candidateGeneration?.metricDomainCandidates || [],
      confidence
    };
  }

  /**
   * 构造语义解析结果摘要，便于外部理解对象、指标、时间和路径是如何被收敛的。
   */
  buildSemanticResolutionResult(partialQuery) {
    const query = partialQuery && typeof partialQuery === 'object' ? partialQuery : {};
    const groups = Array.isArray(query?.groups) ? query.groups : [];
    const primaryGroup = groups[0] || null;

    return {
      objectType: 'SemanticResolutionResult',
      object: primaryGroup
        ? {
          type: primaryGroup.type || null,
          value: primaryGroup.argument || null
        }
        : null,
      groupPath: groups.map((item) => item?.type).filter(Boolean),
      metric: query?.metric || query?.metrics?.[0] || null,
      metrics: Array.isArray(query?.metrics) ? query.metrics.slice() : [],
      metricDomain: query?.metricSemantic?.metricDomain || query?.metricDomain || null,
      timeRange: {
        start: query?.start || null,
        end: query?.end || null
      },
      baseline: {
        type: 'time_window',
        timeRangeKey: query?.timeRangeKey || null,
        start: query?.start || null,
        end: query?.end || null,
        compareTo: query?.diagnoseBaselineKey
          || query?.compareBaselineKey
          || query?.executionBinding?.compareBaselineKey
          || query?.executionBinding?.diagnoseBaselineKey
          || null
      },
      metricSemantic: query?.metricSemantic || null,
      objectSemantic: query?.objectSemantic || null,
      pathPlanning: query?.pathPlanning || null,
      stableTemplateId: query?.stableTemplate?.id || null,
      confidence: Number(
        Math.min(
          Math.max(
            Number(query?.pathPlanning?.confidence || query?.candidateSpec?.confidence || 0.35),
            0.35
          ),
          0.99
        ).toFixed(2)
      ),
      needsClarification: Boolean(
        query?.executionGuard?.blockExecution
        || query?.clarificationGate?.required
      )
    };
  }

  // 以下是请求归一化与静态路径规划相关逻辑，负责把不同来源的 query shape 收口成统一结构。
  normalizeTopLevelGroupType(groupType = '') {
    const raw = String(groupType || '').trim();
    if (!raw) {
      return raw;
    }
    const mapped = this.groupBuilder && typeof this.groupBuilder.parseGroupType === 'function'
      ? this.groupBuilder.parseGroupType(raw)
      : null;
    if (mapped) {
      return mapped;
    }
    if (raw === 'Application') {
      return 'DefinedApp';
    }
    return raw;
  }

  normalizeTopLevelGroupPath(pathTypes = []) {
    if (!Array.isArray(pathTypes) || pathTypes.length === 0) {
      return Array.isArray(pathTypes) ? pathTypes : [];
    }
    const normalized = pathTypes.slice();
    normalized[0] = this.normalizeTopLevelGroupType(normalized[0]);
    return normalized;
  }

  normalizeTopLevelGroups(groups = []) {
    if (!Array.isArray(groups) || groups.length === 0) {
      return Array.isArray(groups) ? groups : [];
    }
    const normalized = groups.map((item) => ({ ...(item || {}) }));
    normalized.forEach((item) => {
      item.type = this.normalizeTopLevelGroupType(item.type);
    });
    return normalized;
  }

  /**
   * 统一规范执行态 query 的对象类型、候选提示、模板定义和路径规划输入。
   */
  normalizeTopLevelQueryShape(gatewayRequest) {
    if (!gatewayRequest || typeof gatewayRequest !== 'object') {
      return gatewayRequest;
    }

    const userRequirement = String(
      gatewayRequest?.userRequirement
      || gatewayRequest?.rawRequirement
      || ''
    ).trim();
    const request = JSON.parse(JSON.stringify(gatewayRequest));

    if (Array.isArray(request.groups)) {
      request.groups = this.normalizeTopLevelGroups(request.groups);
    }

    if (Array.isArray(request.contextGroups)) {
      request.contextGroups = this.normalizeTopLevelGroups(request.contextGroups);
    }

    if (request.objectType) {
      request.objectType = this.normalizeTopLevelGroupType(request.objectType);
    }

    if (request.executionBinding && typeof request.executionBinding === 'object') {
      if (request.executionBinding.rankingTargetType) {
        request.executionBinding.rankingTargetType = this.normalizeTopLevelGroupType(
          request.executionBinding.rankingTargetType
        );
      }
      if (request.executionBinding.groupType) {
        request.executionBinding.groupType = this.normalizeTopLevelGroupType(
          request.executionBinding.groupType
        );
      }
    }

    if (request.resolutionHints?.group?.type) {
      request.resolutionHints.group.type = this.normalizeTopLevelGroupType(request.resolutionHints.group.type);
    }

    if (request.semanticConstraints && typeof request.semanticConstraints === 'object') {
      if (request.semanticConstraints.targetObjectType) {
        request.semanticConstraints.targetObjectType = this.normalizeTopLevelGroupType(
          request.semanticConstraints.targetObjectType
        );
      }
      if (request.semanticConstraints.anchorObject?.type) {
        request.semanticConstraints.anchorObject.type = this.normalizeTopLevelGroupType(
          request.semanticConstraints.anchorObject.type
        );
      }
    }

    if (request.candidateSpec?.target_hint) {
      request.candidateSpec.target_hint = this.normalizeTopLevelGroupType(request.candidateSpec.target_hint);
    }

    if (request.candidateSpec?.hints?.group_type_hint) {
      request.candidateSpec.hints.group_type_hint = this.normalizeTopLevelGroupType(
        request.candidateSpec.hints.group_type_hint
      );
    }

    if (request.candidateSpec?.semantic_constraints) {
      if (request.candidateSpec.semantic_constraints.targetObjectType) {
        request.candidateSpec.semantic_constraints.targetObjectType = this.normalizeTopLevelGroupType(
          request.candidateSpec.semantic_constraints.targetObjectType
        );
      }
      if (request.candidateSpec.semantic_constraints.anchorObject?.type) {
        request.candidateSpec.semantic_constraints.anchorObject.type = this.normalizeTopLevelGroupType(
          request.candidateSpec.semantic_constraints.anchorObject.type
        );
      }
    }

    if (Array.isArray(request.pathPlanning?.plannedGroups)) {
      request.pathPlanning.plannedGroups = this.normalizeTopLevelGroups(request.pathPlanning.plannedGroups);
    }

    if (Array.isArray(request.pathResolve?.selected_groups)) {
      request.pathResolve.selected_groups = this.normalizeTopLevelGroups(request.pathResolve.selected_groups);
    }

    if (request.pathResolve?.target_group) {
      request.pathResolve.target_group = this.normalizeTopLevelGroupType(request.pathResolve.target_group);
    }

    if (request.pathResolve?.initial_target_group) {
      request.pathResolve.initial_target_group = this.normalizeTopLevelGroupType(request.pathResolve.initial_target_group);
    }

    if (request.stableTemplate && typeof request.stableTemplate === 'object') {
      const normalizedStableTemplate = this.normalizeStableTemplateDefinition(request.stableTemplate);
      request.stableTemplate = normalizedStableTemplate || {
        ...request.stableTemplate,
        inferredArguments: this.normalizeStableTemplateInferredArguments(request.stableTemplate.inferredArguments)
      };
    }

    return this.applyStaticGroupPathPlanning(request, userRequirement);
  }

  /**
   * 在真正执行前应用一次静态 group path 规划，把隐式路径补成可执行的显式路径。
   */
  applyStaticGroupPathPlanning(gatewayRequest, userRequirement = '') {
    if (!gatewayRequest || typeof gatewayRequest !== 'object') {
      return gatewayRequest;
    }

    const request = JSON.parse(JSON.stringify(gatewayRequest));
    if (request.skipPathPlanning === true || request.executionHints?.skipPathPlanning === true) {
      return request;
    }

    if (!this.shouldAllowPathRepair(request)) {
      return request;
    }

    const pathPlan = this.groupPathPlannerService.planPath(request, userRequirement, {
      groups: request.groups
    });
    if (!pathPlan?.plannedGroups?.length) {
      return request;
    }

    request.groups = pathPlan.plannedGroups;
    request.pathPlanning = {
      ...(request.pathPlanning && typeof request.pathPlanning === 'object' ? request.pathPlanning : {}),
      ...pathPlan
    };

    const targetType = pathPlan.plannedGroups[pathPlan.plannedGroups.length - 1]?.type || null;
    if (targetType) {
      request.semanticConstraints = {
        ...(request.semanticConstraints && typeof request.semanticConstraints === 'object'
          ? request.semanticConstraints
          : {}),
        targetObjectType: targetType
      };
    }

    return request;
  }

  /**
   * 在稳定模板集合中匹配最合适的模板。
   * 评分会综合 service、对象路径、关键字、协议词和指标提示。
   */
  matchStableQueryTemplate(gatewayRequest, userRequirement) {
    if (this.areGatewayTemplatesDisabled()) {
      return null;
    }

    const request = gatewayRequest || {};
    const text = String(userRequirement || '');
    const lower = text.toLowerCase();
    const groups = Array.isArray(request.groups) ? request.groups : [];
    const rootType = this.normalizeTopLevelGroupType(groups[0]?.type || null);
    const groupPath = this.normalizeTopLevelGroupPath(
      groups.map(item => item?.type).filter(Boolean)
    ).join('>');
    const requestedMetric = this.extractMetricHintFromQueryShape(request);
    const matchedCandidates = [];

    for (const [index, template] of this.stableQueryTemplates.entries()) {
      const match = template?.match || {};
      const hasMatchCriteria = Boolean(
        (Array.isArray(match.services) && match.services.length > 0)
        || (Array.isArray(match.rootTypes) && match.rootTypes.length > 0)
        || (Array.isArray(match.groupPaths) && match.groupPaths.length > 0)
        || (Array.isArray(match.includeAll) && match.includeAll.length > 0)
        || (Array.isArray(match.includeAny) && match.includeAny.length > 0)
        || (Array.isArray(match.includeTargetAny) && match.includeTargetAny.length > 0)
        || (Array.isArray(match.includeProtocolAny) && match.includeProtocolAny.length > 0)
        || (Array.isArray(match.excludeAny) && match.excludeAny.length > 0)
      );
      if (!hasMatchCriteria) {
        continue;
      }

      if (Array.isArray(match.services) && match.services.length > 0) {
        if (!match.services.includes(request.service)) {
          continue;
        }
      }

      if (Array.isArray(match.rootTypes) && match.rootTypes.length > 0) {
        const matchRootTypes = match.rootTypes.map((item) => this.normalizeTopLevelGroupType(item));
        if (!rootType || !matchRootTypes.includes(rootType)) {
          continue;
        }
      }

      if (Array.isArray(match.groupPaths) && match.groupPaths.length > 0) {
        const matchGroupPaths = match.groupPaths.map((pathText) => {
          const tokens = String(pathText || '')
            .split('>')
            .map((token) => String(token || '').trim())
            .filter(Boolean);
          return this.normalizeTopLevelGroupPath(tokens).join('>');
        });
        if (!matchGroupPaths.includes(groupPath)) {
          continue;
        }
      }

      if (!this.matchesKeywordRule(text, lower, match.includeAll, 'all')) {
        continue;
      }

      if (!this.matchesKeywordRule(text, lower, match.includeAny, 'any')) {
        continue;
      }

      if (!this.matchesKeywordRule(text, lower, match.includeTargetAny, 'any')) {
        continue;
      }

      if (!this.matchesProtocolRule(text, lower, match.includeProtocolAny, 'any')) {
        continue;
      }

      if (this.matchesKeywordRule(text, lower, match.excludeAny, 'any', false)) {
        continue;
      }

      const templateMetric = this.extractMetricHintFromTemplate(template);
      let score = 0;
      if (requestedMetric && templateMetric) {
        score += requestedMetric === templateMetric ? 100 : -30;
      }
      score += this.countKeywordMatches(text, lower, match.includeAll) * 4;
      score += this.countKeywordMatches(text, lower, match.includeAny) * 3;
      score += this.countKeywordMatches(text, lower, match.includeTargetAny) * 2;
      score += this.countProtocolMatches(text, lower, match.includeProtocolAny) * 2;

      matchedCandidates.push({
        template,
        score,
        index
      });
    }

    if (matchedCandidates.length === 0) {
      return null;
    }

    matchedCandidates.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    });
    return matchedCandidates[0].template;
  }

  matchesKeywordRule(text, lower, keywords = [], mode = 'any', emptyResult = true) {
    const items = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
    if (items.length === 0) {
      return emptyResult;
    }

    const checker = (keyword) => {
      const raw = String(keyword);
      return text.includes(raw) || lower.includes(raw.toLowerCase());
    };

    return mode === 'all'
      ? items.every(checker)
      : items.some(checker);
  }

  matchesProtocolRule(text, lower, protocols = [], mode = 'any', emptyResult = true) {
    const items = Array.isArray(protocols) ? protocols.filter(Boolean) : [];
    if (items.length === 0) {
      return emptyResult;
    }

    const escaped = items.map(item => String(item).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const checker = (pattern) => {
      const regex = new RegExp(`(^|[^A-Za-z])${pattern}([^A-Za-z]|$)`, 'i');
      return regex.test(text) || regex.test(lower);
    };

    return mode === 'all'
      ? escaped.every(checker)
      : escaped.some(checker);
  }

  countKeywordMatches(text, lower, keywords = []) {
    const items = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
    if (items.length === 0) {
      return 0;
    }

    return items.reduce((count, keyword) => {
      const raw = String(keyword || '');
      if (!raw) {
        return count;
      }
      return (text.includes(raw) || lower.includes(raw.toLowerCase())) ? count + 1 : count;
    }, 0);
  }

  countProtocolMatches(text, lower, protocols = []) {
    const items = Array.isArray(protocols) ? protocols.filter(Boolean) : [];
    if (items.length === 0) {
      return 0;
    }

    return items.reduce((count, protocol) => {
      const escaped = String(protocol || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!escaped) {
        return count;
      }
      const regex = new RegExp(`(^|[^A-Za-z])${escaped}([^A-Za-z]|$)`, 'i');
      return (regex.test(text) || regex.test(lower)) ? count + 1 : count;
    }, 0);
  }

  extractMetricHintFromQueryShape(request = {}) {
    const metric = String(
      request?.metric
      || (Array.isArray(request?.metrics) && request.metrics.length > 0 ? request.metrics[0] : '')
      || ''
    ).trim();
    return metric || null;
  }

  extractMetricHintFromTemplate(template = {}) {
    const bindings = template?.bindings || {};
    const metric = String(
      bindings?.metric
      || (Array.isArray(bindings?.metrics) && bindings.metrics.length > 0 ? bindings.metrics[0] : '')
      || ''
    ).trim();
    return metric || null;
  }

  /**
   * 把稳定模板中的绑定信息应用到当前请求。
   * 模板可以补 service、metric、groupPath、topCount 和默认时间范围。
   */
  applyStableTemplateBindings(request, template, userRequirement = '') {
    if (this.areGatewayTemplatesDisabled()) {
      return;
    }

    if (!this.shouldAllowStableTemplateRepair(request)) {
      return;
    }

    const bindings = template?.bindings || {};
    const preferMappedQuery = bindings.preferMappedQuery !== false;
    const mappedMetric = this.extractMetricHintFromQueryShape(request);
    const templateMetric = this.extractMetricHintFromTemplate(template);
    const shouldPreserveMappedMetric = Boolean(
      preferMappedQuery
      && mappedMetric
      && templateMetric
      && mappedMetric !== templateMetric
    );
    const explicitDynamicRange = TimeUtils.normalizeDynamicTimeRange(userRequirement);
    const normalizedGroupPath = this.normalizeTopLevelGroupPath(bindings.groupPath);
    if (Array.isArray(normalizedGroupPath) && normalizedGroupPath.length > 0) {
      request.groups = this.buildGroupsFromStableTemplate(
        normalizedGroupPath,
        request.groups,
        request.contextGroups,
        userRequirement
      );
    }

    if (bindings.service) {
      request.service = bindings.service;
    }

    if (bindings.metric && !shouldPreserveMappedMetric) {
      request.metric = bindings.metric;
    }

    if (!shouldPreserveMappedMetric && Array.isArray(bindings.metrics) && bindings.metrics.length > 0) {
      request.metrics = bindings.metrics.slice();
      request.metric = request.metric || request.metrics[0];
    } else if (!shouldPreserveMappedMetric && bindings.metric) {
      request.metrics = [bindings.metric];
    }

    if (shouldPreserveMappedMetric) {
      request.metric = mappedMetric;
      request.metrics = Array.isArray(request.metrics) && request.metrics.length > 0
        ? request.metrics.slice()
        : [mappedMetric];
    }

    if (Number.isFinite(bindings.topCount)) {
      request.topCount = bindings.topCount;
    }

    if (
      request.service === 'topValues'
      && this.isSingularTopResultQuestion(userRequirement)
      && !this.hasExplicitRequestedTopCount(userRequirement, 2)
    ) {
      request.topCount = 1;
    }

    if (Number.isFinite(bindings.granularity)) {
      request.granularity = bindings.granularity;
    }

    if (bindings.timeRangeKey && !(explicitDynamicRange?.start && explicitDynamicRange?.end)) {
      const range = TimeUtils.parseTimeRange(bindings.timeRangeKey);
      request.start = range.start;
      request.end = range.end;
    }
  }

  // 按模板路径生成 groups，并尽量从现有对象、上下文和文本中补齐 argument。
  buildGroupsFromStableTemplate(groupPath = [], existingGroups = [], contextGroups = [], userRequirement = '') {
    const sources = [
      ...(Array.isArray(existingGroups) ? existingGroups : []),
      ...(Array.isArray(contextGroups) ? contextGroups : [])
    ];
    const argumentByType = new Map();
    const inferredArguments = this.extractStableTemplateArguments(userRequirement);

    sources.forEach((group) => {
      if (group?.type && group?.argument && !argumentByType.has(group.type)) {
        argumentByType.set(group.type, group.argument);
      }
    });

    Object.entries(inferredArguments).forEach(([type, argument]) => {
      if (type && argument && !argumentByType.has(type)) {
        argumentByType.set(type, argument);
      }
    });

    return groupPath.map((type) => {
      const item = { type };
      if (argumentByType.has(type)) {
        item.argument = argumentByType.get(type);
      } else if (type === 'DefinedApp' && argumentByType.has('Application')) {
        item.argument = argumentByType.get('Application');
      }
      return item;
    });
  }

  /**
   * 从用户文本中提取可直接绑定到稳定模板的参数，例如协议名、引用名和 /24 网段。
   */
  extractStableTemplateArguments(userRequirement = '') {
    const text = String(userRequirement || '');
    const quoted = Array.from(
      text.matchAll(/["'`“”‘’「」『』](.+?)["'`“”‘’「」『』]/g)
    )
      .map(item => String(item[1] || '').trim())
      .filter(Boolean);

    const firstQuoted = quoted[0] || null;
    const protocolAliases = [
      { pattern: /(^|[^A-Za-z])(https)([^A-Za-z]|$)/i, value: 'HTTPS' },
      { pattern: /(^|[^A-Za-z])(http)([^A-Za-z]|$)/i, value: 'HTTP' },
      { pattern: /(^|[^A-Za-z])(ssh)([^A-Za-z]|$)/i, value: 'SSH' },
      { pattern: /(^|[^A-Za-z])(dns)([^A-Za-z]|$)/i, value: 'DNS' },
      { pattern: /(^|[^A-Za-z])(icmp)([^A-Za-z]|$)/i, value: 'ICMP' },
      { pattern: /(^|[^A-Za-z])(tcp)([^A-Za-z]|$)/i, value: 'TCP' },
      { pattern: /(^|[^A-Za-z])(udp)([^A-Za-z]|$)/i, value: 'UDP' }
    ];

    const inferred = {};
    const applicationProtocol = protocolAliases.find(item => item.pattern.test(text))?.value || null;
    if (applicationProtocol) {
      inferred.DefinedApp = applicationProtocol;
      inferred.Application = applicationProtocol;
    }

    const lower = text.toLowerCase();
    if (firstQuoted) {
      if (/(web\s*application|web应用|网站|站点)/i.test(text)) {
        inferred.WebApplication = inferred.WebApplication || firstQuoted;
      } else if (/(businessgroup|business group|业务组|业务分组|工作组)/i.test(text)) {
        inferred.BusinessGroup = inferred.BusinessGroup || firstQuoted;
      } else if (/(page\s*family|pagefamily|页面族|页面组)/i.test(text)) {
        inferred.PageFamily = inferred.PageFamily || firstQuoted;
      }
    }

    if (!inferred.Prefix24) {
      const prefixMatch = text.match(/((?:\d{1,3}\.){2}\d{1,3})(?:\.(\d{1,3}))?(?:\/24)?/);
      if (prefixMatch) {
        const octets = String(prefixMatch[1]).split('.');
        if (octets.length === 3) {
          inferred.Prefix24 = `${octets.join('.')}.0/24`;
        }
      }
    }

    if (!inferred.DefinedApp && /(^|[^A-Za-z])(http|https|ssh|dns|icmp|tcp|udp)([^A-Za-z]|$)/i.test(lower)) {
      inferred.DefinedApp = RegExp.$2.toUpperCase();
      inferred.Application = inferred.Application || inferred.DefinedApp;
    }

    return inferred;
  }

  /**
   * 当用户明确表达“双向/进出都看”时，把单指标扩展为入向 + 出向指标对。
   */
  expandMetricsForBidirectionalHint(gatewayRequest, userRequirement) {
    if (!gatewayRequest || !userRequirement) {
      return gatewayRequest;
    }

    const hasInbound = /(流入|入站|上行|inbound)/i.test(userRequirement);
    const hasOutbound = /(流出|出站|下行|outbound)/i.test(userRequirement);
    const hasBothHint = /(都看|双向|流入流出|进出都看|双向都看)/.test(userRequirement) || (hasInbound && hasOutbound);

    if (!hasBothHint) {
      return gatewayRequest;
    }

    const deriveBidirectionalPair = (metricCode = '') => {
      const code = String(metricCode || '').trim().toUpperCase();
      if (!code) {
        return null;
      }

      let inbound = '';
      let outbound = '';

      if (code.endsWith('IO')) {
        const prefix = code.slice(0, -2);
        inbound = `${prefix}I`;
        outbound = `${prefix}O`;
      } else if (code.endsWith('I')) {
        const prefix = code.slice(0, -1);
        inbound = code;
        outbound = `${prefix}O`;
      } else if (code.endsWith('O')) {
        const prefix = code.slice(0, -1);
        inbound = `${prefix}I`;
        outbound = code;
      } else {
        return null;
      }

      if (!inbound || !outbound || inbound === outbound) {
        return null;
      }
      if (!this.metricMappingService.isValidMetricCode(inbound) || !this.metricMappingService.isValidMetricCode(outbound)) {
        return null;
      }
      return [inbound, outbound];
    };

    const currentMetric = String(gatewayRequest.metric || gatewayRequest.metrics?.[0] || '').trim().toUpperCase();
    const expandedMetrics = deriveBidirectionalPair(currentMetric);
    if (!expandedMetrics) {
      return gatewayRequest;
    }

    return {
      ...gatewayRequest,
      metric: expandedMetrics[0],
      metrics: expandedMetrics
    };
  }

  // 以下逻辑用于把 requestContext 中的对象提示注入语义候选，帮助收敛最终目标对象类型。
  resolveContextObjectTypeHint(requestContext = null) {
    if (!requestContext || typeof requestContext !== 'object') {
      return '';
    }

    const decision = requestContext.decision || {};
    const intent = requestContext.intent || {};
    const seedHints = requestContext.semanticSeedHints || {};

    const candidates = [
      seedHints.targetObjectType,
      seedHints.recognizedSubjectHint,
      seedHints.recognizedGoalHint,
      seedHints.intentSubjectHint,
      seedHints.intentScopeType,
      requestContext.targetObjectType,
      decision.recognized_subject_hint,
      decision.recognized_goal_hint,
      intent.subject_hint,
      intent.goal,
      intent?.constraints?.object_scope_type
    ]
      .map((item) => String(item || '').trim())
      .filter(Boolean);

    const normalizeAlias = (value) => {
      const lowered = value.toLowerCase();
      if (lowered === 'application') {
        return 'DefinedApp';
      }
      if (lowered === 'ipconversation' || lowered === 'ip_conversation' || lowered.includes('session')) {
        return 'IPConversation';
      }
      if (lowered === 'ipaddress' || lowered === 'ip_address') {
        return 'IPAddress';
      }
      if (lowered === 'businessgroup' || lowered === 'business_group') {
        return 'BusinessGroup';
      }
      if (lowered === 'webapplication' || lowered === 'web_application') {
        return 'WebApplication';
      }
      if (lowered === 'clientips' || lowered === 'client_ips') {
        return 'ClientIPs';
      }
      if (lowered === 'serverips' || lowered === 'server_ips') {
        return 'ServerIPs';
      }
      return value;
    };

    for (const candidate of candidates) {
      const normalized = this.normalizeTopLevelGroupType(normalizeAlias(candidate));
      if (normalized) {
        return normalized;
      }
    }
    return '';
  }

  injectContextObjectCandidate(candidates = [], targetObjectType = '', source = 'request_context') {
    const target = this.normalizeTopLevelGroupType(targetObjectType);
    const list = Array.isArray(candidates) ? candidates.map((item) => ({ ...(item || {}) })) : [];
    if (!target) {
      return list;
    }

    const index = list.findIndex((item) => (
      this.normalizeTopLevelGroupType(item?.type || item?.objectType || '') === target
    ));

    if (index >= 0) {
      list[index] = {
        ...list[index],
        type: target,
        objectType: target,
        score: Math.max(Number(list[index].score || 0), 0.99),
        reason: [String(list[index].reason || '').trim(), `context_seed:${source}`]
          .filter(Boolean)
          .join('; '),
        source: list[index].source || 'context_seed'
      };
    } else {
      list.unshift({
        type: target,
        objectType: target,
        score: 0.99,
        reason: `context_seed:${source}`,
        source: 'context_seed'
      });
    }

    return list
      .map((item) => ({
        ...item,
        score: Number(item?.score || 0)
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * 将请求上下文中的对象语义种子写回 mappingResult，提升对象判定稳定性。
   */
  applyRequestContextSemanticSeed(mappingResult = null, requestContext = null) {
    if (!mappingResult || typeof mappingResult !== 'object') {
      return mappingResult;
    }

    const targetObjectType = this.resolveContextObjectTypeHint(requestContext);
    if (!targetObjectType) {
      return mappingResult;
    }

    const next = JSON.parse(JSON.stringify(mappingResult));
    next.objectCandidates = this.injectContextObjectCandidate(
      Array.isArray(next.objectCandidates) ? next.objectCandidates : [],
      targetObjectType,
      'request_context'
    );

    if (next.candidateGeneration && typeof next.candidateGeneration === 'object') {
      next.candidateGeneration.objectCandidates = this.injectContextObjectCandidate(
        Array.isArray(next.candidateGeneration.objectCandidates) ? next.candidateGeneration.objectCandidates : [],
        targetObjectType,
        'request_context'
      );
    }

    if (next.resolvedQuery && typeof next.resolvedQuery === 'object') {
      next.resolvedQuery.semanticConstraints = {
        ...(next.resolvedQuery.semanticConstraints && typeof next.resolvedQuery.semanticConstraints === 'object'
          ? next.resolvedQuery.semanticConstraints
          : {}),
        targetObjectType,
        objectCandidates: this.injectContextObjectCandidate(
          next.resolvedQuery?.semanticConstraints?.objectCandidates,
          targetObjectType,
          'request_context'
        )
      };

      if (next.resolvedQuery.candidateSpec && typeof next.resolvedQuery.candidateSpec === 'object') {
        next.resolvedQuery.candidateSpec.target_hint = targetObjectType;
        next.resolvedQuery.candidateSpec.semantic_constraints = {
          ...(next.resolvedQuery.candidateSpec.semantic_constraints || {}),
          targetObjectType,
          objectCandidates: this.injectContextObjectCandidate(
            next.resolvedQuery?.candidateSpec?.semantic_constraints?.objectCandidates,
            targetObjectType,
            'request_context'
          )
        };
        next.resolvedQuery.candidateSpec.candidate_inputs = {
          ...(next.resolvedQuery.candidateSpec.candidate_inputs || {}),
          object_candidates: this.injectContextObjectCandidate(
            next.resolvedQuery?.candidateSpec?.candidate_inputs?.object_candidates,
            targetObjectType,
            'request_context'
          )
        };
        next.resolvedQuery.candidateSpec.hints = {
          ...(next.resolvedQuery.candidateSpec.hints || {}),
          group_type_hint: targetObjectType
        };
      }

      if (next.resolvedQuery.resolutionHints?.group && typeof next.resolvedQuery.resolutionHints.group === 'object') {
        next.resolvedQuery.resolutionHints.group.type = targetObjectType;
        next.resolvedQuery.resolutionHints.group.source = next.resolvedQuery.resolutionHints.group.source || 'context_seed';
      }

      next.resolvedQuery = this.alignGroupsWithSemanticTarget(next.resolvedQuery);
    }

    if (next.candidateSpec && typeof next.candidateSpec === 'object') {
      next.candidateSpec.target_hint = targetObjectType;
      next.candidateSpec.semantic_constraints = {
        ...(next.candidateSpec.semantic_constraints || {}),
        targetObjectType,
        objectCandidates: this.injectContextObjectCandidate(
          next.candidateSpec?.semantic_constraints?.objectCandidates,
          targetObjectType,
          'request_context'
        )
      };
      next.candidateSpec.candidate_inputs = {
        ...(next.candidateSpec.candidate_inputs || {}),
        object_candidates: this.injectContextObjectCandidate(
          next.candidateSpec?.candidate_inputs?.object_candidates,
          targetObjectType,
          'request_context'
        )
      };
      next.candidateSpec.hints = {
        ...(next.candidateSpec.hints || {}),
        group_type_hint: targetObjectType
      };
    }

    return next;
  }

  collectSemanticObjectCandidates(query = {}) {
    const fromSemantic = Array.isArray(query?.semanticConstraints?.objectCandidates)
      ? query.semanticConstraints.objectCandidates
      : [];
    const fromCandidateSpec = Array.isArray(query?.candidateSpec?.semantic_constraints?.objectCandidates)
      ? query.candidateSpec.semantic_constraints.objectCandidates
      : [];
    const fromCandidateInputs = Array.isArray(query?.candidateSpec?.candidate_inputs?.object_candidates)
      ? query.candidateSpec.candidate_inputs.object_candidates
      : [];
    const fromResolutionHints = Array.isArray(query?.resolutionHints?.group?.candidates)
      ? query.resolutionHints.group.candidates
      : [];

    return [
      ...fromSemantic,
      ...fromCandidateSpec,
      ...fromCandidateInputs,
      ...fromResolutionHints
    ]
      .map((item) => ({
        type: this.normalizeTopLevelGroupType(item?.type || item?.objectType || ''),
        score: Number(item?.score || 0),
        reason: String(item?.reason || ''),
        source: String(item?.source || '')
      }))
      .filter((item) => item.type)
      .sort((a, b) => b.score - a.score);
  }

  shouldAlignWithSemanticTarget(query = {}, targetObjectType = '') {
    const target = this.normalizeTopLevelGroupType(targetObjectType);
    if (!target) {
      return false;
    }

    const objectCandidates = this.collectSemanticObjectCandidates(query);
    if (!Array.isArray(objectCandidates) || objectCandidates.length === 0) {
      return false;
    }

    const top = objectCandidates[0];
    if (!top?.type || top.type !== target) {
      return false;
    }

    return Boolean(
      top.score >= 0.9
      || /explicit_object/i.test(top.reason)
      || top.source === 'explicit_object_signal'
    );
  }

  /**
   * 当语义候选已经高度确定目标对象时，主动把 groups 末端类型对齐到该目标。
   */
  alignGroupsWithSemanticTarget(query = null) {
    if (!query || typeof query !== 'object') {
      return query;
    }

    const targetObjectType = this.normalizeTopLevelGroupType(
      query?.semanticConstraints?.targetObjectType
      || query?.candidateSpec?.semantic_constraints?.targetObjectType
      || ''
    );
    if (!targetObjectType) {
      return query;
    }

    if (!this.shouldAlignWithSemanticTarget(query, targetObjectType)) {
      return query;
    }

    const next = JSON.parse(JSON.stringify(query));
    const groups = Array.isArray(next.groups) ? next.groups.map((item) => ({ ...(item || {}) })) : [];
    if (groups.length === 0) {
      next.groups = [{ type: targetObjectType }];
    } else {
      const terminalIndex = groups.length - 1;
      const terminal = groups[terminalIndex] || {};
      const previousType = this.normalizeTopLevelGroupType(terminal.type || '');
      const alignedTerminal = {
        ...terminal,
        type: targetObjectType
      };
      if (previousType && previousType !== targetObjectType) {
        delete alignedTerminal.argument;
      }
      groups[terminalIndex] = alignedTerminal;
      next.groups = groups;
    }

    if (next.resolutionHints?.group && typeof next.resolutionHints.group === 'object') {
      next.resolutionHints.group.type = targetObjectType;
      next.resolutionHints.group.source = next.resolutionHints.group.source || 'semantic_target_alignment';
    }

    return next;
  }

  /**
   * 判断是否应该优先采用语义映射阶段产出的 resolvedQuery。
   * 只有在置信度、元数据可执行性和澄清状态都满足时才会放行。
   */
  shouldPreferMappedQuery(mappingResult) {
    const resolvedQuery = mappingResult?.resolvedQuery;
    if (!resolvedQuery || !resolvedQuery.service) {
      return false;
    }

    if (mappingResult?.clarificationGate?.required) {
      return false;
    }

    const groups = Array.isArray(resolvedQuery.groups) ? resolvedQuery.groups.filter(Boolean) : [];
    const hasMetric = Boolean(
      resolvedQuery.metric ||
      (Array.isArray(resolvedQuery.metrics) && resolvedQuery.metrics.length > 0)
    );
    const metadataIssues = [
      ...(mappingResult?.preResolutionMetadataReview?.issues || []),
      ...(mappingResult?.dynamicMetadataReview?.issues || [])
    ];
    const hasHardMetadataIssue = metadataIssues.some(issue => (
      String(issue).startsWith('group_not_found:') ||
      String(issue).startsWith('group_cannot_query:') ||
      String(issue).startsWith('metrics_for_group_empty:')
    ));
    const hasScopedResolvedPath = Boolean(
      resolvedQuery?.scopeProbe?.applied &&
      groups.length > 1
    );
    const hasStableTemplate = Boolean(resolvedQuery?.stableTemplate?.applied);
    const semanticOperation = String(
      resolvedQuery?.semanticConstraints?.operation
      || resolvedQuery?.candidateSpec?.semantic_constraints?.operation
      || ''
    ).trim();
    const isMetadataListQuery = (
      semanticOperation === 'metadata_list'
      || ['groups', 'metrics'].includes(String(resolvedQuery?.service || '').trim())
    );

    if (isMetadataListQuery) {
      const explicitGroupResolution = Boolean(
        resolvedQuery?.resolutionHints?.group?.explicit
        || resolvedQuery?.resolutionHints?.group?.source === 'metadata_list_hint'
      );
      return Boolean(
        groups.length >= 1 &&
        resolvedQuery.start &&
        resolvedQuery.end &&
        (mappingResult?.confidence >= 0.75 || explicitGroupResolution) &&
        !hasHardMetadataIssue &&
        !resolvedQuery.executionGuard?.blockExecution
      );
    }

    return Boolean(
      (mappingResult?.confidence >= 0.9 || hasScopedResolvedPath || hasStableTemplate) &&
      hasMetric &&
      groups.length >= 1 &&
      resolvedQuery.start &&
      resolvedQuery.end &&
      (groups.length === 1 || mappingResult?.pathPlan?.shouldApply || hasStableTemplate) &&
      !hasHardMetadataIssue &&
      !resolvedQuery.executionGuard?.blockExecution
    );
  }

  /**
   * 合并默认 gatewayRequest 与语义映射结果，得到更完整的执行态查询。
   */
  mergeWithMappedQuery(gatewayRequest, mappedQuery, userRequirement) {
    const request = gatewayRequest || {};
    const mapped = mappedQuery || {};
    const preferMappedGroups = Boolean(
      mapped?.scopeProbe?.applied &&
      Array.isArray(mapped.groups) &&
      mapped.groups.length > 0
    );
    const preferMappedMetadataGroups = Boolean(
      ['groups', 'metrics'].includes(request.service || mapped.service) &&
      (!Array.isArray(request.groups) || request.groups.length === 0) &&
      Array.isArray(mapped.groups) &&
      mapped.groups.length > 0
    );

    return {
      service: request.service || mapped.service,
      start: request.start || mapped.start,
      end: request.end || mapped.end,
      metric: request.metric || mapped.metric,
      metrics: Array.isArray(request.metrics) && request.metrics.length > 0
        ? request.metrics
        : (Array.isArray(mapped.metrics) ? mapped.metrics : []),
      groups: (preferMappedGroups || preferMappedMetadataGroups)
        ? mapped.groups
        : (Array.isArray(request.groups) && request.groups.length > 0
        ? request.groups
        : (Array.isArray(mapped.groups) ? mapped.groups : [])),
      topCount: request.topCount || mapped.topCount,
      granularity: request.granularity || mapped.granularity,
      metricFilter: request.metricFilter || mapped.metricFilter || null,
      topLevelOnly: typeof request.topLevelOnly === 'boolean' ? request.topLevelOnly : Boolean(mapped.topLevelOnly),
      format: request.format || mapped.format || 'json',
      userRequirement: request.userRequirement || mapped.userRequirement || userRequirement,
      contextGroups: Array.isArray(request.contextGroups) && request.contextGroups.length > 0
        ? request.contextGroups
        : (Array.isArray(mapped.contextGroups) ? mapped.contextGroups : []),
      semanticConstraints: request.semanticConstraints
        || mapped.semanticConstraints
        || mapped?.candidateSpec?.semantic_constraints
        || null,
      candidateSpec: request.candidateSpec || mapped.candidateSpec || null,
      candidateGeneration: request.candidateGeneration || mapped.candidateGeneration || null,
      queryModeKey: request.queryModeKey || mapped.queryModeKey || null,
      executionBinding: request.executionBinding || mapped.executionBinding || null,
      pathResolve: request.pathResolve || mapped.pathResolve || null,
      pathPlanning: request.pathPlanning || mapped.pathPlanning || null,
      stableTemplate: request.stableTemplate || mapped.stableTemplate || null,
      executionGuard: request.executionGuard || mapped.executionGuard || null,
      scopeProbe: request.scopeProbe || mapped.scopeProbe || null
    };
  }

  // 以下是 topN / 排名类问句的辅助解析逻辑。
  roundToNearestMinute(timestamp) {
    const adjustedTimestamp = Math.floor(timestamp / 60) * 60;
    logger.info('时间戳调整', `${timestamp} -> ${adjustedTimestamp}`);
    return adjustedTimestamp;
  }

  resolveExplicitRequestedTopCount(userRequirement, fallback = null) {
    const text = String(userRequirement || '');
    const digitMatch = text.match(/(?:前\s*|top\s*)(\d{1,4})(?:个|名|条)?/i);
    if (digitMatch) {
      const count = Number(digitMatch[1]);
      return Number.isFinite(count) && count > 0 ? count : fallback;
    }

    const chineseMatch = text.match(/(?:前\s*|top\s*)([零一二两三四五六七八九十百千]{1,6})(?:个|名|条)?/i);
    if (chineseMatch) {
      const count = this.parseChineseCount(chineseMatch[1]);
      if (Number.isFinite(count) && count > 0) {
        return count;
      }
    }

    const bareCountMatch = text.match(/(?:(\d{1,3})\s*(?:个|名|条)|([零一二两三四五六七八九十百千]{1,6})\s*(?:个|名|条)?)/i);
    if (bareCountMatch) {
      const digitCount = Number(bareCountMatch[1]);
      if (Number.isFinite(digitCount) && digitCount > 0) {
        return digitCount;
      }
      const chineseCount = this.parseChineseCount(bareCountMatch[2]);
      if (Number.isFinite(chineseCount) && chineseCount > 0) {
        return chineseCount;
      }
    }

    return fallback;
  }

  hasExplicitRequestedTopCount(userRequirement, minimum = 2) {
    const explicitTopCount = Number(this.resolveExplicitRequestedTopCount(userRequirement, null));
    return Number.isFinite(explicitTopCount) && explicitTopCount >= minimum;
  }

  resolveRequestedTopCount(userRequirement, fallback = 10) {
    const text = String(userRequirement || '');
    const explicitTopCount = this.resolveExplicitRequestedTopCount(text, null);
    if (Number.isFinite(explicitTopCount) && explicitTopCount > 0) {
      return explicitTopCount;
    }

    if (this.isSingularTopResultQuestion(text)) {
      return 1;
    }

    return Number(fallback || 10);
  }

  isSingularTopResultQuestion(text = '') {
    const raw = String(text || '').trim();
    if (!raw) {
      return false;
    }

    if (this.hasExplicitRequestedTopCount(raw, 2) || /(?:top\s*[2-9]\d*|前\s*[2-9]\d*)/i.test(raw)) {
      return false;
    }

    if (/(?:哪些|哪几个|哪几条|哪几台|哪类)/.test(raw)) {
      return false;
    }

    const hasSingularTarget = /(?:谁|哪个|哪一个|哪台|哪条|是哪一个|是哪台|是哪条)/.test(raw);
    const hasWinnerSignal = /(?:最大|最高|最多|最慢|最快|最活跃|第一|第1|highest|largest|most)/i.test(raw);
    return hasSingularTarget && hasWinnerSignal;
  }

  parseChineseCount(rawCount) {
    const text = String(rawCount || '').trim();
    if (!text) {
      return null;
    }

    if (/^\d+$/.test(text)) {
      return Number(text);
    }

    const digitMap = {
      零: 0,
      一: 1,
      二: 2,
      两: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9
    };
    const unitMap = {
      十: 10,
      百: 100,
      千: 1000
    };

    if (Object.prototype.hasOwnProperty.call(digitMap, text)) {
      return digitMap[text];
    }

    let total = 0;
    let current = 0;

    for (const char of text) {
      if (Object.prototype.hasOwnProperty.call(digitMap, char)) {
        current = digitMap[char];
        continue;
      }

      const unit = unitMap[char];
      if (!unit) {
        return null;
      }

      total += (current || 1) * unit;
      current = 0;
    }

    return total + current;
  }

  // 过滤非法指标，至少保证后续执行链路中始终存在一个可用 metric。
  validateMetrics(metrics) {
    const validMetrics = [];
    
    metrics.forEach(code => {
      logger.info(`验证指标代码: ${code}`, {
        isValid: this.metricMappingService.isValidMetricCode(code)
      });
      
      if (this.metricMappingService.isValidMetricCode(code)) {
        validMetrics.push(code);
      }
    });

    if (validMetrics.length === 0) {
      logger.warn('没有有效指标，使用默认指标 TPIO');
      return ['TPIO'];
    }

    logger.info('验证后的 metrics:', validMetrics.join(','));
    return validMetrics;
  }

  validateMetric(metric, metrics) {
    if (!this.metricMappingService.isValidMetricCode(metric) || !metrics.includes(metric)) {
      if (metrics.length > 0) {
        const newMetric = metrics[0];
        logger.info('topMetric 无效，使用 metrics 中的第一个指标:', newMetric);
        return newMetric;
      }
    }
    return metric;
  }

  hasExplicitRankingMetricInText(text = '') {
    const raw = String(text || '').trim();
    if (!raw) {
      return false;
    }

    // 尊重用户显式给出的“按某个指标排序/排行”意图，避免被默认指标覆盖。
    if (/(排序指标|排行指标|top\s*metric|topmetric)/i.test(raw)) {
      return true;
    }

    const hasSortVerb = /(排序|排行|排名|top|前\d+)/i.test(raw);
    const hasByPrefix = /(按|按照|依据|基于|以)/.test(raw);
    const hasMetricWord = /(吞吐|流量|带宽|丢包|丢包率|时延|rtt|重传|tpio|tpi|tpo|bytio|byti|byto|pli|plo|rtti|trti)/i.test(raw);

    if (hasSortVerb && hasMetricWord) {
      return true;
    }

    if (hasByPrefix && hasMetricWord) {
      return true;
    }

    return false;
  }

  // 以下保留的是历史 assistant-state 场景下的模板化 topN 构造能力，当前作为兼容回退链路。

  /**
   * 读取内嵌的 topN 模板兜底定义，适用于配置缺失时的常见排行问题。
   */
  buildEmbeddedTopnTemplate(templateId = '') {
    const key = String(templateId || '').trim();
    if (!key) {
      return null;
    }

    const embedded = {
      'ip-retransmission-topn-v1': { description: 'IPAddress retransmission ranking fallback', metric: 'RTXI', metrics: ['RTXI'], groupPath: ['IPAddress'] },
      'ip-retransmission-delay-topn-v1': { description: 'IPAddress retransmission delay ranking fallback', metric: 'RDTO', metrics: ['RDTO'], groupPath: ['IPAddress'] },
      'ip-connection-setup-topn-v1': { description: 'IPAddress connection setup ranking fallback', metric: 'CSTI', metrics: ['CSTI'], groupPath: ['IPAddress'] },
      'ip-connection-failure-rate-topn-v1': { description: 'IPAddress connection failure rate ranking fallback', metric: 'RFRI', metrics: ['RFRI'], groupPath: ['IPAddress'] },
      'ip-connection-failures-topn-v1': { description: 'IPAddress connection failure count ranking fallback', metric: 'RFCI', metrics: ['RFCI'], groupPath: ['IPAddress'] },
      'ip-connection-requests-topn-v1': { description: 'IPAddress connection request ranking fallback', metric: 'CONI', metrics: ['CONI'], groupPath: ['IPAddress'] },
      'ipconversation-retransmission-topn-v1': { description: 'IPConversation retransmission ranking fallback', metric: 'RTXI', metrics: ['RTXI'], groupPath: ['IPConversation'] },
      'ipconversation-retransmission-delay-topn-v1': { description: 'IPConversation retransmission delay ranking fallback', metric: 'RDTO', metrics: ['RDTO'], groupPath: ['IPConversation'] },
      'ipconversation-connection-setup-topn-v1': { description: 'IPConversation connection setup ranking fallback', metric: 'CSTI', metrics: ['CSTI'], groupPath: ['IPConversation'] },
      'ipconversation-connection-failure-rate-topn-v1': { description: 'IPConversation connection failure rate ranking fallback', metric: 'RFRI', metrics: ['RFRI'], groupPath: ['IPConversation'] },
      'ipconversation-connection-failures-topn-v1': { description: 'IPConversation connection failure count ranking fallback', metric: 'RFCI', metrics: ['RFCI'], groupPath: ['IPConversation'] },
      'ipconversation-connection-requests-topn-v1': { description: 'IPConversation connection request ranking fallback', metric: 'CONI', metrics: ['CONI'], groupPath: ['IPConversation'] },
      'prefix24-retransmission-topn-v1': { description: 'Prefix24 retransmission ranking fallback', metric: 'RTXI', metrics: ['RTXI'], groupPath: ['Prefix24'] },
      'prefix24-retransmission-delay-topn-v1': { description: 'Prefix24 retransmission delay ranking fallback', metric: 'RDTO', metrics: ['RDTO'], groupPath: ['Prefix24'] },
      'businessgroup-connection-setup-topn-v1': { description: 'BusinessGroup connection setup ranking fallback', metric: 'CSTI', metrics: ['CSTI'], groupPath: ['BusinessGroup'] },
      'businessgroup-connection-failure-rate-topn-v1': { description: 'BusinessGroup connection failure rate ranking fallback', metric: 'RFRI', metrics: ['RFRI'], groupPath: ['BusinessGroup'] },
      'businessgroup-connection-failures-topn-v1': { description: 'BusinessGroup connection failure count ranking fallback', metric: 'RFCI', metrics: ['RFCI'], groupPath: ['BusinessGroup'] },
      'businessgroup-connection-requests-topn-v1': { description: 'BusinessGroup connection request ranking fallback', metric: 'CONI', metrics: ['CONI'], groupPath: ['BusinessGroup'] },
      'webapp-http-500-count-topn-v1': { description: 'WebApplication HTTP 500 count ranking fallback', metric: 'PGHTTP500', metrics: ['PGHTTP500'], groupPath: ['WebApplication'] },
      'webapp-http-500-ratio-topn-v1': { description: 'WebApplication HTTP 500 ratio ranking fallback', metric: 'PGHTTP500PCT', metrics: ['PGHTTP500PCT'], groupPath: ['WebApplication'] },
      'webapp-http-400-count-topn-v1': { description: 'WebApplication HTTP 400 count ranking fallback', metric: 'PGHTTP400', metrics: ['PGHTTP400'], groupPath: ['WebApplication'] },
      'webapp-http-400-ratio-topn-v1': { description: 'WebApplication HTTP 400 ratio ranking fallback', metric: 'PGHTTP400PCT', metrics: ['PGHTTP400PCT'], groupPath: ['WebApplication'] },
      'businessgroup-http-500-count-topn-v1': { description: 'BusinessGroup HTTP 500 count ranking fallback', metric: 'PGHTTP500', metrics: ['PGHTTP500'], groupPath: ['BusinessGroup'] },
      'businessgroup-http-500-ratio-topn-v1': { description: 'BusinessGroup HTTP 500 ratio ranking fallback', metric: 'PGHTTP500PCT', metrics: ['PGHTTP500PCT'], groupPath: ['BusinessGroup'] },
      'businessgroup-http-400-count-topn-v1': { description: 'BusinessGroup HTTP 400 count ranking fallback', metric: 'PGHTTP400', metrics: ['PGHTTP400'], groupPath: ['BusinessGroup'] },
      'businessgroup-http-400-ratio-topn-v1': { description: 'BusinessGroup HTTP 400 ratio ranking fallback', metric: 'PGHTTP400PCT', metrics: ['PGHTTP400PCT'], groupPath: ['BusinessGroup'] }
    };

    const item = embedded[key];
    if (!item) {
      return null;
    }

    if (!isMetricCompatibleWithGroupPath(item.groupPath, item.metric, item.groupPath[0])) {
      logger.warn('Skip embedded topn template due to metric ownership incompatibility', {
        templateId: key,
        metric: item.metric,
        groupPath: item.groupPath
      });
      return null;
    }

    return this.normalizeStableTemplateDefinition({
      id: key,
      description: item.description,
      intent: 'topn',
      bindings: {
        service: 'topValues',
        metric: item.metric,
        metrics: item.metrics.slice(),
        topCount: 5,
        timeRangeKey: 'last1hour',
        groupPath: item.groupPath.slice(),
        mustBind: true,
        allowedGroupPaths: [item.groupPath.slice()],
        fallbackMode: 'clarify_or_overview',
        preferMappedQuery: true
      }
    });
  }

  // 生成一份最保守的默认查询，供缺少足够语义信息时兜底使用。
  getDefaultGatewayRequest(userRequirement) {
    const start = this.roundToNearestMinute(TimeUtils.getYesterdayStart());
    const end = this.roundToNearestMinute(TimeUtils.getYesterdayEnd());
    return {
      service: 'topValues',
      start: start,
      end: end,
      metric: 'TPIO',
      metrics: ['TPIO'],
      groups: [{ type: 'IPAddress' }],
      topCount: 10,
      granularity: null,
      format: 'json',
      userRequirement: userRequirement
    };
  }

  /**
   * 根据 rankingTargetType 和 topMetricHint 动态生成一个临时 topN 模板。
   */
  buildDynamicTopnTemplate(templateId = '', rankingTargetType = '', topMetricHint = '') {
    const id = String(templateId || '').trim();
    const groupType = String(rankingTargetType || '').trim();
    const metric = String(topMetricHint || '').trim();
    if (!id || !groupType || !metric) {
      return null;
    }

    return this.normalizeStableTemplateDefinition({
      id,
      description: `${groupType} ${metric} ranking generated fallback`,
      intent: 'topn',
      bindings: {
        service: 'topValues',
        metric,
        metrics: [metric],
        topCount: 5,
        timeRangeKey: 'last1hour',
        groupPath: [groupType],
        mustBind: true,
        allowedGroupPaths: [[groupType]],
        fallbackMode: 'clarify_or_overview',
        preferMappedQuery: true
      }
    });
  }

  /**
   * 基于 assistant state 构造 topN 查询。
   * 优先复用稳定模板，其次回退到内嵌模板或动态生成模板。
   */
  buildTopnQueryFromAssistantState(partialQuery = {}, userRequirement = '') {
    if (this.areGatewayTemplatesDisabled()) {
      return null;
    }

    const templateId = String(partialQuery?.stableTemplateId || '').trim();
    const rankingTargetType = String(partialQuery?.rankingTargetType || partialQuery?.groupType || '').trim();
    const topMetricHint = String(partialQuery?.topMetricHint || '').trim();
    if (!templateId || !rankingTargetType || !topMetricHint) {
      return null;
    }

    const template = this.stableQueryTemplates.find((item) => item?.id === templateId)
      || this.buildEmbeddedTopnTemplate(templateId)
      || this.buildDynamicTopnTemplate(templateId, rankingTargetType, topMetricHint)
      || null;
    if (!template) {
      return null;
    }

    const normalizedTemplate = this.normalizeStableTemplateDefinition(template);
    if (!normalizedTemplate) {
      return null;
    }

    const bindings = normalizedTemplate.bindings || {};
    const requestedTopCount = Number(partialQuery?.topCount);
    let topCount = Number.isFinite(requestedTopCount) && requestedTopCount > 0
      ? requestedTopCount
      : (Number.isFinite(Number(bindings.topCount)) && Number(bindings.topCount) > 0 ? Number(bindings.topCount) : 5);
    if (this.isSingularTopResultQuestion(userRequirement || '')) {
      topCount = 1;
    }

    const dynamicTimeRange = partialQuery?.dynamicTimeRange || null;
    const timeRangeKey = String(partialQuery?.timeRangeKey || bindings.timeRangeKey || (dynamicTimeRange ? '' : 'last1hour')).trim() || '';
    const range = TimeUtils.parseTimeRange(dynamicTimeRange || timeRangeKey || 'last1hour');
    const metric = topMetricHint || bindings.metric || (Array.isArray(bindings.metrics) ? bindings.metrics[0] : null);
    const metrics = Array.isArray(bindings.metrics) && bindings.metrics.length > 0
      ? bindings.metrics.slice()
      : (metric ? [metric] : []);
    const groupPath = Array.isArray(bindings.groupPath) && bindings.groupPath.length > 0
      ? bindings.groupPath.slice()
      : [rankingTargetType];
    const groups = groupPath.map((type) => ({ type }));

    return {
      service: 'topValues',
      start: this.roundToNearestMinute(range.start),
      end: this.roundToNearestMinute(range.end),
      metric,
      metrics,
      groups,
      topCount,
      format: 'json',
      userRequirement,
      stableTemplate: {
        id: normalizedTemplate.id,
        description: normalizedTemplate.description || null,
        intent: normalizedTemplate.intent || 'topn',
        applied: true,
        bindings: {
          service: 'topValues',
          metric,
          metrics: metrics.slice(),
          groupPath: groupPath.slice(),
          topCount,
          timeRangeKey: timeRangeKey || null,
          dynamicTimeRange
        }
      },
      executionBinding: {
        action: 'topn',
        rankingTargetType,
        topMetricHint: metric,
        topCount,
        timeRangeKey: timeRangeKey || null,
        dynamicTimeRange,
        stableTemplateId: normalizedTemplate.id,
        rankingTitleKey: partialQuery?.rankingTitleKey || null
      },
      intentResult: this.buildIntentResult(partialQuery, userRequirement),
      semanticResolutionResult: this.buildSemanticResolutionResult(partialQuery)
    };
  }
}

module.exports = new RequirementParserService();

