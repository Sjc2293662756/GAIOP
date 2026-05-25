const MetadataTruthSourcePolicy = require('./MetadataTruthSourcePolicy');

const GROUP_ARGUMENT_INSTANCE_OBJECT_TYPES = new Set([
  'PageFamily',
  'User',
  'ClientBusinessGroup',
  'OtherApp'
]);

const EXPLICIT_PROVIDER_BY_OBJECT_TYPE = Object.freeze({
  WebApplication: Object.freeze({
    effectiveObjectType: 'WebApplication',
    executionGroupType: 'WebApplication',
    providerType: 'applications',
    apiType: 'applications',
    applicationTypeFilter: Object.freeze([3]),
    applicationCatalogRole: 'web_business'
  }),
  Application: Object.freeze({
    effectiveObjectType: 'DefinedApp',
    executionGroupType: 'DefinedApp',
    providerType: 'applications',
    apiType: 'applications',
    applicationTypeFilter: Object.freeze([2]),
    applicationCatalogRole: 'defined_application'
  }),
  DefinedApp: Object.freeze({
    effectiveObjectType: 'DefinedApp',
    executionGroupType: 'DefinedApp',
    providerType: 'applications',
    apiType: 'applications',
    applicationTypeFilter: Object.freeze([2]),
    applicationCatalogRole: 'defined_application'
  }),
  CompositeApplication: Object.freeze({
    effectiveObjectType: 'CompositeApplication',
    executionGroupType: 'DefinedApp',
    providerType: 'applications',
    apiType: 'applications',
    applicationTypeFilter: Object.freeze([4]),
    applicationCatalogRole: 'composite_application'
  }),
  BuiltinApplication: Object.freeze({
    effectiveObjectType: 'BuiltinApplication',
    executionGroupType: 'DefinedApp',
    providerType: 'applications',
    apiType: 'applications',
    applicationTypeFilter: Object.freeze([1]),
    applicationCatalogRole: 'builtin_port_application'
  }),
  BusinessGroup: Object.freeze({
    effectiveObjectType: 'BusinessGroup',
    executionGroupType: 'BusinessGroup',
    providerType: 'businessGroups',
    apiType: 'businessGroups'
  })
});

function resolveObjectInstanceProvider(objectType = '') {
  const requestedObjectType = String(objectType || '').trim();
  if (!requestedObjectType) {
    return null;
  }

  const baseProvider = EXPLICIT_PROVIDER_BY_OBJECT_TYPE[requestedObjectType]
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
