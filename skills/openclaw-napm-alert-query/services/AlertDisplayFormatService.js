'use strict';

const ALERT_CATEGORY_SYMBOLS = Object.freeze(['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨']);

function normalizeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

function formatCategoryIndex(index) {
  const numericIndex = Number(index);
  if (Number.isInteger(numericIndex) && numericIndex > 0) {
    return ALERT_CATEGORY_SYMBOLS[numericIndex - 1] || `${numericIndex}.`;
  }
  return '•';
}

/**
 * Use a heading plus bold markers so both Markdown-capable and limited
 * enterprise chat renderers give category summaries a stable visual level.
 */
function formatAlertCategoryHeading({ index, label, total, bySeverity = {} } = {}) {
  const categoryLabel = String(label || '').trim() || '未知告警';
  const critical = normalizeCount(bySeverity.critical);
  const major = normalizeCount(bySeverity.major);
  const minor = normalizeCount(bySeverity.minor);
  return `# **${formatCategoryIndex(index)} ${categoryLabel} — ${normalizeCount(total)} 条（🔴 ${critical} / 🟠 ${major} / 🟢 ${minor}）**`;
}

module.exports = {
  ALERT_CATEGORY_SYMBOLS,
  formatCategoryIndex,
  formatAlertCategoryHeading,
};
