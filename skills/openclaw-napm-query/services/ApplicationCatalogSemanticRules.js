const ObjectOntologyService = require('./ObjectOntologyService');

/**
 * Shared NAPM application catalog semantics.
 *
 * Object wording is backed by object-ontology.v1.json so resolver and legacy
 * prompt routing do not drift on variants such as "自动识别的应用".
 */

function normalizePromptText(prompt = '') {
  return String(prompt || '').trim();
}

function buildApplicationCatalogPatterns() {
  const patterns = {};
  ObjectOntologyService.listObjectDefinitions().forEach((definition) => {
    const aliases = ObjectOntologyService.getAliases(definition.objectType);
    if (aliases.length === 0) {
      return;
    }
    patterns[definition.objectType] = new RegExp(
      aliases.map(alias => String(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
      'i'
    );
  });
  patterns.PlainApplication = /应用|Application/i;
  return Object.freeze(patterns);
}

const APPLICATION_CATALOG_PATTERNS = buildApplicationCatalogPatterns();

function classifyApplicationCatalogPrompt(prompt = '') {
  const text = normalizePromptText(prompt);
  if (!text) {
    return {
      objectType: null,
      ambiguous: false,
      reason: 'empty_prompt'
    };
  }

  const orderedObjectTypes = ObjectOntologyService.listObjectDefinitions()
    .map(definition => definition.objectType)
    .filter(objectType => objectType !== 'PageFamily' && objectType !== 'User' && objectType !== 'ClientBusinessGroup');

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
      objectType: ObjectOntologyService.getPlainApplicationDefault(),
      ambiguous: false,
      reason: 'plain_application_defaults_to_defined_app',
      matchedPattern: 'PlainApplication'
    };
  }

  return {
    objectType: null,
    ambiguous: false,
    reason: 'no_application_catalog_match'
  };
}

function isPlainApplicationCatalogPrompt(prompt = '') {
  return classifyApplicationCatalogPrompt(prompt).matchedPattern === 'PlainApplication';
}

module.exports = {
  APPLICATION_CATALOG_PATTERNS,
  classifyApplicationCatalogPrompt,
  isPlainApplicationCatalogPrompt,
  normalizePromptText
};
