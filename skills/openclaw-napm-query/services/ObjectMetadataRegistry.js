const MetadataTruthSourcePolicy = require('./MetadataTruthSourcePolicy');

const GROUP_ARGUMENT_INSTANCE_OBJECT_TYPES = new Set([
  'WebApplication',
  'PageFamily',
  'User',
  'ClientBusinessGroup'
]);

const EXPLICIT_PROVIDER_BY_OBJECT_TYPE = Object.freeze({
  Application: Object.freeze({
    effectiveObjectType: 'DefinedApp',
    providerType: 'applications',
    apiType: 'applications'
  }),
  DefinedApp: Object.freeze({
    effectiveObjectType: 'DefinedApp',
    providerType: 'applications',
    apiType: 'applications'
  }),
  BusinessGroup: Object.freeze({
    effectiveObjectType: 'BusinessGroup',
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
      providerType: baseProvider.providerType,
      apiType: baseProvider.apiType
    }
  );
}

module.exports = {
  GROUP_ARGUMENT_INSTANCE_OBJECT_TYPES,
  EXPLICIT_PROVIDER_BY_OBJECT_TYPE,
  resolveObjectInstanceProvider
};
