'use strict';

const {
  OBJECT_METRIC_COVERAGE
} = require('../src/constants/objectMetricOwnership');

function getVerifiedProductBaseline(env = process.env) {
  const candidate = String(env?.NAPM_VERIFIED_PRODUCT_BASELINE || '').trim();
  if (!candidate) return '';
  return OBJECT_METRIC_COVERAGE.some((entry) => (
    entry.supportedProductBaseline === candidate
  )) ? candidate : '';
}

module.exports = {
  getVerifiedProductBaseline
};
