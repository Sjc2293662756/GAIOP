#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  inspectNapmSkillRuntimeContracts
} = require('../plugin/NapmSkillRuntimeContract');

const QUERY_SKILL_DIR = 'openclaw-napm-query';
const RESOLUTION_SPEC_NAME = 'napm-resolution-spec.v1.json';
const OBJECT_ONTOLOGY_NAME = 'object-ontology.v1.json';
const METRIC_CATALOG_NAME = 'metrics-config.yml';
const EXECUTION_OWNERSHIP_FIELDS = Object.freeze([
  'ownershipRules',
  'ownershipMatrix',
  'compatibleObjectTypes',
  'preferredObjectTypes',
  'ownershipClass'
]);

function resolveContractRoots(options = {}) {
  const skillsRoot = path.resolve(
    options.skillsRoot
    || process.env.OPENCLAW_SKILLS_ROOT
    || path.resolve(__dirname, '..', 'skills')
  );
  const workspaceRoot = path.resolve(options.workspaceRoot || path.dirname(skillsRoot));
  return { workspaceRoot, skillsRoot };
}

function listSkillConfigFiles(skillsRoot, fileName) {
  if (!fs.existsSync(skillsRoot)) {
    return [];
  }

  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsRoot, entry.name, 'config', fileName))
    .filter((candidate) => fs.existsSync(candidate));
}

function inspectUniqueSkillConfig({
  contract,
  workspaceRoot,
  skillsRoot,
  fileName
}) {
  const canonicalPath = path.join(skillsRoot, QUERY_SKILL_DIR, 'config', fileName);
  const rootPath = path.join(workspaceRoot, 'config', fileName);
  const candidates = [
    ...(fs.existsSync(rootPath) ? [rootPath] : []),
    ...listSkillConfigFiles(skillsRoot, fileName)
  ];
  const duplicatePaths = candidates.filter((candidate) => (
    path.normalize(candidate) !== path.normalize(canonicalPath)
  ));
  const canonicalExists = fs.existsSync(canonicalPath);

  return {
    contract,
    ok: canonicalExists && duplicatePaths.length === 0,
    canonicalPath,
    canonicalExists,
    duplicatePaths,
    reason: !canonicalExists
      ? 'CANONICAL_SOURCE_MISSING'
      : (duplicatePaths.length > 0 ? 'DUPLICATE_SOURCE_FOUND' : null)
  };
}

function inspectOwnershipUniqueness({ workspaceRoot, skillsRoot }) {
  const canonicalPath = path.join(
    skillsRoot,
    QUERY_SKILL_DIR,
    'src',
    'constants',
    'objectMetricOwnership.js'
  );
  const rootPath = path.join(workspaceRoot, 'src', 'constants', 'objectMetricOwnership.js');
  const canonicalExists = fs.existsSync(canonicalPath);
  const rootExists = fs.existsSync(rootPath);
  let rootStatus = 'absent';

  if (rootExists) {
    const rootSource = fs.readFileSync(rootPath, 'utf8');
    const isThinReExport = /module\.exports\s*=\s*require\(\s*['"]\.\.\/\.\.\/skills\/openclaw-napm-query\/src\/constants\/objectMetricOwnership['"]\s*\)/.test(rootSource)
      && !/\b(?:BUSINESS|NON_BUSINESS)_OBJECT_TYPES\b/.test(rootSource);
    rootStatus = isThinReExport ? 'thin_re_export' : 'independent_source';
  }

  return {
    contract: 'ownership_uniqueness',
    ok: canonicalExists && rootStatus !== 'independent_source',
    canonicalPath,
    canonicalExists,
    rootPath,
    rootStatus,
    reason: !canonicalExists
      ? 'CANONICAL_SOURCE_MISSING'
      : (rootStatus === 'independent_source' ? 'ROOT_OWNERSHIP_IS_INDEPENDENT_SOURCE' : null)
  };
}

function inspectNoRuntimeMetricFallback({ skillsRoot }) {
  const servicePath = path.join(
    skillsRoot,
    QUERY_SKILL_DIR,
    'services',
    'MetricMappingService.js'
  );
  if (!fs.existsSync(servicePath)) {
    return {
      contract: 'no_runtime_metric_fallback',
      ok: false,
      servicePath,
      reason: 'METRIC_MAPPING_SERVICE_MISSING'
    };
  }

  const source = fs.readFileSync(servicePath, 'utf8');
  const forbiddenPatterns = [
    /\bloadDefaultMetrics\b/,
    /\bdefaultMetrics\b/,
    /loading\s+default\s+metrics/i
  ];
  const matchedPatterns = forbiddenPatterns
    .filter((pattern) => pattern.test(source))
    .map((pattern) => pattern.source);

  return {
    contract: 'no_runtime_metric_fallback',
    ok: matchedPatterns.length === 0,
    servicePath,
    matchedPatterns,
    reason: matchedPatterns.length > 0 ? 'RUNTIME_METRIC_FALLBACK_FOUND' : null
  };
}

function listJavaScriptFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJavaScriptFiles(candidate));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(candidate);
    }
  }
  return files;
}

function inspectResolutionOwnershipDeprecation({ workspaceRoot, skillsRoot }) {
  const querySkillRoot = path.join(skillsRoot, QUERY_SKILL_DIR);
  const specPath = path.join(querySkillRoot, 'config', RESOLUTION_SPEC_NAME);
  let deprecation = null;
  let parseError = null;

  try {
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    deprecation = spec?.metrics?.executionOwnershipDeprecation || null;
  } catch (error) {
    parseError = error?.message || String(error);
  }

  const executionFiles = [
    ...listJavaScriptFiles(path.join(querySkillRoot, 'services')),
    ...listJavaScriptFiles(path.join(querySkillRoot, 'scripts')),
    ...listJavaScriptFiles(path.join(workspaceRoot, 'plugin')),
    ...(fs.existsSync(path.join(workspaceRoot, 'napm-openclaw-plugin.remote.js'))
      ? [path.join(workspaceRoot, 'napm-openclaw-plugin.remote.js')]
      : [])
  ].filter((filePath) => path.basename(filePath) !== 'ResolutionSpecService.js');
  const forbiddenConsumers = [];

  executionFiles.forEach((filePath) => {
    const source = fs.readFileSync(filePath, 'utf8');
    const fields = EXECUTION_OWNERSHIP_FIELDS.filter((field) => source.includes(field));
    if (fields.length > 0) {
      forbiddenConsumers.push({ filePath, fields });
    }
  });

  const markerValid = deprecation?.status === 'deprecated'
    && deprecation?.canonicalRuntimeSource === 'src/constants/objectMetricOwnership.js'
    && deprecation?.forbiddenForNewExecutionAdmission === true
    && EXECUTION_OWNERSHIP_FIELDS.every((field) => (
      Array.isArray(deprecation?.legacyFields)
      && deprecation.legacyFields.some((entry) => String(entry).includes(field))
    ));

  return {
    contract: 'resolution_spec_execution_ownership_deprecated',
    ok: !parseError && markerValid && forbiddenConsumers.length === 0,
    specPath,
    markerValid,
    forbiddenConsumers,
    parseError,
    reason: parseError
      ? 'RESOLUTION_SPEC_INVALID'
      : (!markerValid
        ? 'OWNERSHIP_DEPRECATION_MARKER_MISSING'
        : (forbiddenConsumers.length > 0 ? 'NEW_EXECUTION_OWNERSHIP_CONSUMER_FOUND' : null))
  };
}

function inspectNapmTruthSourceContracts(options = {}) {
  const { workspaceRoot, skillsRoot } = resolveContractRoots(options);

  return [
    inspectUniqueSkillConfig({
      contract: 'resolution_spec_uniqueness',
      workspaceRoot,
      skillsRoot,
      fileName: RESOLUTION_SPEC_NAME
    }),
    inspectUniqueSkillConfig({
      contract: 'object_ontology_uniqueness',
      workspaceRoot,
      skillsRoot,
      fileName: OBJECT_ONTOLOGY_NAME
    }),
    inspectOwnershipUniqueness({ workspaceRoot, skillsRoot }),
    inspectUniqueSkillConfig({
      contract: 'metric_catalog_uniqueness',
      workspaceRoot,
      skillsRoot,
      fileName: METRIC_CATALOG_NAME
    }),
    inspectNoRuntimeMetricFallback({ skillsRoot }),
    inspectResolutionOwnershipDeprecation({ workspaceRoot, skillsRoot })
  ];
}

function readSource(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function inspectNapmSemanticContracts(options = {}) {
  const { workspaceRoot, skillsRoot } = resolveContractRoots(options);
  const querySkillRoot = path.join(skillsRoot, QUERY_SKILL_DIR);
  const specPath = path.join(querySkillRoot, 'config', RESOLUTION_SPEC_NAME);
  const metricCatalogPath = path.join(querySkillRoot, 'config', METRIC_CATALOG_NAME);
  const normalizerPath = path.join(querySkillRoot, 'services', 'MetricSemanticNormalizerService.js');
  const rankingParserPath = path.join(querySkillRoot, 'services', 'RankingIntentParserService.js');
  const resolverPath = path.join(querySkillRoot, 'services', 'NapmResolvedQueryResolverService.js');
  const workflowPath = path.join(querySkillRoot, 'services', 'WorkflowClassifierService.js');
  const tagNormalizerPath = path.join(querySkillRoot, 'services', 'TagNormalizer.js');

  let spec = null;
  let catalog = null;
  let parseError = null;
  try {
    spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    catalog = yaml.load(fs.readFileSync(metricCatalogPath, 'utf8'));
  } catch (error) {
    parseError = error?.message || String(error);
  }

  const configCandidates = [
    ...(fs.existsSync(path.join(workspaceRoot, 'config', RESOLUTION_SPEC_NAME))
      ? [path.join(workspaceRoot, 'config', RESOLUTION_SPEC_NAME)]
      : []),
    ...listSkillConfigFiles(skillsRoot, RESOLUTION_SPEC_NAME)
  ];
  const semanticSources = [];
  const rankingSources = [];
  configCandidates.forEach((candidate) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (parsed?.metricSemanticRules) semanticSources.push(candidate);
      if (parsed?.rankingGrammar) rankingSources.push(candidate);
    } catch (_error) {
      // Invalid canonical JSON is reported by parseError and the source checks.
    }
  });

  const normalizerSource = readSource(normalizerPath);
  const rankingParserSource = readSource(rankingParserPath);
  const resolverSource = readSource(resolverPath);
  const workflowSource = readSource(workflowPath);
  const tagNormalizerSource = readSource(tagNormalizerPath);
  const aliasesDeprecation = spec?.metrics?.semanticAliasesDeprecation;
  const semanticLifecycleStatuses = ['RESOLVED', 'AMBIGUOUS', 'UNRESOLVED', 'UNSUPPORTED'];
  const lifecycleDefinitionPaths = listJavaScriptFiles(path.join(querySkillRoot, 'services'))
    .filter((filePath) => /const\s+SEMANTIC_STATUS\s*=/.test(readSource(filePath)));
  const lifecycleEnumBody = workflowSource.match(
    /const\s+SEMANTIC_STATUS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\);/
  )?.[1] || '';
  const lifecycleEnumValues = [...lifecycleEnumBody.matchAll(/:\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1]);
  const lifecycleEnumValid = lifecycleEnumValues.length === semanticLifecycleStatuses.length
    && semanticLifecycleStatuses.every((status) => lifecycleEnumValues.includes(status));
  const lifecycleFieldsPresent = [
    /status:\s*lifecycle\.status/,
    /ambiguities:\s*lifecycle\.ambiguities/,
    /unresolvedSlots:\s*lifecycle\.unresolvedSlots/,
    /reasonCode:\s*lifecycle\.reasonCode/
  ].every((pattern) => pattern.test(workflowSource));
  const resolverStatusGuardValid = /Object\.values\(SEMANTIC_STATUS\)\.includes\(semanticContract\.status\)/
    .test(resolverSource)
    && resolverSource.indexOf('if (semanticContract.status === SEMANTIC_STATUS.AMBIGUOUS)') >= 0
    && resolverSource.indexOf('if (semanticContract.status === SEMANTIC_STATUS.UNRESOLVED)') >= 0
    && resolverSource.indexOf('if (semanticContract.status === SEMANTIC_STATUS.UNSUPPORTED)') >= 0
    && resolverSource.indexOf('if (semanticContract.status === SEMANTIC_STATUS.AMBIGUOUS)')
      < resolverSource.indexOf("if (semanticContract.operation === 'rank_top')")
    && !/defaultTargetObjectType/.test(resolverSource);
  const semanticFailureNullsDraft = /function\s+semanticFailure[\s\S]*?queryDraft:\s*null,[\s\S]*?resolvedQuery:\s*null/
    .test(resolverSource);
  const nonResolvedBranchesFailClosed = [
    'AMBIGUOUS',
    'UNRESOLVED',
    'UNSUPPORTED'
  ].every((status) => new RegExp(
    `semanticContract\\.status === SEMANTIC_STATUS\\.${status}\\)[\\s\\S]{0,700}return semanticFailure`
  ).test(resolverSource));

  const ruleMetricIds = Array.isArray(spec?.metricSemanticRules?.rules)
    ? spec.metricSemanticRules.rules.map((rule) => String(rule?.metricId || '').trim()).filter(Boolean)
    : [];
  const catalogIds = new Set(
    (Array.isArray(catalog?.metrics) ? catalog.metrics : [])
      .map((metric) => String(metric?.code || '').trim())
      .filter(Boolean)
  );
  const invalidRuleMetricIds = [...new Set(ruleMetricIds.filter((metricId) => !catalogIds.has(metricId)))];

  const resolverForbidden = [
    /function\s+inferMetric\b/,
    /function\s+isRankingPrompt\b/,
    /function\s+inferTopCount\b/,
    /function\s+inferDirection\b/,
    /metrics(?:\?\.|\.)aliases/,
    /metrics\[['"]aliases['"]\]/
  ].filter((pattern) => pattern.test(resolverSource)).map((pattern) => pattern.source);
  const workflowForbidden = [
    /function\s+hasRankingIntent\b/,
    /function\s+inferMetric\b/
  ].filter((pattern) => pattern.test(workflowSource)).map((pattern) => pattern.source);
  const tagForbidden = [
    /\bMETRIC_CODE_MAP\b/,
    /\bconst\s+resolvedQuery\b/,
    /return\s*\{\s*ok:\s*true,\s*resolvedQuery/
  ].filter((pattern) => pattern.test(tagNormalizerSource)).map((pattern) => pattern.source);

  return [
    {
      contract: 'single_metric_semantic_source',
      ok: !parseError
        && semanticSources.length === 1
        && path.normalize(semanticSources[0]) === path.normalize(specPath)
        && aliasesDeprecation?.status === 'deprecated'
        && aliasesDeprecation?.canonicalMachineSource === 'metricSemanticRules'
        && aliasesDeprecation?.forbiddenForProductionMatching === true
        && /getMetricSemanticRules/.test(normalizerSource)
        && !/specMetricAliases|resolveFromSpecAliases/.test(normalizerSource),
      semanticSources,
      parseError,
      reason: parseError ? 'SEMANTIC_SPEC_INVALID' : null
    },
    {
      contract: 'semantic_rule_metric_ids_valid',
      ok: !parseError && ruleMetricIds.length > 0 && invalidRuleMetricIds.length === 0,
      ruleMetricIds,
      invalidRuleMetricIds,
      reason: invalidRuleMetricIds.length > 0 ? 'SEMANTIC_RULE_METRIC_NOT_IN_CATALOG' : null
    },
    {
      contract: 'single_ranking_grammar_source',
      ok: !parseError
        && rankingSources.length === 1
        && path.normalize(rankingSources[0]) === path.normalize(specPath)
        && /getRankingGrammar/.test(rankingParserSource),
      rankingSources,
      reason: rankingSources.length !== 1 ? 'RANKING_GRAMMAR_SOURCE_COUNT_INVALID' : null
    },
    {
      contract: 'resolver_no_private_semantic_inference',
      ok: resolverForbidden.length === 0,
      resolverPath,
      matchedPatterns: resolverForbidden,
      reason: resolverForbidden.length > 0 ? 'PRIVATE_RESOLVER_SEMANTIC_INFERENCE_FOUND' : null
    },
    {
      contract: 'workflow_classifier_no_private_ranking_parser',
      ok: workflowForbidden.length === 0 && /RankingIntentParserService/.test(workflowSource),
      workflowPath,
      matchedPatterns: workflowForbidden,
      reason: workflowForbidden.length > 0 ? 'PRIVATE_WORKFLOW_RANKING_PARSER_FOUND' : null
    },
    {
      contract: 'tag_normalizer_no_query_construction',
      ok: tagForbidden.length === 0,
      tagNormalizerPath,
      matchedPatterns: tagForbidden,
      reason: tagForbidden.length > 0 ? 'TAG_NORMALIZER_QUERY_CONSTRUCTION_FOUND' : null
    },
    {
      contract: 'semantic_lifecycle_enum',
      ok: lifecycleDefinitionPaths.length === 1
        && path.normalize(lifecycleDefinitionPaths[0]) === path.normalize(workflowPath)
        && lifecycleEnumValid,
      allowedStatuses: semanticLifecycleStatuses,
      actualStatuses: lifecycleEnumValues,
      definitionPaths: lifecycleDefinitionPaths,
      reason: lifecycleDefinitionPaths.length !== 1
        ? 'SEMANTIC_LIFECYCLE_SOURCE_COUNT_INVALID'
        : (!lifecycleEnumValid ? 'SEMANTIC_LIFECYCLE_ENUM_INVALID' : null)
    },
    {
      contract: 'semantic_contract_lifecycle_fields',
      ok: lifecycleFieldsPresent,
      workflowPath,
      reason: lifecycleFieldsPresent ? null : 'SEMANTIC_LIFECYCLE_FIELDS_MISSING'
    },
    {
      contract: 'resolver_semantic_status_guard',
      ok: resolverStatusGuardValid,
      resolverPath,
      reason: resolverStatusGuardValid ? null : 'SEMANTIC_STATUS_GUARD_MISSING'
    },
    {
      contract: 'non_resolved_semantic_no_query_draft',
      ok: semanticFailureNullsDraft && nonResolvedBranchesFailClosed,
      resolverPath,
      reason: semanticFailureNullsDraft && nonResolvedBranchesFailClosed
        ? null
        : 'NON_RESOLVED_SEMANTIC_DRAFT_GUARD_MISSING'
    }
  ];
}

function inspectNapmResolvedQueryContracts(options = {}) {
  const { workspaceRoot, skillsRoot } = resolveContractRoots(options);
  const querySkillRoot = path.join(skillsRoot, QUERY_SKILL_DIR);
  const servicesRoot = path.join(querySkillRoot, 'services');
  const contractPath = path.join(servicesRoot, 'ResolvedQueryContract.js');
  const adapterPath = path.join(servicesRoot, 'LegacyMetricInputAdapter.js');
  const resolverPath = path.join(servicesRoot, 'NapmResolvedQueryResolverService.js');
  const validatorPath = path.join(servicesRoot, 'QueryValidator.js');
  const metadataConstraintPath = path.join(servicesRoot, 'QueryMetadataConstraintService.js');
  const pluginPath = path.join(workspaceRoot, 'napm-openclaw-plugin.remote.js');
  const serviceFiles = listJavaScriptFiles(servicesRoot);
  const schemaDefinitionPaths = serviceFiles.filter((filePath) => (
    /const\s+RESOLVED_QUERY_SCHEMA_VERSION\s*=/.test(readSource(filePath))
  ));
  const serviceContractDefinitionPaths = serviceFiles.filter((filePath) => (
    /const\s+SERVICE_CONTRACTS\s*=/.test(readSource(filePath))
  ));
  const contractSource = readSource(contractPath);
  const adapterSource = readSource(adapterPath);
  const resolverSource = readSource(resolverPath);
  const validatorSource = readSource(validatorPath);
  const metadataConstraintSource = readSource(metadataConstraintPath);
  const pluginSource = readSource(pluginPath);

  let contractModule = null;
  let adapterModule = null;
  let moduleError = null;
  try {
    contractModule = require(contractPath);
    adapterModule = require(adapterPath);
  } catch (error) {
    moduleError = error?.message || String(error);
  }

  const baseTopQuery = {
    schemaVersion: 'napm-resolved-query.v1',
    service: 'topValues',
    groups: [{ type: 'IPAddress' }],
    metrics: ['TPI', 'TPO'],
    topMetric: 'TPIO',
    topCount: 10,
    start: 1788937200,
    end: 1788940800
  };
  const topIndependentResult = contractModule?.validateShape(baseTopQuery) || null;
  const metricForbiddenResults = ['topValues', 'averageValues', 'timeValues', 'pageViews']
    .map((service) => {
      const query = service === 'topValues'
        ? { ...baseTopQuery, metric: 'TPIO' }
        : service === 'averageValues'
          ? {
              schemaVersion: 'napm-resolved-query.v1',
              service,
              groups: [{ type: 'IPAddress' }],
              metrics: ['TPIO'],
              metric: 'TPIO',
              start: 1788937200,
              end: 1788940800
            }
          : service === 'timeValues'
            ? {
                schemaVersion: 'napm-resolved-query.v1',
                service,
                groups: [{ type: 'IPAddress' }],
                metrics: ['TPIO'],
                metric: 'TPIO',
                granularity: 300,
                start: 1788937200,
                end: 1788940800
              }
            : {
                schemaVersion: 'napm-resolved-query.v1',
                service,
                metric: 'PGTME',
                pageFamilyId: '8573007',
                start: 1788937200,
                end: 1788940800
              };
      return { service, result: contractModule?.validateShape(query) || null };
    });
  const adapterResult = adapterModule?.adapt({
    service: 'topValues',
    groups: [{ type: 'IPAddress' }],
    metric: 'TPIO',
    topCount: 10,
    start: 1788937200,
    end: 1788940800
  }) || null;

  return [
    {
      contract: 'single_resolved_query_contract_source',
      ok: !moduleError
        && schemaDefinitionPaths.length === 1
        && path.normalize(schemaDefinitionPaths[0]) === path.normalize(contractPath)
        && serviceContractDefinitionPaths.length === 1
        && path.normalize(serviceContractDefinitionPaths[0]) === path.normalize(contractPath),
      schemaDefinitionPaths,
      serviceContractDefinitionPaths,
      moduleError,
      reason: moduleError || null
    },
    {
      contract: 'canonical_query_forbids_metric',
      ok: metricForbiddenResults.every(({ result }) => (
        result?.ok === false && result?.reasonCode === 'METRIC_FORBIDDEN'
      )),
      results: metricForbiddenResults,
      reason: null
    },
    {
      contract: 'top_metric_independent_from_metrics',
      ok: topIndependentResult?.ok === true
        && topIndependentResult?.query?.topMetric === 'TPIO'
        && !topIndependentResult?.query?.metrics?.includes('TPIO')
        && !/top_metric_not_in_metrics/.test(pluginSource)
        && !/metrics\.includes\([^)]*topMetric/.test(contractSource),
      reason: null
    },
    {
      contract: 'query_validator_uses_shared_contract',
      ok: /require\(['"]\.\/ResolvedQueryContract['"]\)/.test(validatorSource)
        && /ResolvedQueryContract\.validateShape/.test(validatorSource)
        && !/Metric is required for topValues service/.test(validatorSource),
      reason: null
    },
    {
      contract: 'plugin_uses_shared_contract',
      ok: /napmResolvedQueryContract/.test(pluginSource)
        && /canonicalServiceContract/.test(pluginSource)
        && !/top_metric_not_in_metrics/.test(pluginSource),
      reason: null
    },
    {
      contract: 'resolver_emits_canonical_query',
      ok: /ResolvedQueryContract\.RESOLVED_QUERY_SCHEMA_VERSION/.test(resolverSource)
        && /metrics,\s*\n\s*topMetric:\s*rankingMetric/.test(resolverSource)
        && !/metric:\s*resolvedQuery\.metric/.test(resolverSource),
      reason: null
    },
    {
      contract: 'semantic_path_skips_legacy_adapter',
      ok: !/LegacyMetricInputAdapter/.test(resolverSource),
      reason: null
    },
    {
      contract: 'legacy_adapter_canonical_output',
      ok: adapterResult?.ok === true
        && adapterResult?.adapted === true
        && adapterResult?.query?.schemaVersion === 'napm-resolved-query.v1'
        && !Object.prototype.hasOwnProperty.call(adapterResult?.query || {}, 'metric')
        && /delete\s+candidate\.metric/.test(adapterSource),
      reason: null
    },
    {
      contract: 'metadata_constraint_no_metric_derivation',
      ok: !/query\.metric\s*=/.test(metadataConstraintSource)
        && !/derive_from_metrics/.test(metadataConstraintSource),
      reason: null
    }
  ];
}

function inspectNapmPhase4ExecutableContracts(options = {}) {
  const { workspaceRoot, skillsRoot } = resolveContractRoots(options);
  const querySkillRoot = path.join(skillsRoot, QUERY_SKILL_DIR);
  const servicesRoot = path.join(querySkillRoot, 'services');
  const validatorPath = path.join(servicesRoot, 'ResolvedQueryExecutableValidator.js');
  const ownershipPath = path.join(querySkillRoot, 'src', 'constants', 'objectMetricOwnership.js');
  const policyPath = path.join(servicesRoot, 'QueryDecisionPolicy.js');
  const requirementParserPath = path.join(servicesRoot, 'RequirementParserService.js');
  const querySkillPath = path.join(querySkillRoot, 'scripts', 'run_napm_query.js');
  const pluginPath = path.join(workspaceRoot, 'napm-openclaw-plugin.remote.js');
  const validatorSource = readSource(validatorPath);
  const ownershipSource = readSource(ownershipPath);
  const policySource = readSource(policyPath);
  const requirementParserSource = readSource(requirementParserPath);
  const querySkillSource = readSource(querySkillPath);
  const pluginSource = readSource(pluginPath);

  let ownershipModule = null;
  let validatorModule = null;
  let policyModule = null;
  let moduleError = null;
  try {
    ownershipModule = require(ownershipPath);
    validatorModule = require(validatorPath);
    policyModule = require(policyPath);
  } catch (error) {
    moduleError = error?.message || String(error);
  }

  const requiredCoverage = [
    ...['topValues', 'averageValues', 'timeValues'].flatMap((service) => (
      ['WebApplication', 'IPAddress', 'TotalTraffic', 'DefinedApp']
        .map((groupPathSignature) => ({ service, groupPathSignature }))
    ))
  ];
  const coverage = Array.isArray(ownershipModule?.OBJECT_METRIC_COVERAGE)
    ? ownershipModule.OBJECT_METRIC_COVERAGE
    : [];
  const coverageMatches = requiredCoverage.map((required) => ({
    ...required,
    entry: coverage.find((candidate) => (
      candidate?.service === required.service
      && candidate?.groupPathSignature === required.groupPathSignature
    )) || null
  }));
  const coverageComplete = coverageMatches.every(({ entry }) => (
    entry?.supportedProductBaseline
      && entry?.exhaustive === true
      && Array.isArray(entry?.allowedMetricIds)
      && entry.allowedMetricIds.length > 0
  ));

  const unknownQuery = {
    schemaVersion: 'napm-resolved-query.v1',
    service: 'topValues',
    groups: [{ type: 'WebApplication' }],
    metrics: ['PGTME'],
    topMetric: 'PGTME',
    topCount: 5,
    start: 1788937200,
    end: 1788940800
  };
  let unknownValidation = null;
  let unknownDecision = null;
  if (!moduleError) {
    unknownValidation = validatorModule.validate(unknownQuery, { productBaseline: '' });
    unknownDecision = policyModule.evaluateQueryDecision({
      queryDraft: unknownQuery,
      executableValidationContext: { productBaseline: '' }
    });
  }

  const orderedCall = (source, beforePattern, afterPattern) => {
    const before = source.indexOf(beforePattern);
    const after = source.indexOf(afterPattern);
    return before >= 0 && after >= 0 && before < after;
  };

  return [
    {
      contract: 'phase4_validator_single_entry',
      ok: !moduleError
        && /ResolvedQueryContract/.test(validatorSource)
        && /ResolvedQueryContract\.validateShape/.test(validatorSource)
        && /MetricMappingService\.isValidMetricCode/.test(validatorSource)
        && /classifyObjectMetricCompatibility/.test(validatorSource)
        && /RUNTIME_CAPABILITY_REQUIRED/.test(validatorSource),
      validatorPath,
      moduleError,
      reason: moduleError ? 'PHASE4_VALIDATOR_MODULE_UNAVAILABLE' : null
    },
    {
      contract: 'phase4_ownership_coverage_complete',
      ok: !moduleError && coverageComplete,
      requiredCoverage,
      coverageMatches: coverageMatches.map(({ service, groupPathSignature, entry }) => ({
        service,
        groupPathSignature,
        exhaustive: entry?.exhaustive || false,
        metricCount: entry?.allowedMetricIds?.length || 0,
        supportedProductBaseline: entry?.supportedProductBaseline || null
      })),
      reason: coverageComplete ? null : 'PHASE4_OWNERSHIP_COVERAGE_INCOMPLETE'
    },
    {
      contract: 'phase4_gateway_and_direct_static_gate',
      ok: /validateExecutableQueryAtBoundary/.test(requirementParserSource)
        && /prepareGatewayExecution/.test(requirementParserSource)
        && /executeDirectGatewayRequest/.test(requirementParserSource)
        && orderedCall(requirementParserSource, 'validateExecutableQueryAtBoundary(normalizedQuery)', 'const metadataReview = await this.reviewGatewayRequestMetadata')
        && orderedCall(requirementParserSource, 'validateExecutableQueryAtBoundary(passthroughGatewayRequest)', 'const response ='),
      reason: null
    },
    {
      contract: 'phase4_unknown_capability_fails_closed_before_execution',
      ok: unknownValidation?.status === 'UNKNOWN'
        && unknownValidation?.reasonCode === 'RUNTIME_CAPABILITY_REQUIRED'
        && unknownDecision?.action === 'RUNTIME_CONFIRMATION_REQUIRED'
        && unknownDecision?.southboundAllowed === false
        && /executableValidation\.status === 'UNKNOWN'/.test(policySource)
        && /return runtimeConfirmationDecision/.test(policySource)
        && /RequirementParserService\.executeGatewayRequest/.test(querySkillSource)
        && /validatePreparedResolvedQuery/.test(pluginSource),
      unknownValidation,
      unknownDecision,
      reason: unknownValidation?.status === 'UNKNOWN'
        && unknownDecision?.action === 'RUNTIME_CONFIRMATION_REQUIRED'
        ? null
        : 'PHASE4_UNKNOWN_CAPABILITY_GATE_MISSING'
    },
    {
      contract: 'phase4_plugin_gate_precedes_skill_execution',
      ok: /evaluatePluginQueryDecision/.test(pluginSource)
        && /southboundAllowed:\s*false/.test(pluginSource)
        && /QUERY_OUTCOMES\.VALIDATION_FAILURE/.test(pluginSource)
        && /handleSkillCall/.test(pluginSource),
      pluginPath,
      reason: null
    }
  ];
}

function run() {
  const { workspaceRoot, skillsRoot } = resolveContractRoots();
  const results = inspectNapmSkillRuntimeContracts(skillsRoot, { reload: true });
  const truthSourceResults = inspectNapmTruthSourceContracts({ workspaceRoot, skillsRoot });
  const semanticContractResults = inspectNapmSemanticContracts({ workspaceRoot, skillsRoot });
  const resolvedQueryContractResults = inspectNapmResolvedQueryContracts({ workspaceRoot, skillsRoot });
  const phase4ExecutableContractResults = inspectNapmPhase4ExecutableContracts({ workspaceRoot, skillsRoot });
  const ok = results.every((result) => result.ok)
    && truthSourceResults.every((result) => result.ok)
    && semanticContractResults.every((result) => result.ok)
    && resolvedQueryContractResults.every((result) => result.ok)
    && phase4ExecutableContractResults.every((result) => result.ok);

  process.stdout.write(`${JSON.stringify({
    ok,
    workspaceRoot,
    skillsRoot,
    results,
    truthSourceResults,
    semanticContractResults,
    resolvedQueryContractResults,
    phase4ExecutableContractResults
  }, null, 2)}\n`);

  if (!ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  EXECUTION_OWNERSHIP_FIELDS,
  inspectNapmTruthSourceContracts,
  inspectNapmSemanticContracts,
  inspectNapmResolvedQueryContracts,
  inspectNapmPhase4ExecutableContracts,
  run
};
