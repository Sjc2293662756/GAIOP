/**
 * Shared NAPM application catalog semantics.
 *
 * Keep application inventory wording in one place so resolver and legacy prompt
 * routing do not drift on variants such as "自动识别的应用".
 */

function normalizePromptText(prompt = '') {
  return String(prompt || '').trim();
}

const APPLICATION_CATALOG_PATTERNS = Object.freeze({
  BusinessGroup: /工作组|业务组|业务分组|BusinessGroup/i,
  BuiltinApplication: /内置应用|内置端口应用|系统内置应用|BuiltinApplication/i,
  CompositeApplication: /(?:系统)?自动识别(?:出来)?(?:的)?应用|特征识别(?:的)?应用|复合协议|复合应用|多协议应用|组合应用|CompositeApplication|composite\s*application/i,
  OtherApp: /未知应用|未知端口|其他应用|其它应用|OtherApp/i,
  DefinedApp: /已定义应用|服务器应用|服务应用|协议应用|DefinedApp/i,
  WebApplication: /业务系统|Web应用|web应用|网站|站点|业务|WebApplication/i,
  PlainApplication: /应用|Application/i
});

function classifyApplicationCatalogPrompt(prompt = '') {
  const text = normalizePromptText(prompt);
  if (!text) {
    return {
      objectType: null,
      ambiguous: false,
      reason: 'empty_prompt'
    };
  }

  const orderedObjectTypes = [
    'BusinessGroup',
    'BuiltinApplication',
    'CompositeApplication',
    'OtherApp',
    'DefinedApp',
    'WebApplication'
  ];

  for (const objectType of orderedObjectTypes) {
    if (APPLICATION_CATALOG_PATTERNS[objectType].test(text)) {
      return {
        objectType,
        ambiguous: false,
        matchedPattern: objectType
      };
    }
  }

  if (APPLICATION_CATALOG_PATTERNS.PlainApplication.test(text)) {
    return {
      objectType: null,
      ambiguous: true,
      reason: 'plain_application_inventory_is_ambiguous',
      candidates: [
        'WebApplication',
        'DefinedApp',
        'BuiltinApplication',
        'CompositeApplication',
        'OtherApp'
      ]
    };
  }

  return {
    objectType: null,
    ambiguous: false,
    reason: 'no_application_catalog_match'
  };
}

function isPlainApplicationCatalogPrompt(prompt = '') {
  return classifyApplicationCatalogPrompt(prompt).ambiguous === true;
}

module.exports = {
  APPLICATION_CATALOG_PATTERNS,
  classifyApplicationCatalogPrompt,
  isPlainApplicationCatalogPrompt,
  normalizePromptText
};
