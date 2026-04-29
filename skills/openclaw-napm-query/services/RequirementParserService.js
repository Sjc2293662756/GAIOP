/**
 * RequirementParserService.js
 * 
 * 网关执行层主解析器
 * 
 * 负责将 assistant/skill 已经执行的问题，进一步转换为可执行的 gatewayRequest：
 * - 自然语言映射
 * - 对象 / 指标 / service mode / 时间解析
 * - 参数精细化与对齐
 * - 最终发出 NAPM 请求并返回 requestUrl
 * 
 * 修改日期：2026-04-16
 */
const fs = require('fs');
const path = require('path');

const MetricMappingService = require('./MetricMappingService');
const NapmClient = require('./NapmClient');
const GroupBuilder = require('./GroupBuilder');
const QueryValidator = require('./QueryValidator');
const NaturalLanguageQueryMapper = require('./NaturalLanguageQueryMapper');
const QueryMetadataConstraintService = require('./QueryMetadataConstraintService');
const NapmMetadataService = require('./NapmMetadataService');
const ArgumentResolutionService = require('./ArgumentResolutionService');
const ObjectTypeDisambiguationService = require('./ObjectTypeDisambiguationService');
const ServiceModeDisambiguationService = require('./ServiceModeDisambiguationService');
const MetricSemanticDisambiguationService = require('./MetricSemanticDisambiguationService');
const TimeSemanticEnhancementService = require('./TimeSemanticEnhancementService');
const ClarificationGateService = require('./ClarificationGateService');
const PathResolveService = require('./PathResolveService');
const MetricResolveService = require('./MetricResolveService');
const TimeResolveService = require('./TimeResolveService');
const ScopeContextPreservationService = require('./ScopeContextPreservationService');
// const ScopedDescentProbeService = require('./ScopedDescentProbeService');
const MetricDomainStrategyService = require('./MetricDomainStrategyService');
const ResolvedSpecBuilder = require('./ResolvedSpecBuilder');
const CsvParser = require('../../../src/utils/CsvParser');
const TimeUtils = require('../../../src/utils/TimeUtils');
const logger = require('../../../src/utils/logger');
const { logAudit, buildSafeUrl, maskSensitiveParams, buildOrderedParams } = require('../../../src/utils/auditLogger');

/**
 * RequirementParserService 类
 * 网关执行层主服务，负责将用户需求解析为可执行的网关请求
 */
class RequirementParserService {
  /**
   * 构造函数
   * 
   * 初始化所有依赖服务，加载稳定查询模板配置
   */
  constructor() {
    this.metricMappingService = MetricMappingService;
    this.napmClient = new NapmClient();
    this.groupBuilder = GroupBuilder;
    this.queryValidator = QueryValidator;
    this.naturalLanguageQueryMapper = NaturalLanguageQueryMapper;
    this.queryMetadataConstraintService = QueryMetadataConstraintService;
    this.napmMetadataService = NapmMetadataService;
    this.argumentResolutionService = ArgumentResolutionService;
    this.objectTypeDisambiguationService = ObjectTypeDisambiguationService;
    this.serviceModeDisambiguationService = ServiceModeDisambiguationService;
    this.metricSemanticDisambiguationService = MetricSemanticDisambiguationService;
    this.timeSemanticEnhancementService = TimeSemanticEnhancementService;
    this.clarificationGateService = ClarificationGateService;
    this.pathResolveService = PathResolveService;
    this.metricResolveService = MetricResolveService;
    this.timeResolveService = TimeResolveService;
    this.scopeContextPreservationService = ScopeContextPreservationService;
    // 链路收拢后，实探测服务暂不纳入主流程。
    // this.scopedDescentProbeService = ScopedDescentProbeService;
    this.metricDomainStrategyService = MetricDomainStrategyService;
    this.gatewayTemplatesDisabled = this.resolveGatewayTemplateDisableFlag();
    this.stableQueryTemplates = this.loadStableQueryTemplates();
  }

  /**
   * 解析网关模板禁用标志
   * 
   * @returns {boolean} - 是否禁用网关模板
   */
  resolveGatewayTemplateDisableFlag() {
    const raw = String(
      process.env.DISABLE_GATEWAY_TEMPLATES
      || process.env.NAPM_DISABLE_GATEWAY_TEMPLATES
      || ''
    ).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(raw);
  }

  /**
   * 判断网关模板是否被禁用
   * 
   * @returns {boolean} - 是否禁用网关模板
   */
  areGatewayTemplatesDisabled() {
    return Boolean(this.gatewayTemplatesDisabled);
  }

  /**
   * 加载稳定查询模板配置
   * 
   * @returns {array} - 稳定查询模板数组
   */
  loadStableQueryTemplates() {
    if (this.areGatewayTemplatesDisabled()) {
      logger.warn('Gateway stable templates are disabled by environment flag.');
      return [];
    }

    try {
      const configPath = path.join(__dirname, '../../../config/stable-query-templates.v1.json');
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.enabled === false) {
        logger.warn('Gateway stable templates are disabled by config switch.');
        return [];
      }
      return Array.isArray(parsed?.templates) ? parsed.templates : [];
    } catch (error) {
      logger.warn('Failed to load stable query templates:', error.message);
      return [];
    }
  }

  /**
   * 构建映射审计快照
   * 
   * 将解析结果转换为审计日志所需的快照格式
   * 
   * @param {object} mappingResult - 映射结果对象
   * @returns {object|null} - 审计快照对象
   */
  buildMappingAuditSnapshot(mappingResult) {
    if (!mappingResult) {
      return null;
    }

    return {
      resolvedQuery: mappingResult.resolvedQuery,
      evidence: mappingResult.evidence,
      serviceModeDisambiguation: mappingResult.serviceModeDisambiguation,
      timeSemanticEnhancement: mappingResult.timeSemanticEnhancement,
      timeResolve: mappingResult.timeResolve || null,
      metricDisambiguation: mappingResult.metricDisambiguation,
      metricResolve: mappingResult.metricResolve || null,
      objectDisambiguation: mappingResult.objectDisambiguation,
      entityResolve: mappingResult.entityResolve || null,
      scopeContextPreservation: mappingResult.scopeContextPreservation,
      metadataReview: mappingResult.metadataReview,
      pathPlan: mappingResult.pathPlan,
      pathResolve: mappingResult.pathResolve || null,
      argumentResolution: mappingResult.argumentResolution,
      candidateGeneration: mappingResult.candidateGeneration || null,
      candidateSpec: mappingResult.candidateSpec || null,
      resolvedSpec: mappingResult.resolvedSpec || null,
      clarificationGate: mappingResult.clarificationGate || null,
      dynamicMetadataReview: mappingResult.dynamicMetadataReview,
      dynamicConstraint: mappingResult.dynamicConstraint,
      executionScopeGuard: mappingResult.executionScopeGuard,
      scopedDescentProbe: mappingResult.scopedDescentProbe,
      semanticNormalization: mappingResult.semanticNormalization || null
    };
  }

  /**
   * 鏋勫缓缃戝叧璇锋眰鎽樿
   * 
   * 灏嗙綉鍏宠姹傝浆鎹负瀹¤鏃ュ織鎵€闇€鐨勬憳瑕佹牸寮?   * 
   * @param {object} gatewayRequest - 缃戝叧璇锋眰瀵硅薄
   * @returns {object|null} - 璇锋眰鎽樿瀵硅薄
   */
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

  /**
   * 应用规范化语义种子
   * 
   * 将规范化后的语义信息应用到网关请求中
   * 
   * @param {object} gatewayRequest - 网关请求对象
   * @param {object} normalizedSemantic - 规范化语义对象
   * @returns {object} - 更新后的网关请求
   */
  applyNormalizedSemanticSeed(gatewayRequest, normalizedSemantic = null) {
    if (!gatewayRequest || !normalizedSemantic || typeof normalizedSemantic !== 'object') {
      return gatewayRequest;
    }

    const next = JSON.parse(JSON.stringify(gatewayRequest));
    next.semanticNormalization = normalizedSemantic;

    const intent = String(normalizedSemantic.intent || '').trim();
    const focus = String(normalizedSemantic.focus || '').trim();
    const objectType = String(normalizedSemantic.objectType || '').trim();
    const service = String(normalizedSemantic.service || '').trim();

    if (!next.service) {
      if (intent === 'topn' || service === 'topn') {
        next.service = 'topValues';
      } else if (intent === 'compare' || service === 'compare' || intent === 'diagnose' || service === 'diagnose' || intent === 'overview' || service === 'overview') {
        next.service = 'averageValues';
      }
    }

    if (!next.metric) {
      const focusMetricMap = {
        traffic: 'TPIO',
        network_performance: 'RTTI',
        response_time: 'TRTI',
        user_experience: 'PGTME',
        'failure/connection': 'CSTI'
      };
      const mappedMetric = focusMetricMap[focus] || null;
      if (mappedMetric) {
        next.metric = mappedMetric;
        next.metrics = Array.isArray(next.metrics) && next.metrics.length > 0 ? next.metrics : [mappedMetric];
      }
    }

    if ((!Array.isArray(next.groups) || next.groups.length === 0) && objectType && objectType !== 'unknown') {
      next.groups = [{
        type: objectType,
        argument: null
      }];
    }

    if (intent === 'topn' && !next.topCount) {
      next.topCount = 10;
    }

    if (intent === 'overview' && !next.topCount && next.service === 'averageValues') {
      next.topCount = 20;
    }

    return next;
  }

  /**
   * 构建执行数据摘要
   * 
   * @param {array} data - 执行结果数据
   * @returns {object} - 数据摘要对象
   */
  buildExecutionDataSummary(data) {
    const rows = Array.isArray(data) ? data : [];
    return {
      rowCount: rows.length,
      sampleRows: rows.slice(0, 3)
    };
  }

  /**
   * 构建参数元数据守卫
   * 
   * 检查实体解析结果中的元数据验证状态，如果存在严重不匹配则构建执行守卫
   * 
   * @param {object} resolvedQuery - 解析后的查询对象
   * @param {object} entityResolve - 实体解析结果
   * @returns {object|null} - 更新后的查询或null
   */
  buildArgumentMetadataGuard(resolvedQuery, entityResolve) {
    const query = resolvedQuery ? JSON.parse(JSON.stringify(resolvedQuery)) : resolvedQuery;
    const selectedEntity = entityResolve?.selected_entity || null;
    if (!query || !selectedEntity?.type || !selectedEntity?.value) {
      return null;
    }

    if (!entityResolve?.metadata_validation?.hard_mismatch) {
      return null;
    }

    const suggestedCandidates = Array.isArray(entityResolve?.clarification?.suggested_candidates)
      ? entityResolve.clarification.suggested_candidates
      : [];

    query.executionGuard = {
      blockExecution: true,
      code: 'GROUP_ARGUMENT_NOT_FOUND',
      message: `NAPM metadata does not contain a valid ${selectedEntity.type} argument named "${selectedEntity.value}".`,
      details: {
        groupType: selectedEntity.type,
        argument: selectedEntity.value,
        suggestedCandidates
      }
    };

    return query;
  }

  /**
   * 计算候选相似度分数
   * 
   * @param {string} source - 源字符串
   * @param {string} candidate - 候选字符串
   * @returns {number} - 相似度分数(0-1)
   */
  scoreCandidateSimilarity(source, candidate) {
    const left = this.normalizeLooseComparable(source);
    const right = this.normalizeLooseComparable(candidate);
    if (!left || !right) {
      return 0;
    }
    if (left === right) {
      return 1;
    }

    let overlap = 0;
    const leftSet = Array.from(new Set(left.split('')));
    for (const char of leftSet) {
      if (right.includes(char)) {
        overlap += 1;
      }
    }

    let longestCommonSubstring = 0;
    for (let start = 0; start < left.length; start += 1) {
      for (let end = start + 1; end <= left.length; end += 1) {
        const fragment = left.slice(start, end);
        if (fragment.length > longestCommonSubstring && right.includes(fragment)) {
          longestCommonSubstring = fragment.length;
        }
      }
    }

    const overlapScore = overlap / Math.max(leftSet.length, 1);
    const substringScore = longestCommonSubstring / Math.max(left.length, right.length, 1);
    return Number((overlapScore * 0.45 + substringScore * 0.55).toFixed(2));
  }

  /**
   * 规范化宽松可比较值
   * 
   * @param {string} value - 待规范化的值
   * @returns {string} - 规范化后的值
   */
  normalizeLooseComparable(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[`"'“”‘’]/g, '')
      .replace(/\s+/g, '')
      .replace(/[()（）:：_-]/g, '');
  }

  /**
   * 构建上游路径守卫
   * 
   * 检测上游服务的路径格式并构建相应的错误信息
   * 
   * @param {object} gatewayRequest - 网关请求对象
   * @param {Error} error - 错误对象
   * @returns {object|null} - 上游守卫错误信息或null
   */
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

    const path = this.formatGroupPathWithArguments(groups);
    const service = String(gatewayRequest?.service || 'unknown');
    const metric = gatewayRequest?.metric || (Array.isArray(gatewayRequest?.metrics) ? gatewayRequest.metrics[0] : null);
    const candidatePaths = this.collectMetadataPathCandidates(gatewayRequest, path);

    return {
      code: 'UPSTREAM_GROUP_PATH_NOT_SUPPORTED',
      message: `NAPM upstream rejected the path ${path} for ${service} queries.`,
      details: {
        service,
        metric,
        groups,
        path,
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

  get BASE_SYSTEM_PROMPT() {
    return `# 角色
你是NetInside API专家，精通网络流量分析以及网络安全分析（入侵、时长等），将自然语言转换为网关可以理解的JSON格式。
# 任务
将用户需求精准转化为网关请求JSON，严格遵守以下规则：

## 1. 服务类型(service)映射规则
- "平均值"、"平均..." -> averageValues
- "时间序列"、"随时间变化"、"历史数据" -> timeValues
- "Top"、"排名前"、"最大的"、"最高的" -> topValues
- "列表"、"有哪些"、"所有" -> 对应资源类型(如groups,metrics)

## 2. 核心参数映射规则
### 2.1 分组参数
分组类型映射：
- "IP地址"、"主机" -> IPAddress
- "业务组" -> BusinessGroup
- "Web应用"、"网站" -> WebApplication
- "客户端IP" -> ClientIPs
- "总流量" -> TotalTraffic
- "网段" -> Prefix24
- "IP会话" -> IPConversation

### 2.2 指标(metrics)映射
**重要：所有指标代码必须从 api构建规则.md 文件的 3.2 指标(metrics)映射部分选取**
- 指标参数：只能使用规则文件中定义的指标代码
### 2.3 特殊参数
- "前N个"、"Top X" -> topCount=X
- "每X周期"、"X秒粒度" -> granularity=X

## 3. 时间范围
- 今天：自动计算时间戳
- 其他时间：根据用户需求计算
- 必须为分钟的整数倍
## 4. 输出要求
1. 只输出包含JSON格式，无任何其他内容
2. 格式按照示例格式输出
3. 确保所有参数值正确无误
4. 不要添加任何注释或说明文字
5. 确保metrics使用的指标代码都来自规则文件

# 输出格式
{
  "service": "averageValues",
  "start": 1753113600,
  "end": 1753200000,
  "metrics": ["TPIO"],
  "groups": [
    {
      "type": "IPAddress",
      "argument": "101.254.114.240"
    }
  ],
  "topCount": 20,
  "granularity": null,
  "format": "json"
}

# 示例
## 示例1
用户输入："查询IP地址101.254.114.240在今天的平均吞吐量"
输出：{
  "service": "averageValues",
  "start": 1753113600,
  "end": 1753200000,
  "metrics": ["TPIO"],
  "groups": [
    {
      "type": "IPAddress",
      "argument": "101.254.114.240"
    }
  ],
  "topCount": 20,
  "granularity": null,
  "format": "json"
}

## 示例2
用户输入："获取今天吞吐量最高的20个IP地址"
输出：{
  "service": "topValues",
  "start": 1753113600,
  "end": 1753200000,
  "metric": "TPIO",
  "groups": [
    {
      "type": "IPAddress"
    }
  ],
  "topCount": 20,
  "granularity": null,
  "format": "json"
}`;
  }

  buildSystemPrompt(mappingResult) {
    const mappedQuery = mappingResult?.resolvedQuery || null;
    const evidence = mappingResult?.evidence || {};
    const metadataReview = mappingResult?.metadataReview || null;
    const objectDisambiguation = mappingResult?.objectDisambiguation || null;
    const pathPlan = mappingResult?.pathPlan || null;
    const argumentResolution = mappingResult?.argumentResolution || null;
    const dynamicMetadataReview = mappingResult?.dynamicMetadataReview || null;

    return `${this.BASE_SYSTEM_PROMPT}

## 预解析提示- 以下内容是本地规则引擎对用户问题做出的预解析结果，优先参考，但仍需输出格式合法的最终JSON
- 如果您判断预解析中的某个字段不准确，可以更正，但不要忽略已经明确识别出的 service、时间范围、指标、对象、路径和数量信息

### 预解析查询对象
${JSON.stringify(mappedQuery, null, 2)}

### 预解析证据
${JSON.stringify(evidence, null, 2)}

### 元数据审查结果
${JSON.stringify(metadataReview, null, 2)}

### group path 规划结果
${JSON.stringify(pathPlan, null, 2)}

### 参数解析结果
${JSON.stringify(argumentResolution, null, 2)}

### 动态元数据审查
${JSON.stringify(dynamicMetadataReview, null, 2)}`;
  }

  buildSystemPromptV2(mappingResult) {
    const mappedQuery = mappingResult?.resolvedQuery || null;
    const evidence = mappingResult?.evidence || {};
    const serviceModeDisambiguation = mappingResult?.serviceModeDisambiguation || null;
    const timeSemanticEnhancement = mappingResult?.timeSemanticEnhancement || null;
    const metricDisambiguation = mappingResult?.metricDisambiguation || null;
    const metadataReview = mappingResult?.metadataReview || null;
    const objectDisambiguation = mappingResult?.objectDisambiguation || null;
    const scopeContextPreservation = mappingResult?.scopeContextPreservation || null;
    const pathPlan = mappingResult?.pathPlan || null;
    const argumentResolution = mappingResult?.argumentResolution || null;
    const dynamicMetadataReview = mappingResult?.dynamicMetadataReview || null;

    return `${this.BASE_SYSTEM_PROMPT}

## Pre-analysis guidance
- The following content is the pre-analysis result produced by the local rule engine. Prefer it when forming the final legal JSON.
- You may correct inaccurate fields, but do not ignore clearly recognized service, time range, metric, object, path, or argument evidence.

### Resolved query
${JSON.stringify(mappedQuery, null, 2)}

### Evidence
${JSON.stringify(evidence, null, 2)}

### Service mode disambiguation
${JSON.stringify(serviceModeDisambiguation, null, 2)}

### Time semantic enhancement
${JSON.stringify(timeSemanticEnhancement, null, 2)}

### Metric disambiguation
${JSON.stringify(metricDisambiguation, null, 2)}

### Object disambiguation
${JSON.stringify(objectDisambiguation, null, 2)}

### Scope context preservation
${JSON.stringify(scopeContextPreservation, null, 2)}

### Metadata constraint
${JSON.stringify(metadataReview, null, 2)}

### Group path planning
${JSON.stringify(pathPlan, null, 2)}

### Argument resolution
${JSON.stringify(argumentResolution, null, 2)}

### Dynamic metadata review
${JSON.stringify(dynamicMetadataReview, null, 2)}`;
  }

  /**
   * 映射自然语言到查询
   * 
   * @param {string} userRequirement - 用户需求文本
   * @returns {object} - 映射结果对象
   */
  mapNaturalLanguage(userRequirement, requestContext = null) {
    const mappingResult = this.applyRequestContextSemanticSeed(
      this.naturalLanguageQueryMapper.map(userRequirement),
      requestContext
    );
    const metadataReview = this.queryMetadataConstraintService.constrain(
      mappingResult.resolvedQuery,
      userRequirement
    );

    return {
      ...mappingResult,
      resolvedQuery: metadataReview.query,
      metadataReview
    };
  }

  /**
   * 使用消歧服务映射自然语言
   * 
   * 依次调用服务模式消歧、时间语义增强、指标消歧、对象类型消歧等服务
   * 
   * @param {string} userRequirement - 用户需求文本
   * @returns {object} - 映射结果对象
   */
  async mapNaturalLanguageWithDisambiguation(userRequirement, requestContext = null) {
    const mappingResult = this.applyRequestContextSemanticSeed(
      this.naturalLanguageQueryMapper.map(userRequirement),
      requestContext
    );
    const serviceModeDisambiguation = await this.serviceModeDisambiguationService.disambiguate(
      mappingResult.resolvedQuery,
      userRequirement
    );
    const timeSemanticEnhancement = await this.timeSemanticEnhancementService.enhance(
      serviceModeDisambiguation.query,
      userRequirement
    );
    const metricDisambiguation = await this.metricSemanticDisambiguationService.disambiguate(
      timeSemanticEnhancement.query,
      userRequirement
    );
    const objectDisambiguation = await this.objectTypeDisambiguationService.disambiguate(
      metricDisambiguation.query,
      userRequirement
    );
    const scopeContextPreservation = this.scopeContextPreservationService.preserve(
      objectDisambiguation.query,
      userRequirement,
      objectDisambiguation
    );
    const metadataReview = this.queryMetadataConstraintService.constrain(
      scopeContextPreservation.query,
      userRequirement
    );

    return {
      ...mappingResult,
      resolvedQuery: metadataReview.query,
      serviceModeDisambiguation,
      timeSemanticEnhancement,
      metricDisambiguation,
      objectDisambiguation,
      scopeContextPreservation,
      metadataReview
    };
  }

  /**
   * 使用元数据解析自然语言
   * 
   * 完整的自然语言映射流程，包含路径规划、参数解析、实体解析、路径解析等
   * 
   * @param {string} userRequirement - 用户需求文本
   * @param {object} requestContext - 请求上下文
   * @returns {object} - 完整的解析结果对象
   */
  async mapNaturalLanguageWithMetadata(userRequirement, requestContext = null) {
    const baseResult = await this.mapNaturalLanguageWithDisambiguation(userRequirement, requestContext);
    baseResult.resolvedQuery = this.normalizeTopLevelQueryShape(baseResult.resolvedQuery);
    baseResult.resolvedQuery = this.alignGroupsWithSemanticTarget(baseResult.resolvedQuery);

    if (baseResult?.candidateSpec?.semantic_constraints) {
      baseResult.candidateSpec.semantic_constraints.targetObjectType = this.normalizeTopLevelGroupType(
        baseResult.candidateSpec.semantic_constraints.targetObjectType
      );
      if (baseResult.candidateSpec.semantic_constraints.anchorObject?.type) {
        baseResult.candidateSpec.semantic_constraints.anchorObject.type = this.normalizeTopLevelGroupType(
          baseResult.candidateSpec.semantic_constraints.anchorObject.type
        );
      }
    }

    if (baseResult?.evidence?.group?.type) {
      baseResult.evidence.group.type = this.normalizeTopLevelGroupType(baseResult.evidence.group.type);
    }

    const pathPlan = this.buildPassThroughPathPlan(baseResult.resolvedQuery);
    const queryWithPlannedPath = pathPlan.shouldApply
      ? {
        ...baseResult.resolvedQuery,
        groups: pathPlan.plannedGroups
      }
      : baseResult.resolvedQuery;
    const preResolutionMetadataReview = await this.napmMetadataService.reviewQuery(queryWithPlannedPath);
    const argumentResolution = await this.argumentResolutionService.resolve(
      queryWithPlannedPath,
      userRequirement,
      preResolutionMetadataReview
    );
    const queryWithResolvedArguments = argumentResolution.query;
    const dynamicMetadataReview = await this.napmMetadataService.reviewQuery(queryWithResolvedArguments);
    const dynamicConstraint = await this.queryMetadataConstraintService.constrainWithDynamicMetadata(
      queryWithResolvedArguments,
      dynamicMetadataReview
    );
    const metadataDrivenQuery = this.applyMetadataDrivenFinalization(
      dynamicConstraint.query,
      dynamicMetadataReview,
      baseResult,
      pathPlan
    );
    const executionScopeGuard = this.scopeContextPreservationService.evaluateExecution(
      metadataDrivenQuery,
      pathPlan,
      dynamicMetadataReview
    );
    // 主链路收口：路径选择停留在 metadata/path_resolve 的候选评分阶段，
    // parse 阶段不再做“边试边找路”的真实执行探测。
    const scopedDescentProbe = {
      resolved: false,
      query: executionScopeGuard.query,
      attempts: [],
      reason: 'disabled_for_mainline_cleanup'
    };
    const queryAfterScopeProbe = executionScopeGuard.query;
    const provisionalEntityResolve = baseResult.entityResolve || null;
    const finalResolvedQuery = this.buildArgumentMetadataGuard(
      queryAfterScopeProbe,
      provisionalEntityResolve
    ) || queryAfterScopeProbe;
    const entityResolve = baseResult.entityResolve || provisionalEntityResolve || null;
    const timeResolve = this.timeResolveService.resolve({
      timeSemanticEnhancement: baseResult.timeSemanticEnhancement,
      resolvedQuery: finalResolvedQuery
    });
    const metricResolve = this.metricResolveService.resolve({
      metricDisambiguation: baseResult.metricDisambiguation,
      resolvedQuery: finalResolvedQuery
    });
    const pathResolve = this.pathResolveService.resolve({
      pathPlan,
      resolvedQuery: finalResolvedQuery
    });
    const clarificationGate = this.clarificationGateService.assess({
      resolvedQuery: finalResolvedQuery,
      entityResolve,
      pathResolve,
      metricResolve,
      timeResolve
    });

    const result = {
      ...baseResult,
      resolvedQuery: finalResolvedQuery,
      entityResolve,
      clarificationGate,
      timeResolve,
      metricResolve,
      pathResolve,
      pathPlan,
      argumentResolution,
      preResolutionMetadataReview,
      dynamicMetadataReview,
      dynamicConstraint,
      executionScopeGuard,
      scopedDescentProbe
    };

    logAudit('semantic_mapping_completed', {
      userRequirement,
      mapping: this.buildMappingAuditSnapshot(result)
    }, requestContext);

    return result;
  }

  buildPassThroughPathPlan(resolvedQuery = null) {
    const plannedGroups = Array.isArray(resolvedQuery?.groups)
      ? resolvedQuery.groups.map((item) => ({
        type: item?.type,
        argument: item?.argument
      }))
      : [];

    return {
      shouldApply: false,
      reason: 'gateway_query_only_mode',
      pathMode: null,
      confidence: 0,
      templateCandidates: [],
      overviewConvergencePaths: [],
      plannedGroups
    };
  }

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

    const plannedGroups = Array.isArray(pathPlan?.plannedGroups) ? pathPlan.plannedGroups : [];
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
    if (firstGroup && !firstGroup.argument && Array.isArray(dynamicMetadataReview?.groupArguments) && dynamicMetadataReview.groupArguments.length > 0) {
      const matchedHint = scopeHints.find((hint) => (
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
        if (matchedMetric) {
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

  /**
   * 瑙ｆ瀽鐢ㄦ埛闇€姹備负缃戝叧璇锋眰
   * 
   * parse闃舵鍙仛"鏀舵暃鎴愬彲鎵ц璇锋眰"锛屼笉鐩存帴璁块棶涓婃父銆?   * 瀹冪殑鐩爣鏄敖閲忚緭鍑轰竴涓ǔ瀹氥€佸彲瀹¤銆佸彲鍥炴斁鐨刧atewayRequest銆?   * 
   * @param {string} userRequirement - 鐢ㄦ埛闇€姹傛枃鏈?   * @param {object} requestContext - 璇锋眰涓婁笅鏂?   * @returns {object} - 缃戝叧璇锋眰瀵硅薄
   */
  async parseToGatewayRequest(userRequirement, requestContext = null) {
    void userRequirement;
    void requestContext;
    const error = new Error('Local parse/postProcess chain is disabled. Please provide upstream structured resolvedQuery.');
    error.code = 'LOCAL_PARSE_DISABLED';
    throw error;
  }

  /**
   * 瑙ｆ瀽骞舵墽琛岀敤鎴烽渶姹?   * 
   * @param {string} userRequirement - 鐢ㄦ埛闇€姹傛枃鏈?   * @param {object} requestContext - 璇锋眰涓婁笅鏂?   * @returns {object} - 鎵ц缁撴灉
   */
  async parseAndExecute(userRequirement, requestContext = null) {
    void userRequirement;
    void requestContext;
    const error = new Error('Local parse/postProcess chain is disabled. Please provide upstream structured resolvedQuery.');
    error.code = 'LOCAL_PARSE_DISABLED';
    throw error;
  }

  /**
   * 鎵ц缃戝叧璇锋眰
   * 
   * execute闃舵鎵嶇湡姝ｅ彂璧蜂笂娓歌姹傦紝骞跺湪杩欓噷琛equestUrl銆乫allback鍜屽璁℃棩蹇椼€?   * 
   * @param {object} gatewayRequest - 缃戝叧璇锋眰瀵硅薄
   * @param {object} requestContext - 璇锋眰涓婁笅鏂?   * @returns {object} - 鎵ц鍝嶅簲瀵硅薄
   */
  async executeGatewayRequest(gatewayRequest, requestContext = null) {
    // 网关仅负责按上游结构化参数执行查询，不在本地改写查询语义或执行策略。
    const passthroughGatewayRequest = gatewayRequest && typeof gatewayRequest === 'object'
      ? JSON.parse(JSON.stringify(gatewayRequest))
      : {};
    const response = {
      ok: false,
      service: null,
      data: null,
      error: null,
      requestParams: null,
      requestParamsMasked: null
    };

    try {
      logger.info('\n========================================');
      logger.info('=== 璇箟缃戝叧璋冪敤 ===');
      logger.info('姝ｅ湪瑙ｆ瀽缃戝叧璇锋眰JSON...');

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
        response.ok = true;
        response.service = queryRequest.service;
        response.data = metadataMetrics;
        logAudit('napm_metadata_metrics_for_group_completed', {
          gatewayRequest: this.buildGatewayRequestSummary({ ...queryRequest, groups: metadataGroups }),
          execution: this.buildExecutionDataSummary(metadataMetrics),
          params: response.requestParamsMasked,
          url: response.requestUrl
        }, requestContext);
        return response;
      }

      if (queryRequest.service === 'groups' && metadataGroups.length > 0) {
        const firstGroup = metadataGroups[0] || {};
        const firstType = String(firstGroup.type || '').trim();
        const firstArgument = String(firstGroup.argument || '').trim();
        let namedList = null;
        let metadataTypeForDebug = 'groups';
        let metadataParams = null;
        let metadataArgumentTypeForDebug = null;

        if (firstType === 'Application' || firstType === 'DefinedApp') {
          namedList = await this.napmMetadataService.getApplications(firstArgument);
          metadataTypeForDebug = 'applications';
        } else if (firstType === 'WebApplication') {
          // WebApplication 可选对象列表应走 groupArguments(argumentType=4) 口径。
          namedList = await this.napmMetadataService.getGroupArguments('WebApplication', firstArgument);
          metadataTypeForDebug = 'groupArguments';
          const webAppDefinition = await this.napmMetadataService.getGroupDefinition('WebApplication');
          metadataArgumentTypeForDebug = Number(webAppDefinition?.argumentType);
          if (!Number.isFinite(metadataArgumentTypeForDebug)) {
            metadataArgumentTypeForDebug = 4;
          }
        } else if (firstType === 'BusinessGroup') {
          namedList = await this.napmMetadataService.getBusinessGroups(firstArgument);
          metadataTypeForDebug = 'businessGroups';
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
              argumentType: metadataArgumentTypeForDebug,
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
          logAudit('napm_metadata_named_groups_completed', {
            gatewayRequest: this.buildGatewayRequestSummary({ ...queryRequest, groups: metadataGroups }),
            execution: this.buildExecutionDataSummary(namedList),
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
        params.metrics = queryRequest.metrics.join(',');
        params.topCount = queryRequest.topCount || 20;
      } else if (queryRequest.service === 'averageValues') {
        params.metrics = queryRequest.metrics.join(',');
      } else if (queryRequest.service === 'timeValues') {
        params.metrics = queryRequest.metrics.join(',');
        params.granularity = queryRequest.granularity;
      }

      if (queryRequest.groups && queryRequest.groups.length > 0) {
        Object.assign(params, this.groupBuilder.buildGroupParams(queryRequest.groups));
      }

      logger.info('姝ｅ湪鏋勫缓URL...');
      const fullParams = {
        UserName: this.napmClient.username,
        Password: this.napmClient.password,
        ...params
      };
      response.requestParams = { ...params };
      response.requestParamsMasked = maskSensitiveParams(fullParams);
      const url = buildSafeUrl(this.napmClient.baseUrl, fullParams);
      response.requestUrl = url;
      logger.info('鎷兼帴濂界殑URL:');
      logger.info(url);
      logger.info('========================================');

      logAudit('napm_api_request_built', {
        gatewayRequest: this.buildGatewayRequestSummary(queryRequest),
        params: maskSensitiveParams(fullParams),
        url
      }, requestContext);

      logger.info('姝ｅ湪璇锋眰URL...');
      const rawPayload = await this.napmClient.get(params);
      const csvText = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);
      logger.info('璇锋眰鍒扮殑鏁版嵁:');
      logger.info(typeof rawPayload === 'string' ? rawPayload.substring(0, 200) + (rawPayload.length > 200 ? '...' : '') : JSON.stringify(rawPayload).substring(0, 200));
      logger.info('鏁版嵁闀垮害:', csvText.length);

      logger.info('姝ｅ湪瑙ｆ瀽鏁版嵁...');
      const data = this.parseNapmPayload(rawPayload);
      logger.info('瑙ｆ瀽鍒版暟鎹鏁?', data.length);
      logger.info('瑙ｆ瀽鍚庣殑鏁版嵁:');
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
      logger.error('缃戝叧璇锋眰鎵ц澶辫触:', error.message);
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

      response.error = {
        code: 'NAPM_UPSTREAM_ERROR',
        message: error.message
      };
      logAudit('napm_execution_failed', {
        gatewayRequest: this.buildGatewayRequestSummary(gatewayRequest),
        error: error.message
      }, requestContext);
      logger.info('========================================\n');
      return response;
    }
  }

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
   * 瑙ｆ瀽NAPM鍝嶅簲鏁版嵁
   * 
   * 鏀寔JSON鏁扮粍銆丣SON瀵硅薄銆丆SV瀛楃涓茬瓑澶氱鏍煎紡
   * 
   * @param {any} rawPayload - 鍘熷鍝嶅簲鏁版嵁
   * @returns {array} - 瑙ｆ瀽鍚庣殑鏁版嵁鏁扮粍
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
    const baseUrl = this.napmClient.baseUrl;
    const urlParams = buildOrderedParams({
      UserName: this.napmClient.username,
      Password: this.napmClient.password,
      ...params
    });
    const queryString = Object.entries(urlParams)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');
    return `${baseUrl}?${queryString}`;
  }

  /**
   * 后处理网关请求
   * 
   * 应用稳定查询约束、扩展双向指标、添加时间语义等
   * 
   * @param {object} gatewayRequest - 网关请求对象
   * @param {string} userRequirement - 用户需求文本
   * @param {object} mappingResult - 映射结果对象
   * @returns {object} - 处理后的网关请求
   */
  postProcessGatewayRequest(gatewayRequest, userRequirement, mappingResult = null) {
    void gatewayRequest;
    void userRequirement;
    void mappingResult;
    const error = new Error('Local parse/postProcess chain is disabled. Please provide upstream structured resolvedQuery.');
    error.code = 'LOCAL_PARSE_DISABLED';
    throw error;
  }

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

  buildComparePlan(executionState, resolvedQuery) {
    return this.metricDomainStrategyService.buildComparePlan(executionState, resolvedQuery);
  }

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

  normalizeTopLevelQueryShape(gatewayRequest) {
    if (!gatewayRequest || typeof gatewayRequest !== 'object') {
      return gatewayRequest;
    }

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
      if (Array.isArray(request.stableTemplate.allowedGroupPaths)) {
        request.stableTemplate.allowedGroupPaths = request.stableTemplate.allowedGroupPaths.map(
          (pathTypes) => this.normalizeTopLevelGroupPath(pathTypes)
        );
      }

      if (request.stableTemplate.bindings && typeof request.stableTemplate.bindings === 'object') {
        if (Array.isArray(request.stableTemplate.bindings.groupPath)) {
          request.stableTemplate.bindings.groupPath = this.normalizeTopLevelGroupPath(
            request.stableTemplate.bindings.groupPath
          );
        }

        if (Array.isArray(request.stableTemplate.bindings.allowedGroupPaths)) {
          request.stableTemplate.bindings.allowedGroupPaths = request.stableTemplate.bindings.allowedGroupPaths.map(
            (pathTypes) => this.normalizeTopLevelGroupPath(pathTypes)
          );
        }
      }

      if (request.stableTemplate.inferredArguments && typeof request.stableTemplate.inferredArguments === 'object') {
        if (
          request.stableTemplate.inferredArguments.Application
          && !request.stableTemplate.inferredArguments.DefinedApp
        ) {
          request.stableTemplate.inferredArguments.DefinedApp = request.stableTemplate.inferredArguments.Application;
        }
      }
    }

    return request;
  }

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

  applyStableTemplateBindings(request, template, userRequirement = '') {
    if (this.areGatewayTemplatesDisabled()) {
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

  validateMetrics(metrics) {
    const validMetrics = [];
    
    metrics.forEach(code => {
      logger.info(`楠岃瘉鎸囨爣浠ｇ爜: ${code}`, {
        isValid: this.metricMappingService.isValidMetricCode(code)
      });
      
      if (this.metricMappingService.isValidMetricCode(code)) {
        validMetrics.push(code);
      }
    });

    if (validMetrics.length === 0) {
      logger.warn('娌℃湁鏈夋晥鎸囨爣锛屼娇鐢ㄩ粯璁ゆ寚鏍? TPIO');
      return ['TPIO'];
    }

    logger.info('楠岃瘉鍚巑etrics:', validMetrics.join(','));
    return validMetrics;
  }

  validateMetric(metric, metrics) {
    if (!this.metricMappingService.isValidMetricCode(metric) || !metrics.includes(metric)) {
      if (metrics.length > 0) {
        const newMetric = metrics[0];
        logger.info('topMetric鏃犳晥锛屼娇鐢╩etrics涓殑绗竴涓寚鏍?', newMetric);
        return newMetric;
      }
    }
    return metric;
  }

  applyDefaultTopMetricForPacketLossRanking(gatewayRequest, userRequirement = '') {
    if (!gatewayRequest || gatewayRequest.service !== 'topValues') {
      return gatewayRequest;
    }

    const request = gatewayRequest;
    const semanticMetric = String(request.metric || '').trim().toUpperCase();
    if (!['PLI', 'PLO'].includes(semanticMetric)) {
      return request;
    }

    const existingTopMetric = String(request.topMetric || '').trim().toUpperCase();
    if (existingTopMetric) {
      return request;
    }

    const text = String(userRequirement || request.userRequirement || '').trim();
    if (this.hasExplicitRankingMetricInText(text)) {
      return request;
    }

    // 业务约定：丢包类排行在未显式指定排序指标时，默认按吞吐量(TPIO)排序。
    request.topMetric = 'TPIO';
    if (request.executionBinding && typeof request.executionBinding === 'object') {
      request.executionBinding.topSortMetricHint = 'TPIO';
    }
    if (request.semanticConstraints && typeof request.semanticConstraints === 'object') {
      request.semanticConstraints.rankingSortMetric = 'TPIO';
    }

    return request;
  }

  hasExplicitRankingMetricInText(text = '') {
    const raw = String(text || '').trim();
    if (!raw) {
      return false;
    }

    // Respect explicit ranking-metric intent from users.
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

  // Legacy local assistant-state query builders removed from main chain.

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

    return {
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
    };
  }

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

  buildDynamicTopnTemplate(templateId = '', rankingTargetType = '', topMetricHint = '') {
    const id = String(templateId || '').trim();
    const groupType = String(rankingTargetType || '').trim();
    const metric = String(topMetricHint || '').trim();
    if (!id || !groupType || !metric) {
      return null;
    }

    return {
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
    };
  }

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

    const bindings = template.bindings || {};
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
        id: template.id,
        description: template.description || null,
        intent: template.intent || 'topn',
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
        stableTemplateId: template.id,
        rankingTitleKey: partialQuery?.rankingTitleKey || null
      },
      intentResult: this.buildIntentResult(partialQuery, userRequirement),
      semanticResolutionResult: this.buildSemanticResolutionResult(partialQuery)
    };
  }
}

module.exports = new RequirementParserService();

