const ObjectOntologyService = require('../skills/openclaw-napm-query/services/ObjectOntologyService');
const ObjectMetadataRegistry = require('../skills/openclaw-napm-query/services/ObjectMetadataRegistry');
const {
  classifyApplicationCatalogPrompt
} = require('../skills/openclaw-napm-query/services/ApplicationCatalogSemanticRules');

describe('ObjectOntologyService', () => {
  afterEach(() => {
    ObjectOntologyService.clearCache();
  });

  test('should resolve BusinessGroup ontology provider', () => {
    expect(ObjectOntologyService.resolveObjectInstanceProvider('BusinessGroup')).toMatchObject({
      effectiveObjectType: 'BusinessGroup',
      executionGroupType: 'BusinessGroup',
      providerType: 'businessGroups',
      apiType: 'businessGroups'
    });
  });

  test('should resolve application catalog Type filters from ontology', () => {
    expect(ObjectOntologyService.resolveObjectInstanceProvider('WebApplication')).toMatchObject({
      providerType: 'applications',
      applicationTypeFilter: [3],
      applicationCatalogRole: 'web_business'
    });
    expect(ObjectOntologyService.resolveObjectInstanceProvider('DefinedApp')).toMatchObject({
      providerType: 'applications',
      applicationTypeFilter: [2],
      applicationCatalogRole: 'defined_application'
    });
    expect(ObjectOntologyService.resolveObjectInstanceProvider('CompositeApplication')).toMatchObject({
      providerType: 'applications',
      applicationTypeFilter: [4],
      applicationCatalogRole: 'composite_application'
    });
    expect(ObjectOntologyService.resolveObjectInstanceProvider('BuiltinApplication')).toMatchObject({
      providerType: 'applications',
      applicationTypeFilter: [1],
      applicationCatalogRole: 'builtin_port_application'
    });
  });

  test('should keep ObjectMetadataRegistry backed by ontology bindings', () => {
    expect(ObjectMetadataRegistry.resolveObjectInstanceProvider('BusinessGroup')).toMatchObject({
      requestedObjectType: 'BusinessGroup',
      effectiveObjectType: 'BusinessGroup',
      providerType: 'businessGroups'
    });
    expect(ObjectMetadataRegistry.resolveObjectInstanceProvider('CompositeApplication')).toMatchObject({
      requestedObjectType: 'CompositeApplication',
      effectiveObjectType: 'CompositeApplication',
      providerType: 'applications',
      applicationTypeFilter: [4]
    });
  });

  test('should classify object text from ontology aliases', () => {
    expect(ObjectOntologyService.classifyObjectText('系统都有哪些工作组')).toMatchObject({
      objectType: 'BusinessGroup',
      ambiguous: false
    });
    expect(ObjectOntologyService.classifyObjectText('系统中有哪些自动识别的应用')).toMatchObject({
      objectType: 'CompositeApplication',
      ambiguous: false
    });
  });

  test('should expose plain application ambiguity candidates from ontology', () => {
    expect(classifyApplicationCatalogPrompt('系统中有哪些应用')).toMatchObject({
      objectType: null,
      ambiguous: true,
      candidates: ['WebApplication', 'DefinedApp', 'BuiltinApplication', 'CompositeApplication', 'OtherApp']
    });
  });
});
