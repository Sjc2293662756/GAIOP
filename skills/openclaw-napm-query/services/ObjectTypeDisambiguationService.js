const fs = require('fs');
const path = require('path');

const NapmMetadataService = require('./NapmMetadataService');
const DimensionMappingService = require('./DimensionMappingService');

class ObjectTypeDisambiguationService {
  constructor() {
    const configPath = path.join(__dirname, '../../../config/object-type-disambiguation.v1.json');
    this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  async disambiguate(query, originalText = '') {
    const resolvedQuery = this.cloneQuery(query);
    const warnings = [];
    const corrections = [];

    if (!resolvedQuery || !Array.isArray(resolvedQuery.groups) || resolvedQuery.groups.length === 0) {
      return {
        query: resolvedQuery,
        warnings,
        corrections,
        shouldApply: false,
        candidates: [],
        evidence: {
          currentGroupType: null,
          selectedCandidate: null
        }
      };
    }

    const text = this.buildTextContext(originalText);
    const firstGroup = { ...(resolvedQuery.groups[0] || {}) };
    const metric = resolvedQuery.metric || (Array.isArray(resolvedQuery.metrics) ? resolvedQuery.metrics[0] : null);
    const compatibility = metric
      ? DimensionMappingService.getObjectsForMetric(metric, { onlySupportedByCurrentSkill: true })
      : [];
    const preferredObjects = metric
      ? DimensionMappingService.getPreferredObjectsForMetric(metric)
      : [];

    const candidates = [];
    for (const groupType of this.config.candidateGroups) {
      const candidate = await this.scoreCandidate(groupType, {
        text,
        query: resolvedQuery,
        firstGroup,
        compatibility,
        preferredObjects
      });
      if (candidate.score > 0) {
        candidates.push(candidate);
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0] || null;
    const current = candidates.find(item => item.type === firstGroup.type) || null;
    const lead = best && current ? Number((best.score - current.score).toFixed(2)) : null;
    const shouldApply = Boolean(
      best &&
      best.score >= this.config.thresholds.autoApply &&
      (best.type !== firstGroup.type || best.argument !== firstGroup.argument) &&
      (current ? best.score - current.score >= this.config.thresholds.minimumLead : true)
    );

    if (shouldApply) {
      const before = {
        type: firstGroup.type,
        argument: firstGroup.argument
      };
      firstGroup.type = best.type;

      if (best.argument) {
        firstGroup.argument = best.argument;
      } else if (!this.groupSupportsArgument(best.type)) {
        delete firstGroup.argument;
      }

      resolvedQuery.groups[0] = firstGroup;
      corrections.push({
        field: 'groups[0]',
        action: 'disambiguate_object_type',
        from: before,
        to: firstGroup,
        evidence: best.reasons
      });
    }

    const suggestions = candidates
      .filter(item => item !== best && item.score >= this.config.thresholds.suggest)
      .slice(0, this.config.maxSuggestions)
      .map(item => ({
        type: item.type,
        score: item.score,
        argument: item.argument,
        reasons: item.reasons
      }));

    const selectedObjectType = resolvedQuery?.groups?.[0]?.type || null;
    const selectedObjectValue = resolvedQuery?.groups?.[0]?.argument || null;
    const argumentCandidates = await this.buildArgumentCandidates(selectedObjectType, text, selectedObjectValue);
    const drilldownPathCandidates = await this.buildDrilldownPathCandidates(selectedObjectType);
    const scopeLevel = this.resolveScopeLevel(selectedObjectType);

    resolvedQuery.objectType = selectedObjectType;
    resolvedQuery.objectValue = selectedObjectValue;
    resolvedQuery.scopeLevel = scopeLevel;
    resolvedQuery.drilldownPathCandidates = drilldownPathCandidates.map(item => item.path);

    return {
      query: resolvedQuery,
      warnings,
      corrections,
      shouldApply,
      candidates,
      suggestions,
      objectType: selectedObjectType,
      objectValue: selectedObjectValue,
      argumentCandidates,
      drilldownPathCandidates,
      scopeLevel,
      evidence: {
        metric,
        compatibility,
        preferredObjects,
        currentGroupType: query.groups[0]?.type || null,
        selectedCandidate: best,
        lead
      }
    };
  }

  async scoreCandidate(groupType, context) {
    const { text, firstGroup, compatibility, preferredObjects } = context;
    const reasons = [];
    let score = 0;
    let argument = firstGroup.type === groupType ? firstGroup.argument : undefined;

    if (firstGroup.type === groupType) {
      score += this.config.typeSpecificWeights.currentTypeBias;
      reasons.push('current_type_bias');
    }

    const aliasHits = this.countAliasHits(groupType, text);
    if (aliasHits > 0) {
      score += aliasHits * this.config.typeSpecificWeights.aliasHit;
      reasons.push(`alias_hits:${aliasHits}`);
    }

    if (compatibility.includes(groupType)) {
      score += this.config.typeSpecificWeights.metricCompatible;
      reasons.push('metric_compatible');
    }

    if (preferredObjects.includes(groupType)) {
      score += this.config.typeSpecificWeights.metricPreferred;
      reasons.push('metric_preferred');
    }

    if (groupType === 'IPAddress' && text.ipMatches.length >= 1 && !this.hasExplicitConnectedOrClientLabel(text)) {
      score += this.config.typeSpecificWeights.ipLiteral;
      argument = argument || text.ipMatches[0];
      reasons.push('ip_literal');
    }

    if (groupType === 'ClientIPs' && this.hasLabel(groupType, text)) {
      score += this.config.typeSpecificWeights.clientLabel;
      argument = argument || text.ipMatches[0];
      reasons.push('client_label');
    }

    if (groupType === 'ConnectedIP' && this.hasLabel(groupType, text)) {
      score += this.config.typeSpecificWeights.connectedLabel;
      argument = argument || text.ipMatches[1];
      reasons.push('connected_label');
    }

    if (groupType === 'IPConversation' && text.ipMatches.length >= 2) {
      score += this.config.typeSpecificWeights.conversationLiteral;
      argument = `${text.ipMatches[0]}|${text.ipMatches[1]}`;
      reasons.push('conversation_literal');
    }

    if (groupType === 'Prefix24' && text.prefixMatches.length >= 1) {
      score += this.config.typeSpecificWeights.prefixLiteral;
      argument = text.prefixMatches[0];
      reasons.push('prefix_literal');
    }

    if (groupType === 'BusinessGroup' && this.hasLabel(groupType, text)) {
      score += this.config.typeSpecificWeights.businessGroupLabel;
      reasons.push('business_group_label');
    }

    if (groupType === 'WebApplication' && this.hasLabel(groupType, text)) {
      score += this.config.typeSpecificWeights.webLabel;
      reasons.push('web_application_label');
    }

    if (groupType === 'WebApplication' && /web/i.test(text.raw)) {
      score += 0.18;
      reasons.push('web_token');
    }

    if (groupType === 'Application' && this.hasLabel(groupType, text) && !this.containsDirectProtocolTerm(text)) {
      score += this.config.typeSpecificWeights.applicationLabel;
      reasons.push('application_label');
    }

    if (groupType === 'TotalTraffic' && !text.ipMatches.length && !text.prefixMatches.length) {
      score += this.config.typeSpecificWeights.totalTrafficFallback;
      reasons.push('total_traffic_fallback');
    }

    if (this.config.metadataDrivenGroups.includes(groupType) && !this.shouldProtectQuotedArgument(firstGroup, text, groupType)) {
      const metadataMention = await this.findMetadataMention(groupType, text);
      if (metadataMention) {
        score += this.config.typeSpecificWeights.metadataMention;
        argument = metadataMention.value;
        reasons.push(`metadata_mention:${metadataMention.value}`);
      }
    }

    if (groupType === 'Application' && this.containsApplicationIndicator(text) && !this.hasLabel('WebApplication', text) && !/web/i.test(text.raw)) {
      score += 0.18;
      reasons.push('application_indicator');
    }

    return {
      type: groupType,
      score: Number(Math.min(score, 0.99).toFixed(2)),
      argument,
      reasons
    };
  }

  async findMetadataMention(groupType, text) {
    try {
      const candidates = await NapmMetadataService.getGroupArguments(groupType);
      const normalizedText = this.normalizeComparable(text.raw);
      const matched = candidates
        .map(item => ({
          value: item.value,
          label: item.label || item.value,
          key: this.normalizeComparable(item.value || item.label)
        }))
        .filter(item => item.key && item.key.length >= 3 && !this.shouldIgnoreMetadataCandidate(item.value, groupType) && normalizedText.includes(item.key))
        .sort((a, b) => b.key.length - a.key.length);

      return matched[0] || null;
    } catch (error) {
      return null;
    }
  }

  countAliasHits(groupType, text) {
    const aliases = new Set([
      ...(this.config.groupLabels[groupType] || []),
      ...((DimensionMappingService.getObjectDimension(groupType)?.aliases) || [])
    ]);

    let hits = 0;
    for (const alias of aliases) {
      if (!alias) {
        continue;
      }

      if (text.lower.includes(String(alias).toLowerCase())) {
        hits += 1;
      }
    }

    return hits;
  }

  hasLabel(groupType, text) {
    return this.countAliasHits(groupType, text) > 0;
  }

  hasExplicitConnectedOrClientLabel(text) {
    return this.hasLabel('ConnectedIP', text) || this.hasLabel('ClientIPs', text);
  }

  containsDirectProtocolTerm(text) {
    return this.config.directProtocolTerms.some(term => text.lower.includes(term));
  }

  containsApplicationIndicator(text) {
    return this.config.applicationIndicatorTerms.some(term => text.lower.includes(term));
  }

  groupSupportsArgument(groupType) {
    const dimension = DimensionMappingService.getObjectDimension(groupType);
    return dimension ? Boolean(dimension.hasArgument) : true;
  }

  shouldProtectQuotedArgument(firstGroup, text, groupType) {
    if (!firstGroup?.argument || firstGroup.type !== groupType) {
      return false;
    }

    const normalizedCurrent = this.normalizeComparable(firstGroup.argument);
    if (!normalizedCurrent) {
      return false;
    }

    return (text.quotedValues || []).some(value => this.normalizeComparable(value) === normalizedCurrent);
  }

  shouldIgnoreMetadataCandidate(value, groupType) {
    const normalized = this.normalizeComparable(value);
    if (!normalized) {
      return true;
    }

    if (groupType !== 'IPProtocol') {
      const blocked = new Set([
        ...(this.config.directProtocolTerms || []),
        ...(this.config.applicationIndicatorTerms || [])
      ].map(item => this.normalizeComparable(item)));

      if (blocked.has(normalized)) {
        return true;
      }
    }

    return false;
  }

  buildTextContext(originalText) {
    const raw = String(originalText || '').trim();
    const normalized = raw.replace(/\s+/g, ' ');
    const lower = normalized.toLowerCase();
    const ipMatches = raw.match(/((?:\d{1,3}\.){3}\d{1,3})/g) || [];
    const prefixMatches = raw.match(/((?:\d{1,3}\.){3}\d{1,3}\/24)/g) || [];
    const quotedValues = Array.from(raw.matchAll(/["'`“”‘’「」『』]([^"'`“”‘’「」『』]+)["'`“”‘’「」『』]/g)).map(item => item[1].trim());

    return {
      raw,
      normalized,
      lower,
      ipMatches,
      prefixMatches,
      quotedValues
    };
  }

  normalizeComparable(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[()（）:：,_`"'“”‘’-]/g, '');
  }

  async buildArgumentCandidates(groupType, text, selectedValue) {
    if (!groupType || !this.groupSupportsArgument(groupType)) {
      return [];
    }

    try {
      const candidates = await NapmMetadataService.getGroupArguments(groupType);
      const normalizedText = this.normalizeComparable(text?.raw || '');
      const normalizedSelected = this.normalizeComparable(selectedValue || '');

      return candidates
        .map((item) => {
          const value = item?.value || item?.label || null;
          const normalizedValue = this.normalizeComparable(value);
          let score = 0;

          if (normalizedSelected && normalizedSelected === normalizedValue) {
            score += 1;
          }
          if (normalizedText && normalizedValue && normalizedText.includes(normalizedValue)) {
            score += 0.8;
          }
          if (Array.isArray(text?.quotedValues) && text.quotedValues.some(valueItem => this.normalizeComparable(valueItem) === normalizedValue)) {
            score += 0.7;
          }

          return {
            value,
            label: item?.label || value,
            score: Number(score.toFixed(2))
          };
        })
        .filter(item => item.value)
        .sort((a, b) => b.score - a.score || String(a.label).localeCompare(String(b.label)))
        .slice(0, 8);
    } catch (error) {
      return [];
    }
  }

  async buildDrilldownPathCandidates(groupType) {
    if (!groupType) {
      return [];
    }

    try {
      const flattened = await NapmMetadataService.getFlattenedGroups();
      const unique = new Map();

      flattened
        .filter(item => Array.isArray(item?.path) && item.path[0] === groupType && item.path.length > 1)
        .slice(0, 80)
        .forEach((item) => {
          const key = item.path.join('>');
          if (!unique.has(key)) {
            unique.set(key, {
              path: item.path,
              pathText: item.pathText || key
            });
          }
        });

      return Array.from(unique.values()).slice(0, 6);
    } catch (error) {
      return [];
    }
  }

  resolveScopeLevel(groupType) {
    if (!groupType || groupType === 'TotalTraffic') {
      return 'global';
    }

    if (['BusinessGroup', 'Application', 'WebApplication', 'User'].includes(groupType)) {
      return 'business_object';
    }

    if (['IPAddress', 'Prefix24', 'ConnectedIP', 'IPConversation', 'ClientIPs'].includes(groupType)) {
      return 'network_object';
    }

    if (['Page', 'PageFamily'].includes(groupType)) {
      return 'page_level';
    }

    return 'object';
  }

  cloneQuery(query) {
    return query ? JSON.parse(JSON.stringify(query)) : query;
  }
}

module.exports = new ObjectTypeDisambiguationService();
