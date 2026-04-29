/**
 * NapmMetadataService.js
 * 
 * 鎻忚堪锛歂APM 鍏冩暟鎹湇鍔℃ā锟? * 鍔熻兘锛氫粠 NAPM 鍚庣鏈嶅姟鑾峰彇鍚勭鍏冩暟鎹紙鎸囨爣銆佸垎缁勩€佸簲鐢ㄣ€佺敤鎴枫€侀〉闈㈢瓑锛夛紝
 *       鎻愪緵缂撳瓨鏈哄埗鍑忓皯閲嶅璇锋眰锛屽苟瀵硅繑鍥炴暟鎹繘琛屾爣鍑嗗寲澶勭悊
 * 浣滆€咃細绯荤粺鐢熸垚
 * 淇敼鏃ユ湡锟?026-04-15
 */

const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');

const NapmClient = require('./NapmClient');
const DimensionMappingService = require('./DimensionMappingService');
const logger = require('../../../src/utils/logger');

  /**
 * NAPM 鍏冩暟鎹湇鍔＄被
 * 璐熻矗鑾峰彇鍜岀紦锟?NAPM 鍚庣鏈嶅姟鐨勫悇绉嶅厓鏁版嵁
 */
class NapmMetadataService {
  /**
   * 鏋勯€犲嚱锟?   * 鍒濆锟?NAPM 瀹㈡埛绔拰缂撳瓨瀹炰緥
   */
  constructor() {
    /** @type {NapmClient} NAPM API 瀹㈡埛绔疄锟?*/
    this.napmClient = new NapmClient();
    /** @type {NodeCache} 鍏冩暟鎹紦瀛樺疄渚嬶紙10鍒嗛挓杩囨湡锟?*/
    this.cache = new NodeCache({ stdTTL: 600 });
    this.groupsTreeMode = String(process.env.NAPM_GROUPS_TREE_MODE || 'static').toLowerCase();
    this.staticGroupsTreeFile = process.env.NAPM_STATIC_GROUPS_TREE_FILE
      ? path.resolve(process.env.NAPM_STATIC_GROUPS_TREE_FILE)
      : path.resolve(__dirname, '../../../config/groups-tree.static.json');
    this.staticGroupsTreeRaw = null;
  }

  /**
   * 鑾峰彇鎸囨爣鍒楄〃
   * @returns {array} - 鏍囧噯鍖栫殑鎸囨爣鏁扮粍锛屾瘡涓厓绱犲寘锟?id銆乴abel銆乽nit
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
   * 鑾峰彇鍒嗙粍鏍戠粨锟?   * @returns {array} - 瑙勮寖鍖栫殑鍒嗙粍鏍戣妭鐐规暟锟?   */
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
   * 鑾峰彇鎵佸钩鍖栫殑鍒嗙粍鍒楄〃
   * @returns {array} - 鎵佸钩鍖栫殑鍒嗙粍鏁扮粍
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
   * 鑾峰彇鏃堕棿绮掑害鍒楄〃
   * @returns {array} - 鎺掑簭鍚庣殑鏃堕棿绮掑害鏁扮粍锛堝崟浣嶏細绉掞級
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
   * 鑾峰彇搴旂敤鍒楄〃
   * @param {string} keyword - 杩囨护鍏抽敭锟?   * @returns {array} - 搴旂敤鍒楄〃
   */
  async getApplications(keyword = '') {
    return this.getNamedMetadataList('applications', keyword);
  }

  /**
   * 鑾峰彇涓氬姟缁勫垪锟?   * @param {string} keyword - 杩囨护鍏抽敭锟?   * @returns {array} - 涓氬姟缁勫垪锟?   */
  async getBusinessGroups(keyword = '') {
    return this.getNamedMetadataList('businessGroups', keyword);
  }

  /**
   * 鑾峰彇鎺ュ彛鍒楄〃
   * @param {string} keyword - 杩囨护鍏抽敭锟?   * @returns {array} - 鎺ュ彛鍒楄〃
   */
  async getInterfaces(keyword = '') {
    return this.getNamedMetadataList('interfaces', keyword);
  }

  /**
   * 鑾峰彇 VLAN 鍒楄〃
   * @param {string} keyword - 杩囨护鍏抽敭锟?   * @returns {array} - VLAN 鍒楄〃
   */
  async getVlans(keyword = '') {
    return this.getNamedMetadataList('vlans', keyword);
  }

  /**
   * 鑾峰彇 TOS 闆嗗悎鍒楄〃
   * @param {string} keyword - 杩囨护鍏抽敭锟?   * @returns {array} - TOS 闆嗗悎鍒楄〃
   */
  async getTosSets(keyword = '') {
    return this.getNamedMetadataList('tosSets', keyword);
  }

  /**
   * 鑾峰彇鐢ㄦ埛鍒楄〃
   * @param {string} searchText - 鎼滅储鏂囨湰
   * @param {number} maxLimit - 鏈€澶ц繑鍥炴暟锟?   * @returns {array} - 鐢ㄦ埛鍒楄〃
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
   * 鑾峰彇椤甸潰鍒楄〃
   * @param {string} searchText - 鎼滅储鏂囨湰
   * @param {number} maxLimit - 鏈€澶ц繑鍥炴暟锟?   * @returns {array} - 椤甸潰鍒楄〃
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
   * 鑾峰彇鍛藉悕鍏冩暟鎹垪琛ㄧ殑閫氱敤鏂规硶
   * @param {string} serviceType - 鏈嶅姟绫诲瀷
   * @param {string} keyword - 杩囨护鍏抽敭锟?   * @returns {array} - 鏍囧噯鍖栫殑鍛藉悕鍒楄〃
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
   * 鑾峰彇鍒嗙粍瀹氫箟锛堜紭鍏堢骇鏈€楂樼殑锟?   * @param {string} groupType - 鍒嗙粍绫诲瀷
   * @returns {object|null} - 鍒嗙粍瀹氫箟瀵硅薄
   */
  async getGroupDefinition(groupType) {
    const definitions = await this.getGroupDefinitions(groupType);
    return definitions[0] || null;
  }

  /**
   * 鑾峰彇鍒嗙粍瀹氫箟鍒楄〃锛堟寜浼樺厛绾ф帓搴忥級
   * @param {string} groupType - 鍒嗙粍绫诲瀷
   * @returns {array} - 鍒嗙粍瀹氫箟鏁扮粍
   */
  async getGroupDefinitions(groupType) {
    const flattened = await this.getFlattenedGroups();
    return flattened
      .filter(item => item.key === groupType)
      .sort((a, b) => this.scoreGroupDefinition(b) - this.scoreGroupDefinition(a));
  }

  /**
   * 鑾峰彇鍒嗙粍鍙傛暟鍒楄〃
   * @param {string} groupType - 鍒嗙粍绫诲瀷
   * @param {string} keyword - 杩囨护鍏抽敭锟?   * @returns {array} - 鍙傛暟鍒楄〃
   * @throws {Error} - 鏈煡鍒嗙粍绫诲瀷鏃舵姏鍑洪敊锟?   */
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
   * 鑾峰彇鍒嗙粍璺緞鏀寔鐨勬寚鏍囧垪锟?   * @param {array} groups - 鍒嗙粍鏁扮粍
   * @returns {array} - 鎸囨爣鍒楄〃
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
   * 瀹℃煡鏌ヨ鐨勬湁鏁堬拷?   * 妫€鏌ュ垎缁勩€佹寚鏍囥€佹椂闂寸矑搴︾瓑鏄惁鏈夋晥
   * @param {object} query - 鏌ヨ瀵硅薄
   * @returns {object} - 瀹℃煡缁撴灉锛屽寘锟?issues 锟?suggestions
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

  /**
   * 瑙勮寖鍖栧垎缁勮妭锟?   * @param {object} node - 鍘熷鑺傜偣瀵硅薄
   * @param {array} parentPath - 鐖惰矾寰勬暟锟?   * @returns {object} - 瑙勮寖鍖栫殑鑺傜偣瀵硅薄
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
   * 鎵佸钩鍖栧垎缁勬爲
   * @param {array} nodes - 鍒嗙粍鑺傜偣鏁扮粍
   * @param {array} acc - 绱姞鍣ㄦ暟锟?   * @returns {array} - 鎵佸钩鍖栫殑鍒嗙粍鏁扮粍
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
   * 瑙勮寖鍖栧垎缁勫弬锟?   * @param {*} raw - 鍘熷鏁版嵁
   * @param {string} groupType - 鍒嗙粍绫诲瀷
   * @param {string} keyword - 杩囨护鍏抽敭锟?   * @returns {array} - 瑙勮寖鍖栫殑鍙傛暟鏁扮粍
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
   * 瑙勮寖鍖栧懡鍚嶅垪锟?   * @param {*} raw - 鍘熷鏁版嵁
   * @param {string} keyword - 杩囨护鍏抽敭锟?   * @returns {array} - 瑙勮寖鍖栫殑鍛藉悕鍒楄〃
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
   * 鑾峰彇鍒嗙粍绫诲瀷鐨勫埆鍚嶅垪锟?   * @param {string} groupType - 鍒嗙粍绫诲瀷
   * @returns {array} - 鍒悕鏁扮粍
   */
  getAliases(groupType) {
    const dimension = DimensionMappingService.getObjectDimension(groupType);
    return dimension ? dimension.aliases || [] : [];
  }

  /**
   * 娓呯┖缂撳瓨
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
   * 涓哄垎缁勫畾涔夎瘎鍒嗭紙鐢ㄤ簬鎺掑簭锟?   * @param {object} definition - 鍒嗙粍瀹氫箟
   * @returns {number} - 璇勫垎锟?   */
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



