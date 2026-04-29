const fs = require('fs');
const path = require('path');

class ScopeContextPreservationService {
  constructor() {
    const configPath = path.join(__dirname, '../../../config/scope-context-preservation.v1.json');
    this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  preserve(query, originalText = '', objectDisambiguation = null) {
    const resolvedQuery = this.cloneQuery(query);
    const warnings = [];
    const contextGroups = [];

    if (!resolvedQuery || !Array.isArray(resolvedQuery.groups) || resolvedQuery.groups.length === 0) {
      return {
        query: resolvedQuery,
        shouldApply: false,
        warnings,
        contextGroups,
        evidence: {
          targetGroup: null,
          candidateContexts: []
        }
      };
    }

    const targetGroup = resolvedQuery.groups[resolvedQuery.groups.length - 1]?.type || null;
    if (!this.config.childTargetGroups.includes(targetGroup)) {
      return {
        query: resolvedQuery,
        shouldApply: false,
        warnings,
        contextGroups,
        evidence: {
          targetGroup,
          candidateContexts: []
        }
      };
    }

    const candidateContexts = this.collectContextCandidates(objectDisambiguation, originalText, resolvedQuery);
    const selectedContexts = candidateContexts.filter(item => item.score >= this.config.thresholds.autoPreserve);

    if (selectedContexts.length === 0) {
      return {
        query: resolvedQuery,
        shouldApply: false,
        warnings,
        contextGroups,
        evidence: {
          targetGroup,
          candidateContexts
        }
      };
    }

    selectedContexts.forEach(item => {
      contextGroups.push({
        type: item.type,
        argument: item.argument,
        confidence: item.score,
        reasons: item.reasons
      });
    });

    resolvedQuery.contextGroups = contextGroups.map(item => ({
      type: item.type,
      argument: item.argument
    }));

    return {
      query: resolvedQuery,
      shouldApply: true,
      warnings,
      contextGroups,
      evidence: {
        targetGroup,
        candidateContexts,
        selectedContexts
      }
    };
  }

  evaluateExecution(query, pathPlan, dynamicMetadataReview = null) {
    const resolvedQuery = this.cloneQuery(query);
    const contextGroups = Array.isArray(resolvedQuery?.contextGroups)
      ? resolvedQuery.contextGroups.filter(item => item && item.type && item.argument)
      : [];

    if (!resolvedQuery || contextGroups.length === 0) {
      return {
        query: resolvedQuery,
        blocked: false,
        reason: null
      };
    }

    const targetGroup = resolvedQuery.groups?.[resolvedQuery.groups.length - 1]?.type || null;
    const plannedGroups = Array.isArray(pathPlan?.plannedGroups) ? pathPlan.plannedGroups : [];
    const hasScopedPath = Boolean(
      targetGroup &&
      plannedGroups.length > 1 &&
      plannedGroups[plannedGroups.length - 1]?.type === targetGroup &&
      contextGroups.every(context => plannedGroups.some(group => (
        group.type === context.type &&
        group.argument === context.argument
      )))
    );

    const metadataIssues = Array.isArray(dynamicMetadataReview?.issues) ? dynamicMetadataReview.issues : [];
    const hasBlockingMetadataIssue = metadataIssues.some(issue => (
      String(issue).startsWith('group_not_found:') ||
      String(issue).startsWith('group_cannot_query:') ||
      String(issue).startsWith('metrics_for_group_empty:') ||
      String(issue).startsWith('metric_not_supported_for_group:')
    ));

    if (hasScopedPath && !hasBlockingMetadataIssue) {
      return {
        query: resolvedQuery,
        blocked: false,
        reason: null
      };
    }

    resolvedQuery.executionGuard = {
      blockExecution: true,
      code: 'SCOPED_DESCENT_UNRESOLVED',
      message: '当前识别到了上层范围对象，但暂时无法将该范围精确带入下钻查询，已阻止退化为全局排行。',
      details: {
        targetGroup,
        contextGroups,
        plannedGroups,
        metadataIssues
      }
    };

    return {
      query: resolvedQuery,
      blocked: true,
      reason: resolvedQuery.executionGuard
    };
  }

  collectContextCandidates(objectDisambiguation, originalText, query) {
    const targetGroup = query.groups?.[query.groups.length - 1]?.type || null;
    const directGroups = Array.isArray(query.groups) ? query.groups : [];
    const text = String(originalText || '').trim().toLowerCase();
    const pool = [
      ...((Array.isArray(objectDisambiguation?.candidates) ? objectDisambiguation.candidates : [])),
      ...((Array.isArray(objectDisambiguation?.suggestions) ? objectDisambiguation.suggestions : []))
    ];
    const seen = new Set();

    return pool
      .filter(candidate => (
        candidate &&
        this.config.scopeGroups.includes(candidate.type) &&
        candidate.argument &&
        candidate.type !== targetGroup
      ))
      .filter(candidate => !directGroups.some(group => group.type === candidate.type && group.argument === candidate.argument))
      .filter(candidate => this.isStrongEnoughContext(candidate, text))
      .filter(candidate => {
        const key = `${candidate.type}:${candidate.argument}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .map(candidate => ({
        type: candidate.type,
        argument: candidate.argument,
        score: Number(candidate.score || 0),
        reasons: Array.isArray(candidate.reasons) ? candidate.reasons : []
      }))
      .sort((a, b) => b.score - a.score);
  }

  isStrongEnoughContext(candidate, text) {
    const reasons = Array.isArray(candidate.reasons) ? candidate.reasons : [];
    if (reasons.some(reason => this.config.reasonHints.some(hint => String(reason).startsWith(hint)))) {
      return true;
    }

    return Boolean(candidate.argument && text.includes(String(candidate.argument).toLowerCase()));
  }

  cloneQuery(query) {
    return query ? JSON.parse(JSON.stringify(query)) : query;
  }
}

module.exports = new ScopeContextPreservationService();
