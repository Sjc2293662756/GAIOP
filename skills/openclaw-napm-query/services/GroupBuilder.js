/**
 * GroupBuilder.js
 *
 * 负责在运行时构建 NAPM 所需的 group 参数结构。
 * 同时提供对象类型别名解析、合法性校验等基础能力，供查询执行链路复用。
 */
const logger = require('../src/utils/logger');
const { OBJECT_DIMENSIONS } = require('../src/constants/objectDimensions');
class GroupBuilder {
  // 预构建“自然语言别名 -> 标准 groupType”的映射表，减少运行时重复扫描。
  constructor() {
    this.groupTypeMapping = this.buildAliasToGroupType();
  }

  /**
   * 基于对象维度定义生成别名映射表。
   */
  buildAliasToGroupType() {
    const mapping = {};
    OBJECT_DIMENSIONS.forEach(item => {
      mapping[item.key.toLowerCase()] = item.key;
      item.aliases.forEach(alias => {
        mapping[String(alias).toLowerCase()] = item.key;
      });
    });
    return mapping;
  }

  /**
   * 把 groups 数组转换成 NAPM API 所要求的 groupTypeX / groupArgumentX 参数。
   */
  buildGroupParams(groups) {
    const params = {};
    if (!Array.isArray(groups) || groups.length === 0) {
      return params;
    }

    groups.forEach((group, index) => {
      const idx = index + 1;
      const typeKey = `groupType${idx}`;
      const argumentKey = `groupArgument${idx}`;
      params[typeKey] = group.type;

      if (group.argument !== undefined && group.argument !== null && String(group.argument).trim() !== '') {
        params[argumentKey] = group.argument;
      }
    });

    params.numGroups = groups.length;
    logger.info('Group parameters built', {
      groupCount: groups.length,
      groupTypes: groups.map((group) => String(group?.type || '').trim()).filter(Boolean)
    });
    return params;
  }

  /**
   * 把自然语言或别名形式的对象类型解析成标准 groupType。
   */
  parseGroupType(naturalLanguage) {
    if (!naturalLanguage) {
      return null;
    }
    const normalized = String(naturalLanguage).toLowerCase().trim();
    return this.groupTypeMapping[normalized] || null;
  }

  // 校验传入的 groupType 是否在当前对象维度定义中存在。
  validateGroupType(groupType) {
    return OBJECT_DIMENSIONS.some(item => item.key === groupType);
  }

  getValidGroupTypes() {
    return OBJECT_DIMENSIONS.map(item => item.key);
  }
}

module.exports = new GroupBuilder();
