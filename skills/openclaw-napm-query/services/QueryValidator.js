const logger = require('../src/utils/logger');

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

    const hasStart = target.start !== undefined && target.start !== null && target.start !== '';
    const hasEnd = target.end !== undefined && target.end !== null && target.end !== '';
    const startNumber = Number(target.start);
    const endNumber = Number(target.end);
    const hasValidStart = hasStart
      && Number.isFinite(startNumber)
      && Number.isInteger(startNumber)
      && startNumber > 0;
    const hasValidEnd = hasEnd
      && Number.isFinite(endNumber)
      && Number.isInteger(endNumber)
      && endNumber > 0;

    if (!hasStart || !hasEnd) {
      errors.push('Start and end timestamps are required');
    }

    if ((hasStart && !hasValidStart) || (hasEnd && !hasValidEnd)) {
      errors.push('Start and end timestamps must be positive integer Unix seconds');
    }

    if (hasValidStart && hasValidEnd && startNumber >= endNumber) {
      errors.push('Start timestamp must be before end timestamp');
    }

    if (
      hasStart
      && hasEnd
      && hasValidStart
      && hasValidEnd
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
      const querySummary = {
        service: target.service || null,
        start: Number.isFinite(Number(target.start)) ? Number(target.start) : null,
        end: Number.isFinite(Number(target.end)) ? Number(target.end) : null,
        metricCount: Array.isArray(target.metrics) ? target.metrics.length : (target.metric ? 1 : 0),
        groupTypes: Array.isArray(target.groups)
          ? target.groups.map((group) => String(group?.type || '').trim()).filter(Boolean)
          : []
      };
      if (mode === 'gateway') {
        logger.error('Structured query validation failed', { errors, querySummary });
      } else {
        logger.error('Query validation failed', { errors, querySummary });
      }
      const error = new Error(errors.join('; '));
      error.code = 'QUERY_SHAPE_INVALID';
      error.details = {
        mode,
        errors,
        service: target.service || null
      };
      throw error;
    }

    if (mode === 'gateway') {
      logger.info('Structured query validation passed', { service: target.service });
    } else {
      logger.info('Query validation passed', { service: target.service });
    }

    return target;
  }
}

module.exports = new QueryValidator();
