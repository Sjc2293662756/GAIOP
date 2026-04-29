const fs = require('fs');
const path = require('path');

const NapmMetadataService = require('./NapmMetadataService');

class ArgumentResolutionService {
  constructor() {
    const configPath = path.join(__dirname, '../../../config/argument-resolution.v1.json');
    this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  async resolve(query, originalText = '', metadataReview = null) {
    const resolvedQuery = this.cloneQuery(query);
    const warnings = [];
    const corrections = [];
    const suggestions = [];
    const resolutions = [];

    if (!resolvedQuery || !Array.isArray(resolvedQuery.groups) || resolvedQuery.groups.length === 0) {
      return {
        query: resolvedQuery,
        warnings,
        corrections,
        suggestions,
        resolutions
      };
    }

    const text = this.buildTextContext(originalText);
    const resolvedGroups = [];

    for (let index = 0; index < resolvedQuery.groups.length; index += 1) {
      const currentGroup = { ...(resolvedQuery.groups[index] || {}) };
      const definition = await NapmMetadataService.getGroupDefinition(currentGroup.type);

      if (!definition) {
        warnings.push(`argument_resolution_group_definition_missing:${currentGroup.type}`);
        resolvedGroups.push(currentGroup);
        continue;
      }

      if (!definition.hasArgument) {
        if (currentGroup.argument) {
          corrections.push({
            field: `groups[${index}].argument`,
            action: 'remove_argument_for_non_argument_group',
            from: currentGroup.argument,
            to: null
          });
          delete currentGroup.argument;
        }
        resolvedGroups.push(currentGroup);
        continue;
      }

      const extracted = this.extractCandidateSignals(currentGroup.type, text, resolvedQuery.groups, index);
      const candidateList = await this.getCandidateList(currentGroup, index, metadataReview);
      const shouldPreserveQuotedArgument = this.shouldProtectQuotedArgument(currentGroup, text, extracted, index);
      const metadataMention = this.resolveByMetadataMention(currentGroup, candidateList, text, extracted, index);

      if (this.shouldDropImplicitInheritedArgument(currentGroup, index, resolvedGroups, extracted)) {
        corrections.push({
          field: `groups[${index}].argument`,
          action: 'drop_implicit_inherited_argument',
          from: currentGroup.argument,
          to: null
        });
        delete currentGroup.argument;
      }

      const aliasResolved = this.resolveByConfiguredAlias(currentGroup, extracted, candidateList);
      if (aliasResolved) {
        if (currentGroup.argument !== aliasResolved.value) {
          corrections.push({
            field: `groups[${index}].argument`,
            action: aliasResolved.action,
            from: currentGroup.argument,
            to: aliasResolved.value
          });
          currentGroup.argument = aliasResolved.value;
        }

        resolutions.push({
          groupType: currentGroup.type,
          strategy: aliasResolved.strategy,
          confidence: aliasResolved.confidence,
          value: aliasResolved.value,
          matchedAlias: aliasResolved.matchedAlias || null
        });
      }

      const directResolved = this.resolveByDirectValue(currentGroup, extracted);
      if (directResolved) {
        if (currentGroup.argument !== directResolved.value) {
          corrections.push({
            field: `groups[${index}].argument`,
            action: directResolved.action,
            from: currentGroup.argument,
            to: directResolved.value
          });
          currentGroup.argument = directResolved.value;
        }

        resolutions.push({
          groupType: currentGroup.type,
          strategy: directResolved.strategy,
          confidence: directResolved.confidence,
          value: directResolved.value
        });
      }

      if (metadataMention) {
        if (currentGroup.argument !== metadataMention.value) {
          corrections.push({
            field: `groups[${index}].argument`,
            action: 'normalize_argument_with_metadata_mention',
            from: currentGroup.argument,
            to: metadataMention.value
          });
          currentGroup.argument = metadataMention.value;
        }

        resolutions.push({
          groupType: currentGroup.type,
          strategy: metadataMention.strategy,
          confidence: metadataMention.confidence,
          value: metadataMention.value
        });
      }

      if (!metadataMention && !shouldPreserveQuotedArgument) {
        const candidateMatch = this.matchAgainstCandidates(currentGroup, extracted, candidateList, text);
        if (candidateMatch.best && candidateMatch.best.score >= this.config.thresholds.autoApply) {
          if (currentGroup.argument !== candidateMatch.best.candidate.value) {
            corrections.push({
              field: `groups[${index}].argument`,
              action: 'normalize_argument_with_metadata_candidate',
              from: currentGroup.argument,
              to: candidateMatch.best.candidate.value
            });
            currentGroup.argument = candidateMatch.best.candidate.value;
          }

          resolutions.push({
            groupType: currentGroup.type,
            strategy: candidateMatch.best.source.type,
            confidence: candidateMatch.best.score,
            value: candidateMatch.best.candidate.value
          });
        } else if (candidateMatch.best && candidateMatch.best.score >= this.config.thresholds.suggest) {
          suggestions.push({
            type: 'argument_candidates',
            groupType: currentGroup.type,
            extractedValue: candidateMatch.best.source.value,
            confidence: candidateMatch.best.score,
            candidates: candidateMatch.matches
              .slice(0, this.config.maxSuggestionCandidates)
              .map(item => ({
                value: item.candidate.value,
                label: item.candidate.label,
                confidence: item.score
              }))
          });
        } else if (!currentGroup.argument && candidateList.length > 0 && extracted.values.length === 0) {
          suggestions.push({
            type: 'argument_missing',
            groupType: currentGroup.type,
            candidates: candidateList.slice(0, this.config.maxSuggestionCandidates)
          });
        }
      }

      if (currentGroup.argument && candidateList.length > 0) {
        const exactMatch = candidateList.find(item => this.normalizeComparable(item.value) === this.normalizeComparable(currentGroup.argument));
        if (!exactMatch) {
          warnings.push(`argument_not_confirmed_by_metadata:${currentGroup.type}:${currentGroup.argument}`);
        }
      }

      resolvedGroups.push(currentGroup);
    }

    resolvedQuery.groups = resolvedGroups;

    return {
      query: resolvedQuery,
      warnings,
      corrections,
      suggestions,
      resolutions
    };
  }

  cloneQuery(query) {
    return query ? JSON.parse(JSON.stringify(query)) : query;
  }

  buildTextContext(originalText) {
    const raw = String(originalText || '').trim();
    const normalized = raw.replace(/\s+/g, ' ');
    const lower = normalized.toLowerCase();
    const ipMatches = raw.match(/((?:\d{1,3}\.){3}\d{1,3})/g) || [];
    const prefixMatches = raw.match(/((?:\d{1,3}\.){3}\d{1,3}\/24)/g) || [];
    const quotedValues = Array.from(raw.matchAll(/["'`“”‘’]([^"'`“”‘’]+)["'`“”‘’]/g)).map(item => item[1].trim());

    return {
      raw,
      normalized,
      lower,
      ipMatches,
      prefixMatches,
      prefixCandidateMatches: this.extractPrefix24Candidates(raw),
      quotedValues
    };
  }

  async getCandidateList(group, index, metadataReview) {
    if (index === 0 && metadataReview && Array.isArray(metadataReview.groupArguments)) {
      return metadataReview.groupArguments;
    }

    try {
      return await NapmMetadataService.getGroupArguments(group.type);
    } catch (error) {
      return [];
    }
  }

  extractCandidateSignals(groupType, text, existingGroups, index) {
    const labels = this.config.groupLabels[groupType] || [];
    const values = [];

    if (groupType === 'IPAddress' || groupType === 'ClientIPs') {
      if (text.ipMatches[0]) {
        values.push({
          type: 'ip_literal',
          value: text.ipMatches[0],
          confidence: 0.99
        });
      }
      return { values: this.deduplicateSignals(values), hasExplicitLabelHit: false };
    }

    if (groupType === 'Prefix24') {
      for (const prefix of text.prefixCandidateMatches || []) {
        values.push({
          type: 'prefix_literal',
          value: prefix,
          confidence: prefix.endsWith('/24') ? 0.99 : 0.97
        });
      }
      return { values: this.deduplicateSignals(values), hasExplicitLabelHit: false };
    }

    for (const quoted of text.quotedValues) {
      values.push({
        type: 'quoted',
        value: quoted,
        confidence: 0.93
      });
    }

    if (groupType === 'ConnectedIP') {
      const labeled = this.extractByLabels(text.raw, labels);
      if (labeled.length > 0) {
        labeled.forEach(value => values.push({
          type: 'connected_ip_label',
          value,
          confidence: 0.97
        }));
        return { values: this.deduplicateSignals(values), hasExplicitLabelHit: true };
      }

      if (text.ipMatches.length >= 2) {
        values.push({
          type: 'connected_ip_second_literal',
          value: text.ipMatches[1],
          confidence: 0.9
        });
      }

      return { values: this.deduplicateSignals(values), hasExplicitLabelHit: false };
    }

    if (groupType === 'IPConversation') {
      if (text.ipMatches.length >= 2) {
        values.push({
          type: 'ip_conversation_pair',
          value: `${text.ipMatches[0]}|${text.ipMatches[1]}`,
          confidence: 0.98
        });
      }
      return { values: this.deduplicateSignals(values), hasExplicitLabelHit: false };
    }

    if (groupType === 'IPProtocol') {
      for (const protocol of this.config.protocolAliases) {
        if (protocol.aliases.some(alias => text.lower.includes(String(alias).toLowerCase()))) {
          values.push({
            type: 'protocol_alias',
            value: protocol.value,
            confidence: 0.98
          });
        }
      }
      return { values: this.deduplicateSignals(values), hasExplicitLabelHit: false };
    }

    const byLabels = this.extractByLabels(text.raw, labels);
    byLabels.forEach(value => values.push({
      type: 'label_window',
      value,
      confidence: 0.9
    }));

    if (index === 0 && Array.isArray(existingGroups) && existingGroups[0] && existingGroups[0].argument) {
      values.push({
        type: 'existing_argument',
        value: existingGroups[0].argument,
        confidence: 0.86
      });
    }

    return {
      values: this.deduplicateSignals(values),
      hasExplicitLabelHit: byLabels.length > 0
    };
  }

  extractByLabels(raw, labels = []) {
    const matches = [];

    for (const label of labels) {
      const escaped = this.escapeRegExp(label);
      const beforePattern = new RegExp(`([A-Za-z0-9_.\\-/\\u4e00-\\u9fa5]+)${escaped}`, 'g');
      const afterPattern = new RegExp(`${escaped}(?:为|是|:|：)?\\s*([A-Za-z0-9_.\\-/\\u4e00-\\u9fa5]+)`, 'g');
      let result = beforePattern.exec(raw);
      while (result) {
        const value = this.cleanToken(result[1]);
        if (value) {
          matches.push(value);
        }
        result = beforePattern.exec(raw);
      }

      result = afterPattern.exec(raw);
      while (result) {
        const value = this.cleanToken(result[1]);
        if (value) {
          matches.push(value);
        }
        result = afterPattern.exec(raw);
      }
    }

    return Array.from(new Set(matches.filter(Boolean)));
  }

  cleanToken(value) {
    if (!value) {
      return '';
    }

    const trimmed = String(value).trim().replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '');
    if (!trimmed) {
      return '';
    }

    const stopWords = this.config.genericStopWords || [];
    if (stopWords.includes(trimmed)) {
      return '';
    }

    return trimmed;
  }

  resolveByDirectValue(group, extracted) {
    if (!this.config.directValueGroups.includes(group.type)) {
      return null;
    }

    const bestSignal = extracted.values.sort((a, b) => b.confidence - a.confidence)[0];
    if (!bestSignal) {
      return null;
    }

    const normalizedValue = group.type === 'Prefix24'
      ? this.normalizePrefix24Value(bestSignal.value)
      : bestSignal.value;
    if (!normalizedValue) {
      return null;
    }

    return {
      value: normalizedValue,
      strategy: bestSignal.type,
      action: group.argument ? 'normalize_argument_with_direct_signal' : 'fill_argument_with_direct_signal',
      confidence: bestSignal.confidence
    };
  }

  resolveByConfiguredAlias(group, extracted = null, candidates = []) {
    const aliasRules = Array.isArray(this.config.argumentAliases?.[group?.type])
      ? this.config.argumentAliases[group.type]
      : [];
    if (!group?.type || aliasRules.length === 0) {
      return null;
    }

    const sources = [];
    if (group.argument) {
      sources.push({
        value: group.argument,
        confidence: 0.96
      });
    }

    if (Array.isArray(extracted?.values)) {
      extracted.values.forEach(item => {
        if (item?.value) {
          sources.push({
            value: item.value,
            confidence: Number(item.confidence) || 0.9
          });
        }
      });
    }

    for (const source of sources) {
      const matchedRule = this.matchConfiguredAlias(source.value, aliasRules);
      if (!matchedRule) {
        continue;
      }

      const canonicalCandidate = Array.isArray(candidates)
        ? candidates.find(item => this.normalizeComparable(item?.value) === this.normalizeComparable(matchedRule.canonicalValue))
        : null;
      const canonicalValue = canonicalCandidate?.value || matchedRule.canonicalValue;

      return {
        value: canonicalValue,
        strategy: 'configured_argument_alias',
        action: group.argument ? 'normalize_argument_with_configured_alias' : 'fill_argument_with_configured_alias',
        confidence: Math.max(0.95, source.confidence),
        matchedAlias: source.value
      };
    }

    return null;
  }

  matchConfiguredAlias(value, aliasRules = []) {
    const normalizedValue = this.normalizeComparable(value);
    if (!normalizedValue) {
      return null;
    }

    for (const rule of aliasRules) {
      const candidates = [rule?.canonicalValue]
        .concat(Array.isArray(rule?.aliases) ? rule.aliases : [])
        .filter(Boolean);
      const matched = candidates.some(item => this.normalizeComparable(item) === normalizedValue);
      if (matched && rule?.canonicalValue) {
        return rule;
      }
    }

    return null;
  }

  resolveByMetadataMention(group, candidates = [], text, extracted = null, index = -1) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return null;
    }

    if (this.shouldProtectQuotedArgument(group, text, extracted, index)) {
      return null;
    }

    const best = candidates
      .map(candidate => this.scoreMetadataMention(candidate, text, group.type))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || b.length - a.length)[0];

    if (!best || best.score < 0.92) {
      return null;
    }

    return {
      value: best.candidate.value,
      strategy: 'metadata_exact_mention',
      confidence: best.score
    };
  }

  scoreMetadataMention(candidate, text, groupType = '') {
    const values = [candidate?.value, candidate?.label]
      .filter(Boolean)
      .map(value => String(value).trim())
      .filter(Boolean);

    for (const value of values) {
      if (this.shouldIgnoreMetadataMentionValue(value, groupType)) {
        continue;
      }

      const normalized = this.normalizeComparable(value);
      if (!normalized) {
        continue;
      }

      const mentioned = this.normalizeComparable(text.raw).includes(normalized)
        || this.normalizeComparable(text.normalized).includes(normalized)
        || this.normalizeComparable(text.lower).includes(normalized);

      if (mentioned) {
        return {
          candidate,
          score: normalized.length >= 4 ? 0.99 : 0.94,
          length: normalized.length
        };
      }
    }

    return null;
  }

  shouldProtectQuotedArgument(group, text, extracted, index) {
    if (!group?.argument || index !== 0) {
      return false;
    }

    const quotedValues = Array.isArray(text?.quotedValues) ? text.quotedValues : [];
    const normalizedCurrent = this.normalizeComparable(group.argument);
    if (!normalizedCurrent) {
      return false;
    }

    const quotedMatched = quotedValues.some(value => this.normalizeComparable(value) === normalizedCurrent);
    if (quotedMatched) {
      return true;
    }

    return Array.isArray(extracted?.values)
      && extracted.values.some(item => item?.type === 'quoted' && this.normalizeComparable(item.value) === normalizedCurrent);
  }

  shouldIgnoreMetadataMentionValue(value, groupType = '') {
    const normalized = this.normalizeComparable(value);
    if (!normalized) {
      return true;
    }

    const stopWords = new Set((this.config.genericStopWords || []).map(item => this.normalizeComparable(item)));
    if (stopWords.has(normalized)) {
      return true;
    }

    if (groupType !== 'IPProtocol') {
      const protocolValues = new Set(
        (this.config.protocolAliases || [])
          .map(item => item && item.value)
          .filter(Boolean)
          .map(item => this.normalizeComparable(item))
      );
      if (protocolValues.has(normalized)) {
        return true;
      }
    }

    return false;
  }

  matchAgainstCandidates(group, extracted, candidates = [], text = null) {
    const matches = [];
    const sources = [];

    if (group.argument) {
      sources.push({
        type: 'current_argument',
        value: group.argument,
        confidence: 0.84
      });
    }

    sources.push(...extracted.values);

    if (text && text.raw) {
      for (const candidate of candidates) {
        if (this.isCandidateMentionedInText(candidate, text)) {
          sources.push({
            type: 'text_mention',
            value: candidate.value,
            confidence: 0.95
          });
        }
      }
    }

    for (const source of sources) {
      const normalizedSource = this.normalizeComparable(source.value);
      if (!normalizedSource) {
        continue;
      }

      for (const candidate of candidates) {
        if (this.shouldSuppressGenericProtocolCandidate(group, candidate, source)) {
          continue;
        }

        const normalizedValue = this.normalizeComparable(candidate.value);
        const normalizedLabel = this.normalizeComparable(candidate.label || candidate.value);
        let score = 0;

        if (normalizedSource === normalizedValue || normalizedSource === normalizedLabel) {
          score = 0.9 + source.confidence * 0.08;
        } else if (
          normalizedSource.length >= 3 &&
          (normalizedValue.includes(normalizedSource) || normalizedLabel.includes(normalizedSource))
        ) {
          score = 0.72 + source.confidence * 0.12;
        } else if (
          normalizedSource.length >= 3 &&
          (normalizedSource.includes(normalizedValue) || normalizedSource.includes(normalizedLabel))
        ) {
          score = 0.7 + source.confidence * 0.1;
        }

        if (score > 0) {
          matches.push({
            candidate,
            source,
            score: Number(Math.min(score, 0.99).toFixed(2))
          });
        }
      }
    }

    matches.sort((a, b) => b.score - a.score);

    return {
      best: matches[0] || null,
      matches
    };
  }

  shouldSuppressGenericProtocolCandidate(group, candidate, source) {
    if (group?.type === 'IPProtocol') {
      return false;
    }

    const normalizedCandidate = this.normalizeComparable(candidate?.value || candidate?.label);
    if (!normalizedCandidate) {
      return false;
    }

    const protocolValues = new Set(
      (this.config.protocolAliases || [])
        .flatMap(item => [item?.value].concat(Array.isArray(item?.aliases) ? item.aliases : []))
        .filter(Boolean)
        .map(item => this.normalizeComparable(item))
    );

    if (!protocolValues.has(normalizedCandidate)) {
      return false;
    }

    return source?.type === 'text_mention' || source?.type === 'current_argument' || source?.type === 'existing_argument';
  }

  shouldDropImplicitInheritedArgument(group, index, resolvedGroups, extracted) {
    if (index === 0 || !group.argument) {
      return false;
    }

    if (!this.config.terminalGroupsDisallowImplicitInheritance.includes(group.type)) {
      return false;
    }

    if (extracted.hasExplicitLabelHit || extracted.values.length > 0) {
      return false;
    }

    const previousArguments = resolvedGroups
      .map(item => item && item.argument)
      .filter(Boolean)
      .map(value => this.normalizeComparable(value));

    return previousArguments.includes(this.normalizeComparable(group.argument));
  }

  deduplicateSignals(values = []) {
    const seen = new Set();
    const results = [];

    for (const item of values) {
      const key = `${item.type}:${this.normalizeComparable(item.value)}`;
      if (!item.value || seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(item);
    }

    return results;
  }

  extractPrefix24Candidates(raw) {
    const values = [];
    const explicitPrefixes = raw.match(/((?:\d{1,3}\.){3}\d{1,3}\/24)/g) || [];
    explicitPrefixes.forEach(item => values.push(item));

    const threeOctetMatches = raw.match(/(?<!\d)((?:\d{1,3}\.){2}\d{1,3})(?![\d./])/g) || [];
    threeOctetMatches.forEach(item => values.push(item));

    const fourOctetMatches = raw.match(/(?<!\d)((?:\d{1,3}\.){3}\d{1,3})(?![\d/])/g) || [];
    fourOctetMatches.forEach(item => values.push(item));

    return Array.from(new Set(
      values
        .map(value => this.normalizePrefix24Value(value))
        .filter(Boolean)
    ));
  }

  normalizePrefix24Value(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return '';
    }

    const withMask = raw.match(/^((?:\d{1,3}\.){3}\d{1,3})\/24$/);
    if (withMask) {
      const normalized = this.normalizeIpv4ToPrefix24(withMask[1]);
      return normalized ? `${normalized}/24` : '';
    }

    const threeOctets = raw.match(/^((?:\d{1,3}\.){2}\d{1,3})$/);
    if (threeOctets) {
      return `${threeOctets[1]}.0/24`;
    }

    const fourOctets = raw.match(/^((?:\d{1,3}\.){3}\d{1,3})$/);
    if (fourOctets) {
      const normalized = this.normalizeIpv4ToPrefix24(fourOctets[1]);
      return normalized ? `${normalized}/24` : '';
    }

    return '';
  }

  normalizeIpv4ToPrefix24(ip) {
    const parts = String(ip || '').split('.');
    if (parts.length !== 4) {
      return '';
    }

    const numbers = parts.map(item => Number(item));
    if (numbers.some(item => !Number.isInteger(item) || item < 0 || item > 255)) {
      return '';
    }

    return `${numbers[0]}.${numbers[1]}.${numbers[2]}.0`;
  }

  normalizeComparable(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[`"'“”‘’]/g, '')
      .replace(/\s+/g, '')
      .replace(/[()（）:：,_]/g, '');
  }

  isCandidateMentionedInText(candidate, text) {
    const normalizedCandidate = this.normalizeComparable(candidate.value || candidate.label);
    const normalizedText = this.normalizeComparable(text.raw);
    if (!normalizedCandidate || normalizedCandidate.length < 3) {
      return false;
    }

    return normalizedText.includes(normalizedCandidate);
  }

  escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

module.exports = new ArgumentResolutionService();
