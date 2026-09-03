'use strict';

const SUPPORTED_GRANULARITIES = Object.freeze([60, 300, 3600, 86400]);
const SIX_HOURS_SECONDS = 6 * 3600;
const THREE_DAYS_SECONDS = 3 * 24 * 3600;
const DAILY_GRANULARITY_THRESHOLD_SECONDS = 3600000;

function selectGranularityForDuration(durationSeconds) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return 60;
  if (duration <= SIX_HOURS_SECONDS) return 60;
  if (duration <= THREE_DAYS_SECONDS) return 300;
  if (duration < DAILY_GRANULARITY_THRESHOLD_SECONDS) return 3600;
  return 86400;
}

function selectGranularityForRange(start, end) {
  const startSeconds = Number(start);
  const endSeconds = Number(end);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) return 60;
  return selectGranularityForDuration(Math.abs(endSeconds - startSeconds));
}

module.exports = {
  SUPPORTED_GRANULARITIES,
  SIX_HOURS_SECONDS,
  THREE_DAYS_SECONDS,
  DAILY_GRANULARITY_THRESHOLD_SECONDS,
  selectGranularityForDuration,
  selectGranularityForRange
};
