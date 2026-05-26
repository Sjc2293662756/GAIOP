const fs = require('fs');
const path = require('path');

const ONTOLOGY_PATH = path.resolve(__dirname, '../../../config/object-ontology.v1.json');

let cachedOntology = null;

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeText(value = '') {
  return String(value || '').trim();
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadOntology() {
  if (cachedOntology) {
    return cachedOntology;
  }

  const raw = fs.readFileSync(ONTOLOGY_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const objects = Array.isArray(parsed.objects) ? parsed.objects : [];

  cachedOntology = {
    version: parsed.version || 'unknown',
    objects,
    byType: new Map(objects.map(item => [item.objectType, item])),
    plainApplicationCandidates: Array.isArray(parsed.plainApplicationCandidates)
      ? parsed.plainApplicationCandidates.slice()
      : []
  };
  return cachedOntology;
}

function clearCache() {
  cachedOntology = null;
}

function getObjectDefinition(objectType = '') {
  const key = normalizeText(objectType);
  if (!key) {
    return null;
  }
  const ontology = loadOntology();
  return cloneJson(ontology.byType.get(key) || null);
}

function listObjectDefinitions() {
  return cloneJson(loadOntology().objects);
}

function getPlainApplicationCandidates() {
  return loadOntology().plainApplicationCandidates.slice();
}

function getAliases(objectType = '') {
  const definition = getObjectDefinition(objectType);
  if (!definition) {
    return [];
  }
  return [
    ...(Array.isArray(definition.cnAliases) ? definition.cnAliases : []),
    ...(Array.isArray(definition.enAliases) ? definition.enAliases : [])
  ];
}

function buildAliasPattern(objectType = '') {
  const aliases = getAliases(objectType);
  if (aliases.length === 0) {
    return null;
  }
  return new RegExp(aliases.map(escapeRegExp).join('|'), 'i');
}

function classifyObjectText(prompt = '') {
  const text = normalizeText(prompt);
  if (!text) {
    return {
      objectType: null,
      ambiguous: false,
      reason: 'empty_prompt'
    };
  }

  for (const definition of listObjectDefinitions()) {
    const pattern = buildAliasPattern(definition.objectType);
    if (pattern && pattern.test(text)) {
      return {
        objectType: definition.objectType,
        ambiguous: false,
        matchedPattern: definition.objectType
      };
    }
  }

  if (/应用|Application/i.test(text)) {
    return {
      objectType: null,
      ambiguous: true,
      reason: 'plain_application_inventory_is_ambiguous',
      candidates: getPlainApplicationCandidates()
    };
  }

  return {
    objectType: null,
    ambiguous: false,
    reason: 'no_object_match'
  };
}

function resolveObjectInstanceProvider(objectType = '') {
  const requestedObjectType = normalizeText(objectType);
  const definition = getObjectDefinition(requestedObjectType);
  if (!definition) {
    return null;
  }

  return {
    effectiveObjectType: definition.effectiveObjectType || definition.objectType,
    executionGroupType: definition.executionGroupType || definition.effectiveObjectType || definition.objectType,
    providerType: definition.inventoryProvider || definition.providerType || null,
    apiType: definition.apiType || definition.inventoryProvider || null,
    applicationTypeFilter: Array.isArray(definition.applicationTypeFilter)
      ? definition.applicationTypeFilter.slice()
      : null,
    applicationCatalogRole: definition.applicationCatalogRole || null
  };
}

module.exports = {
  ONTOLOGY_PATH,
  clearCache,
  loadOntology,
  listObjectDefinitions,
  getObjectDefinition,
  getAliases,
  getPlainApplicationCandidates,
  classifyObjectText,
  resolveObjectInstanceProvider
};
