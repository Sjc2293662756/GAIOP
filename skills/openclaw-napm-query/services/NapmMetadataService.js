/**
 * NapmMetadataService.js
 * 
 * 描述：NAPM 元数据服务模块
 * 功能：从 NAPM 后端服务获取各种元数据（指标、分组、应用、用户、页面等），
 *       提供缓存机制减少重复请求，并对返回数据进行标准化处理
 * 作者：系统生成
 * 修改日期：2026-04-15
 */

const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');

const NapmClient = require('./NapmClient');
const DimensionMappingService = require('./DimensionMappingService');
const logger = require('../../../src/utils/logger');

  /**
 * NAPM 元数据服务类
 * 负责获取和缓存 NAPM 后端服务的各种元数据
 */
class NapmMetadataService {
  /**
   * 构造函数
   * 初始化 NAPM 客户端和缓存实例
   */
  constructor() {
    /** @type {NapmClient} NAPM API 客户端实例 */
    this.napmClient = new NapmClient();
    /** @type {NodeCache} 元数据缓存实例（10分钟过期） */
    this.cache = new NodeCache({ stdTTL: 600 });
    this.groupsTreeMode = String(process.env.NAPM_GROUPS_TREE_MODE || 'static').toLowerCase();
    this.staticGroupsTreeFile = process.env.NAPM_STATIC_GROUPS_TREE_FILE
      ? path.resolve(process.env.NAPM_STATIC_GROUPS_TREE_FILE)
      : path.resolve(__dirname, '../../../config/groups-tree.static.json');
    this.staticGroupsTreeRaw = null;
  }

  /**
   * 获取指标列表
   * @returns {array} - 标准化的指标数组，每个元素包含 id、label、unit
   */
  async getMetrics() {
    const cacheKey = 'metadata:metrics';
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const data = await this.napmClient.getJson({ type: 'metrics' });
    const normalized = Array.isArray(data)
      ? data.map(item => ({
        id: item.id,
        label: item.label,
        unit: item.unit || null
      }))
      : [];

    this.cache.set(cacheKey, normalized);
    return normalized;
  }

  /**
   * 获取分组树结构
   * @returns {array} - 规范化的分组树节点数组
   */
  async getGroupsTree() {
    const cacheKey = 'metadata:groupsTree';
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const preferredSources = this.resolveGroupsTreeSources();
    let normalized = [];

    for (const source of preferredSources) {
      if (source === 'static') {
        const staticRaw = this.loadStaticGroupsTreeRaw();
        if (Array.isArray(staticRaw) && staticRaw.length > 0) {
          normalized = staticRaw.map(node => this.normalizeGroupNode(node, []));
          logger.info('Groups metadata tree loaded from local static file', {
            source: 'static',
            file: this.staticGroupsTreeFile,
            rootCount: normalized.length
          });
          break;
        }
      }

      if (source === 'remote') {
        const remoteRaw = await this.napmClient.getJson({ type: 'groups' });
        if (Array.isArray(remoteRaw) && remoteRaw.length > 0) {
          normalized = remoteRaw.map(node => this.normalizeGroupNode(node, []));
          logger.info('Groups metadata tree loaded from remote NAPM API', {
            source: 'remote',
            rootCount: normalized.length
          });
          break;
        }
      }
    }

    this.cache.set(cacheKey, normalized);
    return normalized;
  }

  /**
   * 获取扁平化的分组列表
   * @returns {array} - 扁平化的分组数组
   */
  async getFlattenedGroups() {
    const cacheKey = 'metadata:flattenedGroups';
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const tree = await this.getGroupsTree();
    const flattened = this.flattenGroups(tree);
    this.cache.set(cacheKey, flattened);
    return flattened;
  }

  /**
   * 获取所有顶层 group 节点
   * @returns {array} - 顶层 group 节点数组
   */
  async getTopLevelGroups() {
    return this.getGroupsTree();
  }

  /**
   * 获取某个对象类型的下钻路径信息
   * @param {string} groupType - group 类型
   * @param {object} options - 枚举选项
   * @returns {object|null} - 下钻路径信息
   */
  async getDrilldownPathsForGroupType(groupType, options = {}) {
    const candidates = await this.findGroupNodesByType(groupType);
    const targetNode = candidates[0] || null;
    if (!targetNode) {
      return null;
    }

    const paths = this.collectDrilldownPathRecords(targetNode, options);
    return {
      groupType: targetNode.key,
      runtimeGroupType: this.normalizeRuntimeGroupKey(targetNode.key),
      label: targetNode.label || targetNode.key,
      isTopLevel: Array.isArray(targetNode.path) && targetNode.path.length === 1,
      sourcePath: Array.isArray(targetNode.path) ? targetNode.path.slice() : [targetNode.key],
      sourcePathText: String(targetNode.pathText || targetNode.key),
      canQuery: Boolean(targetNode.canQuery),
      hasArgument: Boolean(targetNode.hasArgument),
      directChildren: this.buildDirectDrilldownOptions(targetNode),
      pathCount: paths.length,
      paths
    };
  }

  /**
   * 获取所有顶层对象的下钻目录
   * @param {object} options - 枚举选项
   * @returns {array} - 顶层对象下钻目录
   */
  async getTopLevelDrilldownCatalog(options = {}) {
    const roots = await this.getTopLevelGroups();
    return roots.map((node) => {
      const paths = this.collectDrilldownPathRecords(node, options);
      return {
        groupType: node.key,
        runtimeGroupType: this.normalizeRuntimeGroupKey(node.key),
        label: node.label || node.key,
        canQuery: Boolean(node.canQuery),
        hasArgument: Boolean(node.hasArgument),
        directChildren: this.buildDirectDrilldownOptions(node),
        pathCount: paths.length,
        paths
      };
    });
  }

  /**
   * 获取时间粒度列表
   * @returns {array} - 排序后的时间粒度数组（单位：秒）
   */
  async getGranularities() {
    const cacheKey = 'metadata:granularities';
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const data = await this.napmClient.getJson({ type: 'granularities' });
    const normalized = Array.isArray(data)
      ? data.map(value => Number(value)).filter(value => Number.isFinite(value)).sort((a, b) => a - b)
      : [];

    this.cache.set(cacheKey, normalized);
    return normalized;
  }

  /**
   * 获取应用列表
   * @param {string} keyword - 过滤关键词
   * @returns {array} - 应用列表
   */
  async getApplications(keyword = '') {
    return this.getNamedMetadataList('applications', keyword);
  }

  /**
   * 获取业务组列表
   * @param {string} keyword - 过滤关键词
   * @returns {array} - 业务组列表
   */
  async getBusinessGroups(keyword = '') {
    return this.getNamedMetadataList('businessGroups', keyword);
  }

  /**
   * 获取接口列表
   * @param {string} keyword - 过滤关键词
   * @returns {array} - 接口列表
   */
  async getInterfaces(keyword = '') {
    return this.getNamedMetadataList('interfaces', keyword);
  }

  /**
   * 获取 VLAN 列表
   * @param {string} keyword - 过滤关键词
   * @returns {array} - VLAN 列表
   */
  async getVlans(keyword = '') {
    return this.getNamedMetadataList('vlans', keyword);
  }

  /**
   * 获取 TOS 集合列表
   * @param {string} keyword - 过滤关键词
   * @returns {array} - TOS 集合列表
   */
  async getTosSets(keyword = '') {
    return this.getNamedMetadataList('tosSets', keyword);
  }

  /**
   * 获取用户列表
   * @param {string} searchText - 搜索文本
   * @param {number} maxLimit - 最大返回数量
   * @returns {array} - 用户列表
   */
  async getUsers(searchText = '', maxLimit = 20) {
    const cacheKey = `metadata:users:${searchText}:${maxLimit}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const params = {
      type: 'users',
      maxLimit,
      json: 'true'
    };
    if (searchText) {
      params.searchText = searchText;
    }

    const raw = await this.napmClient.getJson(params);
    const normalized = this.normalizeNamedList(raw, searchText);
    this.cache.set(cacheKey, normalized);
    return normalized;
  }

  /**
   * 获取页面列表
   * @param {string} searchText - 搜索文本
   * @param {number} maxLimit - 最大返回数量
   * @returns {array} - 页面列表
   */
  async getPages(searchText = '', maxLimit = 20) {
    const cacheKey = `metadata:pages:${searchText}:${maxLimit}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    if (!String(searchText || '').trim()) {
      this.cache.set(cacheKey, []);
      return [];
    }

    const params = {
      type: 'pages',
      maxLimit,
      json: 'true'
    };
    if (searchText) {
      params.searchText = searchText;
    }

    const raw = await this.napmClient.getJson(params);
    const normalized = this.normalizeNamedList(raw, searchText);
    this.cache.set(cacheKey, normalized);
    return normalized;
  }

  /**
   * 获取命名元数据列表的通用方法
   * @param {string} serviceType - 服务类型
   * @param {string} keyword - 过滤关键词
   * @returns {array} - 标准化的命名列表
   */
  async getNamedMetadataList(serviceType, keyword = '') {
    const cacheKey = `metadata:${serviceType}:${keyword}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const params = {
      type: serviceType,
      json: 'true'
    };

    const raw = await this.napmClient.getJson(params);
    const normalized = this.normalizeNamedList(raw, keyword);
    this.cache.set(cacheKey, normalized);
    return normalized;
  }

  /**
   * 获取分组定义（优先级最高的）
   * @param {string} groupType - 分组类型
   * @returns {object|null} - 分组定义对象
   */
  async getGroupDefinition(groupType) {
    const definitions = await this.getGroupDefinitions(groupType);
    return definitions[0] || null;
  }

  /**
   * 获取分组定义列表（按优先级排序）
   * @param {string} groupType - 分组类型
   * @returns {array} - 分组定义数组
   */
  async getGroupDefinitions(groupType) {
    const flattened = await this.getFlattenedGroups();
    return flattened
      .filter(item => item.key === groupType)
      .sort((a, b) => this.scoreGroupDefinition(b) - this.scoreGroupDefinition(a));
  }

  /**
   * 获取分组参数列表
   * @param {string} groupType - 分组类型
   * @param {string} keyword - 过滤关键词
   * @returns {array} - 参数列表
   * @throws {Error} - 未知分组类型时抛出错误
   */
  async getGroupArguments(groupType, keyword = '') {
    const definition = await this.getGroupDefinition(groupType);
    if (!definition) {
      throw new Error(`Unknown group type: ${groupType}`);
    }

    if (!definition.hasArgument) {
      return [];
    }

    const cacheKey = `metadata:groupArguments:${groupType}:${keyword}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const params = {
      type: 'groupArguments',
      argumentType: definition.argumentType,
      json: 'true'
    };

    const raw = await this.napmClient.getJson(params);
    const normalized = this.normalizeGroupArguments(raw, groupType, keyword);
    this.cache.set(cacheKey, normalized);
    return normalized;
  }

  /**
   * 获取分组路径支持的指标列�?   * @param {array} groups - 分组数组
   * @returns {array} - 指标列表
   */
  async getMetricsForGroupPath(groups = []) {
    const normalizedGroups = Array.isArray(groups)
      ? groups.filter(item => item && item.type).map(item => ({ type: item.type, argument: item.argument }))
      : [];

    if (normalizedGroups.length === 0) {
      return [];
    }

    const cacheKey = `metadata:metricsForGroupPath:${JSON.stringify(normalizedGroups)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const params = {
      type: 'metricsForGroup',
      json: 'true',
      numGroups: normalizedGroups.length
    };

    normalizedGroups.forEach((group, index) => {
      const position = index + 1;
      params[`groupType${position}`] = group.type;
      if (group.argument) {
        params[`groupArgument${position}`] = group.argument;
      }
    });

    const raw = await this.napmClient.getJson(params);
    const normalized = Array.isArray(raw)
      ? raw.map(item => ({
        id: item.id,
        label: item.label,
        unit: item.unit || null
      }))
      : [];

    this.cache.set(cacheKey, normalized);
    return normalized;
  }

  /**
   * 审查查询的有效性
   * 检查分组、指标、时间粒度等是否有效
   * @param {object} query - 查询对象
   * @returns {object} - 审查结果，包含 issues 和 suggestions
   */
  async reviewQuery(query) {
    const issues = [];
    const suggestions = [];

    const result = {
      groups: null,
      groupArguments: null,
      granularities: null,
      metricsForGroup: null,
      issues,
      suggestions
    };

    if (!query || !query.service) {
      issues.push('query_missing_or_invalid');
      return result;
    }

    const firstGroup = Array.isArray(query.groups) && query.groups[0] ? query.groups[0] : null;
    if (firstGroup) {
      const groupDefinition = await this.getGroupDefinition(firstGroup.type);
      result.groups = groupDefinition;

      if (!groupDefinition) {
        issues.push(`group_not_found:${firstGroup.type}`);
      } else {
        if (!groupDefinition.canQuery) {
          issues.push(`group_cannot_query:${firstGroup.type}`);
        }

        if (groupDefinition.hasArgument) {
          const groupArguments = await this.getGroupArguments(firstGroup.type);
          result.groupArguments = groupArguments;

          if (firstGroup.argument) {
            const matched = groupArguments.some(item => String(item.value).toLowerCase() === String(firstGroup.argument).toLowerCase());
            if (!matched && groupArguments.length > 0 && groupArguments.length <= 1000) {
              issues.push(`group_argument_not_found:${firstGroup.type}:${firstGroup.argument}`);
              suggestions.push({
                type: 'group_argument_candidates',
                groupType: firstGroup.type,
                candidates: groupArguments.slice(0, 20)
              });
            }
          }
        }
      }

      const metricsForGroup = await this.getMetricsForGroupPath(query.groups);
      result.metricsForGroup = metricsForGroup;
      if (metricsForGroup.length === 0) {
        issues.push(`metrics_for_group_empty:${firstGroup.type}`);
      }
    }

    if (query.service === 'timeValues') {
      const granularities = await this.getGranularities();
      result.granularities = granularities;
      if (!granularities.includes(Number(query.granularity))) {
        issues.push(`granularity_not_supported:${query.granularity}`);
        suggestions.push({
          type: 'supported_granularities',
          values: granularities
        });
      }
    }

    if (query.metric && result.metricsForGroup && result.metricsForGroup.length > 0) {
      const matchedMetric = result.metricsForGroup.some(item => item.id === query.metric);
      if (!matchedMetric) {
        issues.push(`metric_not_supported_for_group:${query.metric}`);
        suggestions.push({
          type: 'metrics_for_group',
          values: result.metricsForGroup.slice(0, 30)
        });
      }
    }

    return result;
  }

  normalizeRuntimeGroupKey(groupType = '') {
    const raw = String(groupType || '').trim();
    if (!raw) {
      return raw;
    }

    if (raw === 'Application') {
      return 'DefinedApp';
    }

    return raw;
  }

  normalizeRuntimeGroupPath(path = []) {
    if (!Array.isArray(path)) {
      return [];
    }

    return path
      .map((item) => this.normalizeRuntimeGroupKey(item))
      .filter(Boolean);
  }

  buildDirectDrilldownOptions(node) {
    const children = Array.isArray(node?.children) ? node.children : [];
    const deduped = new Map();

    children.forEach((child) => {
      const rawPath = Array.isArray(child.path) ? child.path.slice() : [child.key];
      const runtimePath = this.normalizeRuntimeGroupPath(rawPath);
      const key = runtimePath.join(' > ');
      if (!key || deduped.has(key)) {
        return;
      }

      deduped.set(key, {
        key: child.key,
        runtimeKey: this.normalizeRuntimeGroupKey(child.key),
        label: child.label || child.key,
        canQuery: Boolean(child.canQuery),
        hasArgument: Boolean(child.hasArgument),
        childCount: Array.isArray(child.children) ? child.children.length : 0,
        rawPath,
        rawPathText: rawPath.join(' > '),
        runtimePath,
        runtimePathText: runtimePath.join(' > ')
      });
    });

    return Array.from(deduped.values());
  }

  buildDrilldownPathRecord(pathNodes = []) {
    const rawPath = pathNodes
      .map((node) => String(node?.key || '').trim())
      .filter(Boolean);
    const runtimePath = this.normalizeRuntimeGroupPath(rawPath);
    const terminalNode = pathNodes[pathNodes.length - 1] || null;

    return {
      rawPath,
      rawPathText: rawPath.join(' > '),
      runtimePath,
      runtimePathText: runtimePath.join(' > '),
      depth: Math.max(0, rawPath.length - 1),
      terminalKey: terminalNode?.key || null,
      terminalRuntimeKey: this.normalizeRuntimeGroupKey(terminalNode?.key || ''),
      terminalLabel: terminalNode?.label || terminalNode?.key || null,
      terminalCanQuery: Boolean(terminalNode?.canQuery),
      terminalHasArgument: Boolean(terminalNode?.hasArgument),
      terminalChildCount: Array.isArray(terminalNode?.children) ? terminalNode.children.length : 0
    };
  }

  collectDrilldownPathRecords(node, options = {}, parentNodes = null, acc = []) {
    if (!node) {
      return [];
    }

    const config = {
      maxDepth: Number.isFinite(Number(options?.maxDepth)) && Number(options.maxDepth) >= 1
        ? Number(options.maxDepth)
        : Infinity,
      includeIntermediate: options?.includeIntermediate !== false,
      leafOnly: Boolean(options?.leafOnly)
    };

    const pathNodes = Array.isArray(parentNodes) && parentNodes.length > 0
      ? parentNodes.concat(node)
      : [node];
    const drillDepth = pathNodes.length - 1;
    const children = Array.isArray(node.children) ? node.children : [];
    const isLeaf = children.length === 0;

    if (drillDepth > 0 && drillDepth <= config.maxDepth) {
      const shouldInclude = config.leafOnly
        ? isLeaf
        : (config.includeIntermediate || isLeaf);
      if (shouldInclude) {
        acc.push(this.buildDrilldownPathRecord(pathNodes));
      }
    }

    if (drillDepth >= config.maxDepth) {
      return this.dedupeDrilldownPathRecords(acc);
    }

    children.forEach((child) => {
      this.collectDrilldownPathRecords(child, config, pathNodes, acc);
    });

    return this.dedupeDrilldownPathRecords(acc);
  }

  dedupeDrilldownPathRecords(records = []) {
    const deduped = new Map();

    records.forEach((item) => {
      const runtimeKey = String(item?.runtimePathText || '').trim();
      const rawPathText = String(item?.rawPathText || '').trim();
      const key = runtimeKey || rawPathText;
      if (!key) {
        return;
      }

      if (!deduped.has(key)) {
        deduped.set(key, {
          ...item,
          rawVariants: rawPathText ? [rawPathText] : []
        });
        return;
      }

      const existing = deduped.get(key);
      if (rawPathText && !existing.rawVariants.includes(rawPathText)) {
        existing.rawVariants.push(rawPathText);
      }
    });

    return Array.from(deduped.values()).sort((left, right) => {
      if (left.depth !== right.depth) {
        return left.depth - right.depth;
      }
      return String(left.runtimePathText || '').localeCompare(String(right.runtimePathText || ''));
    });
  }

  async findGroupNodesByType(groupType) {
    const target = this.normalizeRuntimeGroupKey(groupType);
    if (!target) {
      return [];
    }

    const tree = await this.getGroupsTree();
    const matches = [];
    this.collectGroupNodesByType(tree, target, matches);
    return matches.sort((left, right) => this.scoreGroupNode(right) - this.scoreGroupNode(left));
  }

  collectGroupNodesByType(nodes = [], target = '', acc = []) {
    if (!Array.isArray(nodes) || !target) {
      return acc;
    }

    nodes.forEach((node) => {
      if (this.normalizeRuntimeGroupKey(node?.key) === target) {
        acc.push(node);
      }

      if (Array.isArray(node?.children) && node.children.length > 0) {
        this.collectGroupNodesByType(node.children, target, acc);
      }
    });

    return acc;
  }

  scoreGroupNode(node) {
    if (!node) {
      return -Infinity;
    }

    let score = this.scoreGroupDefinition(node);
    if (Array.isArray(node.path) && node.path.length === 1) {
      score += 100;
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      score += 5;
    }
    return score;
  }

  /**
   * 规范化分组节点
   * @param {object} node - 原始节点对象
   * @param {array} parentPath - 父路径数组
   * @returns {object} - 规范化的节点对象
   */
  normalizeGroupNode(node, parentPath) {
    const currentPath = parentPath.concat(node.key);
    return {
      key: node.key,
      label: node.label,
      type: node.type,
      argumentType: node.argumentType,
      hasArgument: Boolean(node.hasArgument),
      canQuery: Boolean(node.canQuery),
      path: currentPath,
      pathText: currentPath.join(' > '),
      aliases: this.getAliases(node.key),
      children: Array.isArray(node.children)
        ? node.children.map(child => this.normalizeGroupNode(child, currentPath))
        : []
    };
  }

  /**
   * 扁平化分组树
   * @param {array} nodes - 分组节点数组
   * @param {array} acc - 累加器数组
   * @returns {array} - 扁平化的分组数组
   */
  flattenGroups(nodes, acc = []) {
    for (const node of nodes) {
      acc.push({
        key: node.key,
        label: node.label,
        type: node.type,
        argumentType: node.argumentType,
        hasArgument: node.hasArgument,
        canQuery: node.canQuery,
        path: node.path,
        pathText: node.pathText,
        aliases: node.aliases
      });

      if (Array.isArray(node.children) && node.children.length > 0) {
        this.flattenGroups(node.children, acc);
      }
    }

    return acc;
  }

  /**
   * 规范化分组参数
   * @param {*} raw - 原始数据
   * @param {string} groupType - 分组类型
   * @param {string} keyword - 过滤关键词
   * @returns {array} - 规范化的参数数组
   */
  normalizeGroupArguments(raw, groupType, keyword = '') {
    let values = [];

    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.options)) {
      values = raw.options;
    } else if (Array.isArray(raw)) {
      values = raw;
    } else if (raw && typeof raw === 'object' && raw.value) {
      values = [raw.value];
    }

    const normalized = values
      .map(item => {
        if (typeof item === 'string') {
          return { value: item, label: item };
        }
        if (item && typeof item === 'object') {
          const value = item.value || item.argument || item.label || item.name;
          if (!value) {
            return null;
          }
          return {
            value,
            label: item.label || item.name || value
          };
        }
        return null;
      })
      .filter(Boolean);

    if (!keyword) {
      return normalized;
    }

    const lowerKeyword = String(keyword).toLowerCase();
    return normalized.filter(item => String(item.label).toLowerCase().includes(lowerKeyword));
  }

  /**
   * 规范化命名列表
   * @param {*} raw - 原始数据
   * @param {string} keyword - 过滤关键词
   * @returns {array} - 规范化的命名列表
   */
  normalizeNamedList(raw, keyword = '') {
    const values = Array.isArray(raw)
      ? raw
      : (raw && typeof raw === 'object' && Array.isArray(raw.options) ? raw.options : []);

    const normalized = values
      .map(item => {
        if (typeof item === 'string') {
          return { value: item, label: item };
        }
        if (item && typeof item === 'object') {
          const value = item.value || item.name || item.Name || item.label || item.Label || item.id || item.Id;
          const label = item.label || item.Label || item.name || item.Name || value;
          if (!value) {
            return null;
          }
          return {
            value: String(value),
            label: String(label)
          };
        }
        return null;
      })
      .filter(Boolean);

    if (!keyword) {
      return normalized;
    }

    const lowerKeyword = String(keyword).toLowerCase();
    return normalized.filter(item =>
      String(item.label).toLowerCase().includes(lowerKeyword)
      || String(item.value).toLowerCase().includes(lowerKeyword)
    );
  }

  /**
   * 获取分组类型的别名列�?   * @param {string} groupType - 分组类型
   * @returns {array} - 别名数组
   */
  getAliases(groupType) {
    const dimension = DimensionMappingService.getObjectDimension(groupType);
    return dimension ? dimension.aliases || [] : [];
  }

  /**
   * 清空缓存
   */
  clearCache() {
    this.cache.flushAll();
    logger.info('NapmMetadataService cache cleared');
  }

  resolveGroupsTreeSources() {
    if (this.groupsTreeMode === 'remote') {
      return ['remote'];
    }
    if (this.groupsTreeMode === 'auto') {
      return ['static', 'remote'];
    }
    return ['static', 'remote'];
  }

  loadStaticGroupsTreeRaw() {
    if (Array.isArray(this.staticGroupsTreeRaw)) {
      return this.staticGroupsTreeRaw;
    }

    try {
      if (!fs.existsSync(this.staticGroupsTreeFile)) {
        logger.warn('Static groups tree file not found', {
          file: this.staticGroupsTreeFile
        });
        return null;
      }

      const content = fs.readFileSync(this.staticGroupsTreeFile, 'utf8');
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        logger.warn('Static groups tree file is not an array', {
          file: this.staticGroupsTreeFile
        });
        return null;
      }

      this.staticGroupsTreeRaw = parsed;
      return this.staticGroupsTreeRaw;
    } catch (error) {
      logger.warn('Failed to load static groups tree file', {
        file: this.staticGroupsTreeFile,
        error: error.message
      });
      return null;
    }
  }
/**
   * 为分组定义评分（用于排序）
   * @param {object} definition - 分组定义
   * @returns {number} - 评分值
   */
  scoreGroupDefinition(definition) {
    if (!definition) {
      return -Infinity;
    }

    let score = 0;
    if (definition.canQuery) {
      score += 20;
    }
    if (Array.isArray(definition.path) && definition.path[0] === definition.key) {
      score += 8;
    }
    if (Array.isArray(definition.path)) {
      score -= definition.path.length;
    }

    return score;
  }
}

module.exports = new NapmMetadataService();



