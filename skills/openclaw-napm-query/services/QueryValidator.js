const logger = require('../../../src/utils/logger');

const VALID_SERVICES = new Set([
  'topValues',
  'averageValues',
  'timeValues',
  'groups',
  'metrics',
  'alertsSummary'
]);

class QueryValidator {
  validate(queryRequest) {
    return this.validateCore(queryRequest, 'query');
  }

  validateGatewayRequest(gatewayRequest) {
    return this.validateCore(gatewayRequest, 'gateway');
  }

  validateCore(request, mode = 'query') {
    const target = request && typeof request === 'object' ? request : {};
    const errors = [];

    if (!target.service) {
      errors.push('Service type is required');
    }

    const hasStart = Boolean(target.start);
    const hasEnd = Boolean(target.end);
    const startNumber = Number(target.start);
    const endNumber = Number(target.end);

    if (!hasStart || !hasEnd) {
      errors.push('Start and end timestamps are required');
    }

    if (Number.isFinite(startNumber) && Number.isFinite(endNumber) && startNumber > endNumber) {
      errors.push('Start timestamp must be before end timestamp');
    }

    if (
      hasStart
      && hasEnd
      && Number.isFinite(startNumber)
      && Number.isFinite(endNumber)
      && (startNumber % 60 !== 0 || endNumber % 60 !== 0)
    ) {
      errors.push('Start and end timestamps must be aligned to 60-second minute boundaries');
    }

    if (target.service && !VALID_SERVICES.has(target.service)) {
      errors.push(`Invalid service type: ${target.service}`);
    }

    if (target.service === 'topValues') {
      if (!target.metric) {
        errors.push('Metric is required for topValues service');
      }
      if (!target.topCount || target.topCount <= 0) {
        target.topCount = 20;
      }
    }

    if (target.service === 'averageValues' || target.service === 'timeValues') {
      if (!Array.isArray(target.metrics) || target.metrics.length === 0) {
        errors.push('Metrics array is required for averageValues and timeValues services');
      }
    }

    if (target.service === 'timeValues' && !target.granularity) {
      errors.push('Granularity is required for timeValues service');
    }

    if (errors.length > 0) {
      if (mode === 'gateway') {
        logger.error('Gateway request validation failed', { errors, gatewayRequest: target });
      } else {
        logger.error('Query validation failed', { errors, queryRequest: target });
      }
      throw new Error(errors.join('; '));
    }

    if (mode === 'gateway') {
      logger.info('Gateway request validation passed', { service: target.service });
    } else {
      logger.info('Query validation passed', { service: target.service });
    }

    return target;
  }
}

module.exports = new QueryValidator();
