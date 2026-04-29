/**
 * reference-runtime.js
 * Lightweight runtime knowledge module for skill decision and execution hints.
 */

const fs = require('fs');
const path = require('path');

const REFERENCES_DIR = path.resolve(__dirname, '..', 'references');
const FILES = {
  capability: 'capability-mapping.md',
  metrics: 'metric-definitions.md',
  groups: 'group-hierarchy.md',
  sourceIndex: 'source-index.md',
  serviceModes: 'service-modes.md',
  queryConstruction: 'query-construction.md',
  runtimeLookup: 'runtime-lookup-notes.md'
};

let cachedKnowledge = null;

function readReferenceFile(fileName) {
  const fullPath = path.join(REFERENCES_DIR, fileName);
  try {
    return fs.readFileSync(fullPath, 'utf8');
  } catch (_error) {
    return '';
  }
}

function stripReferenceArtifacts(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/:contentReference\[[^\]]+\]\{[^}]+\}/g, '')
    .replace(/\uFFFD/g, '')
    .trim();
}

function normalizeForMatch(text) {
  return stripReferenceArtifacts(text)
    .toLowerCase()
    .replace(/[()[\]{}:;,，。！？/\\|`"'<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  const normalized = normalizeForMatch(text);
  const matches = normalized.match(/[\u4e00-\u9fa5]{2,12}|[a-z0-9][a-z0-9._-]{1,31}/g) || [];
  return Array.from(new Set(matches));
}

function parseSections(markdown) {
  const lines = stripReferenceArtifacts(markdown).split('\n');
  const sections = [];
  let current = null;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{2,4})\s+(.+)$/);
    if (headingMatch) {
      if (current) {
        current.body = current.body.trim();
        sections.push(current);
      }
      current = {
        level: headingMatch[1].length,
        title: headingMatch[2].trim(),
        body: ''
      };
      continue;
    }

    if (!current) continue;
    current.body += `${line}\n`;
  }

  if (current) {
    current.body = current.body.trim();
    sections.push(current);
  }

  return sections;
}

function termsFromTitle(title) {
  const cleaned = String(title || '')
    .replace(/^\d+(\.\d+)*\s*/g, '')
    .replace(/[()（）]/g, ' ');
  return tokenize(cleaned);
}

function extractBulletTerms(markdown) {
  const lines = stripReferenceArtifacts(markdown).split('\n');
  const terms = [];

  for (const line of lines) {
    const bulletMatch = line.match(/^\s*-\s+(.+)$/);
    if (!bulletMatch) continue;

    const raw = bulletMatch[1].trim();
    const english = raw.match(/\b[A-Z][A-Za-z0-9]{2,31}\b/g) || [];
    const chinese = raw.match(/[\u4e00-\u9fa5]{2,12}/g) || [];
    terms.push(...english, ...chinese);
  }

  return Array.from(new Set(terms));
}

function extractGroupChainsFromDoc(markdown) {
  const text = stripReferenceArtifacts(markdown);
  const chains = [];
  const pattern = /\b([A-Z][A-Za-z0-9]+(?:\s*->\s*[A-Z][A-Za-z0-9]+){1,5})\b/g;

  let matched = pattern.exec(text);
  while (matched) {
    const chain = matched[1]
      .split(/\s*->\s*/)
      .map((segment) => String(segment || '').trim())
      .filter(Boolean);
    if (chain.length >= 2) {
      chains.push(chain);
    }
    matched = pattern.exec(text);
  }

  const seen = new Set();
  return chains.filter((chain) => {
    const key = chain.join('>');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildHintTermSet(rawDocs) {
  const groupTerms = extractBulletTerms(rawDocs.groups);
  const metricTerms = extractBulletTerms(rawDocs.metrics);
  const capabilityTerms = [
    ...extractBulletTerms(rawDocs.capability),
    ...extractBulletTerms(rawDocs.sourceIndex)
  ];

  for (const section of parseSections(rawDocs.groups)) {
    termsFromTitle(section.title).forEach((term) => groupTerms.push(term));
  }
  for (const section of parseSections(rawDocs.metrics)) {
    termsFromTitle(section.title).forEach((term) => metricTerms.push(term));
  }
  for (const section of parseSections(rawDocs.capability)) {
    termsFromTitle(section.title).forEach((term) => capabilityTerms.push(term));
  }

  return {
    groupTerms: Array.from(new Set(groupTerms)),
    metricTerms: Array.from(new Set(metricTerms)),
    capabilityTerms: Array.from(new Set(capabilityTerms))
  };
}

function loadKnowledge() {
  if (cachedKnowledge) return cachedKnowledge;

  const rawDocs = {};
  for (const [key, file] of Object.entries(FILES)) {
    rawDocs[key] = readReferenceFile(file);
  }

  const sections = {};
  for (const [key, value] of Object.entries(rawDocs)) {
    sections[key] = parseSections(value);
  }

  const termSet = buildHintTermSet(rawDocs);
  cachedKnowledge = { rawDocs, sections, termSet };
  return cachedKnowledge;
}

function pickStrongestHint(candidates, normalizedPrompt) {
  let best = null;
  for (const item of candidates) {
    if (!item?.term) continue;
    const normalizedTerm = normalizeForMatch(item.term);
    if (!normalizedTerm) continue;
    if (!normalizedPrompt.includes(normalizedTerm)) continue;
    const weight = Number(item.weight || 1);
    if (!best || weight > best.weight) {
      best = { key: item.key, term: item.term, weight };
    }
  }
  return best?.key || null;
}

function inferReferenceObjectType(normalizedPrompt) {
  if (!normalizedPrompt) return null;

  const businessGroupSignal = /(?:businessgroup|business\s*group|\u4e1a\u52a1\u7ec4|\u5de5\u4f5c\u7ec4|\u4e1a\u52a1\u5206\u7ec4)/i;
  const webBusinessSignal = /(?:\u4e1a\u52a1\u7cfb\u7edf|(?:^|[^a-z])\u4e1a\u52a1(?:[^\u7ec4\u5206]|$)|\u7f51\u7ad9|\u7ad9\u70b9|web\s*application|webapp|web\u5e94\u7528|\u9875\u9762\u5165\u53e3)/i;
  const applicationSignal = /(?:\u4e1a\u52a1\u5e94\u7528|(?:^|[^a-z])(application|app|\u5e94\u7528)(?:[^a-z]|$))/i;

  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(normalizedPrompt) || /(?:\bip\b|ipaddress)/i.test(normalizedPrompt)) return 'IPAddress';
  if (businessGroupSignal.test(normalizedPrompt)) return 'BusinessGroup';
  if (webBusinessSignal.test(normalizedPrompt)) return 'WebApplication';
  if (applicationSignal.test(normalizedPrompt)) return 'Application';
  return null;
}

function inferReferenceMetricDomain(normalizedPrompt) {
  if (!normalizedPrompt) return null;
  if (/(?:\u4e22\u5305|\u91cd\u4f20|rtt|\u6296\u52a8|pli|rtxi|rtti)/i.test(normalizedPrompt)) return 'network_quality';
  if (/(?:\u5ef6\u65f6|\u54cd\u5e94|\u6162|\u5361|trti|pgtme)/i.test(normalizedPrompt)) return 'latency';
  if (/(?:\u6d41\u91cf|\u541e\u5410|tpio|bytio|pkio|\u6570\u636e\u5305|\u5305\u6d41\u91cf|bandwidth|\u8bbf\u95ee\u6b21\u6570)/i.test(normalizedPrompt)) return 'traffic';
  if (/(?:\u9519\u8bef|\u5931\u8d25|5xx|500|4xx|400|pghttp500|pghttp400)/i.test(normalizedPrompt)) return 'error';
  return null;
}

function getReferenceSignals(prompt) {
  const knowledge = loadKnowledge();
  const normalizedPrompt = normalizeForMatch(prompt);
  if (!normalizedPrompt) {
    return {
      hasReferenceObjectSignal: false,
      hasReferenceMetricSignal: false,
      hasReferenceCapabilitySignal: false,
      strongestObjectHint: null,
      strongestMetricHint: null,
      matchedObjectTerms: [],
      matchedMetricTerms: [],
      matchedCapabilityTerms: []
    };
  }

  const matchedObjectTerms = knowledge.termSet.groupTerms.filter((term) => {
    const normalizedTerm = normalizeForMatch(term);
    return normalizedTerm && normalizedPrompt.includes(normalizedTerm);
  }).slice(0, 12);

  const matchedMetricTerms = knowledge.termSet.metricTerms.filter((term) => {
    const normalizedTerm = normalizeForMatch(term);
    return normalizedTerm && normalizedPrompt.includes(normalizedTerm);
  }).slice(0, 12);

  const matchedCapabilityTerms = knowledge.termSet.capabilityTerms.filter((term) => {
    const normalizedTerm = normalizeForMatch(term);
    return normalizedTerm && normalizedPrompt.includes(normalizedTerm);
  }).slice(0, 12);

  const strongestObjectHint = inferReferenceObjectType(normalizedPrompt) || pickStrongestHint([
    { key: 'WebApplication', term: '业务系统', weight: 3 },
    { key: 'WebApplication', term: '业务', weight: 2 },
    { key: 'WebApplication', term: 'WebApplication', weight: 3 },
    { key: 'BusinessGroup', term: '业务组', weight: 3 },
    { key: 'BusinessGroup', term: '工作组', weight: 3 },
    { key: 'Application', term: 'Application', weight: 2 },
    { key: 'IPAddress', term: 'IP地址', weight: 2 }
  ], normalizedPrompt);

  const strongestMetricHint = inferReferenceMetricDomain(normalizedPrompt);

  return {
    hasReferenceObjectSignal: Boolean(strongestObjectHint || matchedObjectTerms.length > 0),
    hasReferenceMetricSignal: Boolean(strongestMetricHint || matchedMetricTerms.length > 0),
    hasReferenceCapabilitySignal: matchedCapabilityTerms.length > 0,
    strongestObjectHint,
    strongestMetricHint,
    matchedObjectTerms,
    matchedMetricTerms,
    matchedCapabilityTerms
  };
}

function summarizeSection(section) {
  if (!section?.body) return [];
  return section.body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function buildConceptualAnswer(prompt) {
  const knowledge = loadKnowledge();
  const normalizedPrompt = normalizeForMatch(prompt);
  if (!normalizedPrompt) return null;

  const explainSignal = /(?:\u4ec0\u4e48\u610f\u601d|\u662f\u4ec0\u4e48|\u542b\u4e49|\u5b9a\u4e49|\u600e\u4e48\u7406\u89e3|explain|meaning)/i.test(prompt || '');
  if (!explainSignal) return null;

  const sectionPool = [
    ...(knowledge.sections.metrics || []),
    ...(knowledge.sections.groups || []),
    ...(knowledge.sections.capability || [])
  ];

  let best = null;
  for (const section of sectionPool) {
    const terms = termsFromTitle(section.title);
    const score = terms.reduce((sum, term) => {
      const normalizedTerm = normalizeForMatch(term);
      return sum + (normalizedTerm && normalizedPrompt.includes(normalizedTerm) ? 1 : 0);
    }, 0);
    if (!best || score > best.score) best = { section, score };
  }

  if (!best || best.score < 1) return null;
  const summaryLines = summarizeSection(best.section);
  if (summaryLines.length === 0) return null;

  return {
    title: best.section.title,
    text: [`参考技能知识库：${best.section.title}`, ...summaryLines].join('\n')
  };
}

function inferInventoryObjectType(normalizedPrompt) {
  return inferReferenceObjectType(normalizedPrompt);
}

function isMetadataInventoryIntent(normalizedPrompt) {
  const text = String(normalizedPrompt || '').trim();
  if (!text) return false;

  const inventoryVerbSignal = /(?:\u6709\u4ec0\u4e48|\u6709\u54ea\u4e9b|\u90fd\u6709\u4ec0\u4e48|\u90fd\u6709\u54ea\u4e9b|\u5217\u8868|\u6e05\u5355|\u5217\u51fa|\u5305\u542b|\u5b58\u5728)/;
  const quantitativeSignal = /(?:\u6d41\u91cf|\u541e\u5410|\u8bbf\u95ee\u91cf|\u6392\u884c|\u6392\u540d|top|\u6700\u5927|\u6700\u9ad8|\u6700\u6162|\u8d8b\u52bf|\u54cd\u5e94\u65f6\u95f4|\u5ef6\u65f6|\u9519\u8bef|\u5931\u8d25|\u5f02\u5e38|\u4e22\u5305|\u91cd\u4f20)/i;
  const metadataExcludeSignal = /(?:\u6307\u6807|metric|metrics|\u7ef4\u5ea6|\u5206\u7ec4\u7c7b\u578b|\u5bf9\u8c61\u7c7b\u578b|\u652f\u6301)/i;
  const objectType = inferInventoryObjectType(text);

  return inventoryVerbSignal.test(text)
    && Boolean(objectType)
    && !quantitativeSignal.test(text)
    && !metadataExcludeSignal.test(text);
}

function inferSemanticOperation(normalizedPrompt, decision) {
  const text = String(normalizedPrompt || '').trim();
  if (!text) return null;

  if (isMetadataInventoryIntent(text)) return 'inventory';
  if (/(?:\u8d8b\u52bf|\u53d8\u5316|\u6ce2\u52a8|\u66f2\u7ebf|\u6309\u65f6\u95f4|\u6bcf\u5c0f\u65f6|time\s*series|timevalues)/i.test(text)) return 'trend';
  if (/(?:\u5e73\u5747|avg|average|\u6982\u89c8|overall|overview)/i.test(text)) return 'average';
  if (/(?:top\s*\d+|\u6392\u884c|\u6392\u540d|\u524d\s*\d+|\u6700\u591a|\u6700\u9ad8|\u6700\u5927|\u6700\u6162)/i.test(text)) return 'ranking';
  if (decision?.task_type === 'performance_triage' || decision?.next_action === 'GO_OVERVIEW_QUERY') return 'average';
  // GO_DIRECT_QUERY only means "execute query", not "ranking by default".
  if (decision?.next_action === 'GO_DIRECT_QUERY') return 'query';
  return 'query';
}

function rankChainByPrompt(chain, normalizedPrompt, semanticOperation) {
  const reasons = [];
  let score = 0;

  const hasIpTarget = /(?:\bip\b|ipaddress|\u5730\u5740)/i.test(normalizedPrompt);
  const hasAccessSignal = /(?:\u8bbf\u95ee|access|visit)/i.test(normalizedPrompt);
  const hasClientSignal = /(?:client|clientip|clientips|\u5ba2\u6237\u7aef)/i.test(normalizedPrompt);
  const hasServerSignal = /(?:server|serverip|serverips|\u670d\u52a1\u7aef)/i.test(normalizedPrompt);
  const hasInternalSignal = /(?:internal|internalip|internalips|\u5185\u90e8)/i.test(normalizedPrompt);
  const hasExternalSignal = /(?:external|externalip|externalips|\u5916\u90e8)/i.test(normalizedPrompt);
  const hasWebSignal = /(?:webapplication|webapp|web\s*application|web|\u4e1a\u52a1|\u4e1a\u52a1\u7cfb\u7edf)/i.test(normalizedPrompt);

  if (hasIpTarget && chain[chain.length - 1] === 'IPAddress') {
    score += 4;
    reasons.push('target_ipaddress');
  }
  if (hasWebSignal && chain[0] === 'WebApplication') {
    score += 3;
    reasons.push('anchor_webapplication');
  }
  if ((hasAccessSignal || hasClientSignal) && chain.includes('ClientIPs')) {
    score += 6;
    reasons.push('prefer_clientips_for_access');
  }
  if (hasServerSignal && chain.includes('ServerIPs')) {
    score += 6;
    reasons.push('prefer_serverips');
  }
  if (hasInternalSignal && chain.includes('InternalIPs')) {
    score += 6;
    reasons.push('prefer_internalips');
  }
  if (hasExternalSignal && chain.includes('ExternalIPs')) {
    score += 6;
    reasons.push('prefer_externalips');
  }
  if (semanticOperation === 'ranking' && chain.length >= 3) {
    score += 2;
    reasons.push('ranking_prefers_multilevel');
  }

  return { chain, score, reasons };
}

function buildPathHints(prompt, decision, knowledge, semanticOperation) {
  const normalizedPrompt = normalizeForMatch(prompt);
  const fromQueryDoc = extractGroupChainsFromDoc(knowledge.rawDocs.queryConstruction || '');
  const fallbackChains = [
    ['WebApplication', 'ClientIPs', 'IPAddress'],
    ['WebApplication', 'ServerIPs', 'IPAddress'],
    ['DefinedApp', 'InternalIPs', 'IPAddress'],
    ['DefinedApp', 'ExternalIPs', 'IPAddress'],
    ['BusinessGroup', 'WebApplication']
  ];
  const candidateChains = fromQueryDoc.length > 0 ? fromQueryDoc : fallbackChains;

  const ranked = candidateChains
    .map((chain) => rankChainByPrompt(chain, normalizedPrompt, semanticOperation))
    .sort((left, right) => right.score - left.score);

  const best = ranked[0] || null;
  const second = ranked[1] || null;
  const margin = best && second ? best.score - second.score : (best ? best.score : 0);
  const confidence = !best
    ? 'low'
    : margin >= 4
      ? 'high'
      : margin >= 2
        ? 'medium'
        : 'low';

  const preferredChains = ranked
    .filter((item) => item.score > 0)
    .slice(0, 3)
    .map((item) => item.chain.slice());
  const preferredIntermediates = Array.from(new Set((preferredChains[0] || []).slice(1, -1)));
  const bestChain = preferredChains[0] || [];

  return {
    confidence,
    preferredDepth: bestChain.length || null,
    preferredAnchorType: bestChain[0] || null,
    preferredTargetType: bestChain.length > 0 ? bestChain[bestChain.length - 1] : null,
    preferredIntermediates,
    preferredChains,
    reasons: best?.reasons || [],
    queryConstructionReferenceLoaded: Boolean(knowledge.rawDocs.queryConstruction)
  };
}

function inferServiceCandidates(prompt, decision, semanticOperation, knowledge) {
  const normalizedPrompt = normalizeForMatch(prompt);
  const serviceDoc = normalizeForMatch(
    `${knowledge.rawDocs.serviceModes || ''}\n${knowledge.rawDocs.queryConstruction || ''}`
  );
  const serviceScores = new Map();
  const addScore = (service, score, reason) => {
    const entry = serviceScores.get(service) || { service, score: 0, reasons: [] };
    entry.score += Number(score) || 0;
    if (reason) entry.reasons.push(reason);
    serviceScores.set(service, entry);
  };

  if (semanticOperation === 'inventory') addScore('groups', 9, 'semantic_operation_inventory');
  if (semanticOperation === 'trend') addScore('timeValues', 8, 'semantic_operation_trend');
  if (semanticOperation === 'average') addScore('averageValues', 8, 'semantic_operation_average');
  if (semanticOperation === 'ranking') addScore('topValues', 8, 'semantic_operation_ranking');

  if (/(?:top\s*\d+|\u6392\u884c|\u6392\u540d|\u6700\u591a|\u6700\u9ad8|\u6700\u5927)/i.test(normalizedPrompt)) {
    addScore('topValues', 4, 'ranking_keyword');
  }
  if (/(?:trend|time\s*series|timevalues|\u8d8b\u52bf|\u6ce2\u52a8|\u8d70\u52bf)/i.test(normalizedPrompt)) {
    addScore('timeValues', 4, 'trend_keyword');
  }
  if (/(?:avg|average|overall|overview|\u5e73\u5747|\u6982\u89c8)/i.test(normalizedPrompt)) {
    addScore('averageValues', 4, 'average_keyword');
  }

  if (decision?.next_action === 'GO_DIRECT_QUERY' && semanticOperation === 'query') {
    addScore('averageValues', 2, 'decision_direct_query_default_average');
  }
  if (decision?.next_action === 'GO_OVERVIEW_QUERY') addScore('averageValues', 2, 'decision_overview_query');

  for (const serviceName of ['topValues', 'averageValues', 'timeValues', 'groups']) {
    if (serviceDoc.includes(serviceName.toLowerCase())) {
      addScore(serviceName, 1, 'service_modes_reference_present');
    }
  }

  const sorted = Array.from(serviceScores.values())
    .sort((left, right) => right.score - left.score)
    .slice(0, 4);

  return {
    preferredService: sorted[0]?.service || null,
    serviceCandidates: sorted
  };
}

function inferPreferredService(prompt, decision) {
  const knowledge = loadKnowledge();
  const normalized = normalizeForMatch(prompt);
  const semanticOperation = inferSemanticOperation(normalized, decision);
  const serviceHints = inferServiceCandidates(prompt, decision, semanticOperation, knowledge);
  return serviceHints.preferredService;
}

function inferLookupServices(prompt, decision) {
  const normalized = normalizeForMatch(prompt);
  const knowledge = loadKnowledge();
  const runtimeDoc = normalizeForMatch(knowledge.rawDocs.runtimeLookup || '');
  const services = [];

  const isQueryAction = decision?.next_action === 'GO_DIRECT_QUERY' || decision?.next_action === 'GO_OVERVIEW_QUERY';
  if (!isQueryAction) {
    return services;
  }

  services.push('groups', 'metrics');
  if (inferInventoryObjectType(normalized) || /\bip\b/i.test(normalized)) {
    services.push('groupArguments');
  }
  if (/(?:\u6307\u6807|metric|metrics|\u9519\u8bef|\u5931\u8d25|\u5ef6\u65f6|\u8d8b\u52bf|\u541e\u5410|\u6d41\u91cf|\u4e22\u5305|5xx|500)/i.test(prompt || '')) {
    services.push('metricsForGroup');
  }

  const runtimePriority = ['groups', 'metrics', 'groupArguments', 'metricsForGroup']
    .filter((service) => runtimeDoc.includes(service.toLowerCase()));
  if (runtimePriority.length > 0) {
    services.push(...runtimePriority);
  }

  return Array.from(new Set(services));
}

function inferQueryShape(prompt, decision) {
  const normalized = normalizeForMatch(prompt);
  const semanticOperation = inferSemanticOperation(normalized, decision);

  if (semanticOperation === 'inventory') return 'inventory';
  if (semanticOperation === 'trend') return 'trend';
  if (semanticOperation === 'average') return 'overview';
  if (semanticOperation === 'ranking') return 'ranking';
  return null;
}

function buildExecutionHints(prompt, decision) {
  const knowledge = loadKnowledge();
  const normalized = normalizeForMatch(prompt);
  const semanticOperation = inferSemanticOperation(normalized, decision);
  const serviceHints = inferServiceCandidates(prompt, decision, semanticOperation, knowledge);
  const preferredService = serviceHints.preferredService;
  const queryShape = inferQueryShape(prompt, decision);
  const lookupServices = inferLookupServices(prompt, decision);
  const pathHints = buildPathHints(prompt, decision, knowledge, semanticOperation);
  const runtimeLookupPriority = lookupServices.map((service, index) => ({
    service,
    priority: index + 1
  }));

  const constructionChecklist = [
    'confirm service type',
    'confirm time range',
    'confirm metrics',
    'confirm group chain'
  ];
  if (preferredService === 'topValues') {
    constructionChecklist.push('confirm topMetric and topCount');
  }
  if (preferredService === 'timeValues') {
    constructionChecklist.push('confirm granularity');
  }
  if (pathHints.preferredAnchorType) {
    constructionChecklist.push('confirm anchor object argument');
  }

  return {
    preferredService,
    serviceCandidates: serviceHints.serviceCandidates,
    queryShape,
    requiresRuntimeLookup: lookupServices.length > 0,
    lookupServices,
    runtimeLookupPriority,
    pathHints,
    constructionChecklist
  };
}

module.exports = {
  loadKnowledge,
  getReferenceSignals,
  buildConceptualAnswer,
  buildExecutionHints
};
