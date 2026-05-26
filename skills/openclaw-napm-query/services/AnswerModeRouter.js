function normalizeMode(value = '') {
  const text = String(value || '').trim().toLowerCase();
  if (['debug', 'debug_trace', 'debug_trace_mode', 'trace'].includes(text)) {
    return 'debug_trace_mode';
  }
  return 'final_answer_mode';
}

function resolveAnswerMode(payload = {}, options = {}) {
  return normalizeMode(
    options.answerMode
    || payload.answerMode
    || payload.outputMode
    || payload?.resolvedQuery?.answerMode
    || payload?.resolvedQuery?.outputMode
    || process.env.NAPM_ANSWER_MODE
    || ''
  );
}

function buildRenderPolicy(payload = {}, options = {}) {
  const answerMode = resolveAnswerMode(payload, options);
  const debugMode = answerMode === 'debug_trace_mode';
  return {
    answerMode,
    language: 'zh-CN',
    narrationRequired: true,
    target: debugMode ? 'debug_trace_reply' : 'final_user_reply',
    includeDebugTrace: debugMode,
    allowIntermediateAttempts: debugMode,
    allowFailedHypotheses: debugMode,
    preferSources: debugMode
      ? [
          'failureClassification',
          'resolvedQuery',
          'request',
          'result.narrationStructure',
          'summary',
          'result.rows'
        ]
      : [
          'result.narrationStructure',
          'summary',
          'result.structuredRows',
          'result.rows',
          'result.structuredSeries',
          'result.overview'
        ],
    fallbackSources: debugMode
      ? ['displayText', 'replyText', 'error']
      : ['displayText', 'replyText'],
    rules: debugMode
      ? [
          'Debug trace mode may include workflow, object type, provider, request parameters and failure category.',
          'Clearly separate failed attempts from final execution state.',
          'Do not present failed hypotheses as data conclusions.'
        ]
      : [
          'Final answer mode must use only the final confirmed skill result.',
          'Do not mention intermediate attempts, ports, fallback probes, or failed hypotheses.',
          'If failureClassification exists, explain the standard failure category instead of guessing a data conclusion.',
          'Always include result timeRange/displayText when present.'
        ]
  };
}

function shouldForwardDisplayText(payload = {}, options = {}) {
  const answerMode = resolveAnswerMode(payload, options);
  if (answerMode === 'debug_trace_mode') {
    return true;
  }
  if (payload?.error?.failureClassification) {
    return false;
  }
  return Boolean(options.forwardDisplayText);
}

module.exports = {
  resolveAnswerMode,
  buildRenderPolicy,
  shouldForwardDisplayText
};
