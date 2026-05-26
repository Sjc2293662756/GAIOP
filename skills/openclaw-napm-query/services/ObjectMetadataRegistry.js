const MetadataTruthSourcePolicy = require('./MetadataTruthSourcePolicy');
const ObjectOntologyService = require('./ObjectOntologyService');

const GROUP_ARGUMENT_INSTANCE_OBJECT_TYPES = new Set([
  'PageFamily',
  'User',
  'ClientBusinessGroup',
  'OtherApp'
]);

const EXPLICIT_PROVIDER_BY_OBJECT_TYPE = Object.freeze({
  WebApplication: Object.freeze(ObjectOntologyService.resolveObjectInstanceProvider('WebApplication')),
  Application: Object.freeze(ObjectOntologyService.resolveObjectInstanceProvider('DefinedApp')),
  DefinedApp: Object.freeze(ObjectOntologyService.resolveObjectInstanceProvider('DefinedApp')),
  CompositeApplication: Object.freeze(ObjectOntologyService.resolveObjectInstanceProvider('CompositeApplication')),
  BuiltinApplication: Object.freeze(ObjectOntologyService.resolveObjectInstanceProvider('BuiltinApplication')),
  BusinessGroup: Object.freeze(ObjectOntologyService.resolveObjectInstanceProvider('BusinessGroup'))
});

function resolveObjectInstanceProvider(objectType = '') {
  const requestedObjectType = String(objectType || '').trim();
  if (!requestedObjectType) {
    return null;
  }

  const ontologyProvider = requestedObjectType === 'Application'
    ? ObjectOntologyService.resolveObjectInstanceProvider('DefinedApp')
    : ObjectOntologyService.resolveObjectInstanceProvider(requestedObjectType);
  const baseProvider = ontologyProvider
    || EXPLICIT_PROVIDER_BY_OBJECT_TYPE[requestedObjectType]
    || (GROUP_ARGUMENT_INSTANCE_OBJECT_TYPES.has(requestedObjectType)
      ? {
        effectiveObjectType: requestedObjectType,
        executionGroupType: requestedObjectType,
        providerType: 'groupArguments',
        apiType: 'groupArguments'
      }
      : null);

  if (!baseProvider) {
    return null;
  }

  return MetadataTruthSourcePolicy.buildTruthMetadata(
    MetadataTruthSourcePolicy.TRUTH_DOMAINS.OBJECT_INSTANCES,
    MetadataTruthSourcePolicy.SOURCES.SOUTHBOUND_LIVE_API,
    {
      requestedObjectType,
      effectiveObjectType: baseProvider.effectiveObjectType,
      executionGroupType: baseProvider.executionGroupType || baseProvider.effectiveObjectType,
      providerType: baseProvider.providerType,
      apiType: baseProvider.apiType,
      applicationTypeFilter: Array.isArray(baseProvider.applicationTypeFilter)
        ? baseProvider.applicationTypeFilter.slice()
        : null,
      applicationCatalogRole: baseProvider.applicationCatalogRole || null
    }
  );
}

module.exports = {
  GROUP_ARGUMENT_INSTANCE_OBJECT_TYPES,
  EXPLICIT_PROVIDER_BY_OBJECT_TYPE,
  resolveObjectInstanceProvider
};
