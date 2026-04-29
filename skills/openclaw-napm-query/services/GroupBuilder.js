const logger = require('../../../src/utils/logger');
const { OBJECT_DIMENSIONS } = require('../../../src/constants/objectDimensions');

class GroupBuilder {
  constructor() {
    this.groupTypeMapping = this.buildAliasToGroupType();
  }

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
    logger.info('Group parameters built', { params });
    return params;
  }

  parseGroupType(naturalLanguage) {
    if (!naturalLanguage) {
      return null;
    }
    const normalized = String(naturalLanguage).toLowerCase().trim();
    return this.groupTypeMapping[normalized] || null;
  }

  validateGroupType(groupType) {
    return OBJECT_DIMENSIONS.some(item => item.key === groupType);
  }

  getValidGroupTypes() {
    return OBJECT_DIMENSIONS.map(item => item.key);
  }
}

module.exports = new GroupBuilder();
