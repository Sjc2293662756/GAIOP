'use strict';

const DEFAULT_PAGE_VIEWS_LIMIT = 20;
// This is a local client protection limit, not a documented upstream maximum.
const PAGE_VIEWS_PROTECTIVE_LIMIT = 200;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function firstDefined(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
      return source[key];
    }
  }
  return null;
}

function normalizeNumeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

function normalizePageViewsMaxLimit(value, options = {}) {
  const protectiveLimit = Number.isInteger(Number(options.protectiveLimit))
    && Number(options.protectiveLimit) > 0
    ? Number(options.protectiveLimit)
    : PAGE_VIEWS_PROTECTIVE_LIMIT;
  const candidate = value === undefined || value === null || value === ''
    ? DEFAULT_PAGE_VIEWS_LIMIT
    : Number(value);
  if (!Number.isInteger(candidate) || candidate <= 0) {
    const error = new Error('pageViews.maxLimit must be a positive integer.');
    error.code = 'PAGE_VIEWS_MAX_LIMIT_INVALID';
    throw error;
  }
  if (candidate > protectiveLimit) {
    const error = new Error(`pageViews.maxLimit exceeds the local protective limit of ${protectiveLimit}.`);
    error.code = 'PAGE_VIEWS_MAX_LIMIT_EXCEEDED';
    error.details = { protectiveLimit };
    throw error;
  }
  return candidate;
}

function extractPageFamilyId(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return '';
  const direct = firstDefined(row, ['pageFamilyId', 'pageFamilyID', 'PageFamilyId', 'PageFamilyID', 'id']);
  if (direct != null && /^\d+$/.test(normalizeText(direct))) return normalizeText(direct);
  const groupPath = normalizeText(firstDefined(row, ['groupPath', 'path', 'group_path']));
  const match = groupPath.match(/page\s+(\d+)\//i)
    || groupPath.match(/pageFamilyId[=: ]+(\d+)/i)
    || groupPath.match(/PageFamily[^\d]+(\d+)/i);
  return match ? match[1] : '';
}

function extractDetailIdFromText(value, loose = false) {
  const text = normalizeText(value);
  if (!text) return '';
  const withoutPath = text.replace(/^PATH1\//, '');
  const rightSide = withoutPath.includes('##') ? withoutPath.split('##').pop() : withoutPath;
  const match = rightSide.match(/\d+-\d+---\d+(?:\.\d+)?-\d+(?:\.\d+)?-[0-9a-fA-F:.]+/);
  if (match) return match[0];
  return loose || withoutPath.includes('##') ? rightSide : '';
}

function extractPageFamilyDetailId(row, seen = new Set()) {
  if (!row) return '';
  if (typeof row === 'string') return extractDetailIdFromText(row, false);
  if (typeof row !== 'object') return '';
  if (seen.has(row)) return '';
  seen.add(row);
  if (Array.isArray(row)) {
    for (let index = row.length - 1; index >= 0; index -= 1) {
      const found = extractPageFamilyDetailId(row[index], seen);
      if (found) return found;
    }
    return '';
  }
  const direct = firstDefined(row, [
    'pageFamilyDetailId',
    'pageFamilyDetailID',
    'PageFamilyDetailId',
    'PageFamilyDetailID',
    'resultName',
    'instanceId'
  ]);
  if (direct != null) return extractDetailIdFromText(direct, true);
  for (const value of Object.values(row).reverse()) {
    const found = extractPageFamilyDetailId(value, seen);
    if (found) return found;
  }
  return '';
}

function extractRowsFromPageViewsPayload(payload, seen = new Set()) {
  if (Array.isArray(payload)) return payload;
  if (payload == null || payload === '') return [];
  if (typeof payload === 'string') {
    try {
      return extractRowsFromPageViewsPayload(JSON.parse(payload), seen);
    } catch (_error) {
      const error = new Error('pageViews returned a non-JSON payload.');
      error.code = 'PAGE_VIEWS_RESPONSE_INVALID';
      throw error;
    }
  }
  if (typeof payload !== 'object') return [];
  if (seen.has(payload)) {
    const error = new Error('pageViews returned a cyclic payload.');
    error.code = 'PAGE_VIEWS_RESPONSE_INVALID';
    throw error;
  }
  seen.add(payload);
  for (const key of ['rows', 'data', 'result', 'results', 'items', 'list']) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && ['object', 'string'].includes(typeof payload[key])) {
      return extractRowsFromPageViewsPayload(payload[key], seen);
    }
  }
  return [payload];
}

function normalizePageViewRows(payload) {
  return extractRowsFromPageViewsPayload(payload).map((row, index) => {
    const source = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    const pageFamilyDetailId = extractPageFamilyDetailId(source);
    return {
      index: index + 1,
      rowRef: `page-view:${index + 1}`,
      startTime: firstDefined(source, ['startTime', 'StartTime', 'time', 'timestamp']),
      page: firstDefined(source, ['page', 'Page', 'url', 'uri']),
      clientIp: firstDefined(source, ['clientIp', 'clientIP', 'ClientIp', 'client', 'originatingIp']),
      serverIp: firstDefined(source, ['serverIp', 'serverIP', 'ServerIp', 'server']),
      originatingIp: firstDefined(source, ['originatingIp', 'OriginatingIp']),
      httpStatus: normalizeNumeric(firstDefined(source, ['httpStatus', 'HttpStatus', 'statusCode', 'status', 'responseCode'])),
      http200S: normalizeNumeric(firstDefined(source, ['http200S', 'Http200S'])) ?? 0,
      http400S: normalizeNumeric(firstDefined(source, ['http400S', 'Http400S'])) ?? 0,
      http500S: normalizeNumeric(firstDefined(source, ['http500S', 'Http500S'])) ?? 0,
      httpResponses: normalizeNumeric(firstDefined(source, ['httpResponses', 'HttpResponses'])),
      pageTime: normalizeNumeric(firstDefined(source, ['pageTime', 'PageTime'])),
      pageTraffic: normalizeNumeric(firstDefined(source, ['pageTraffic', 'PageTraffic'])),
      requestTraffic: normalizeNumeric(firstDefined(source, ['requestTraffic', 'RequestTraffic'])),
      userAgent: firstDefined(source, ['userAgent', 'UserAgent']),
      pageFamilyDetailId: pageFamilyDetailId || null,
      instanceId: pageFamilyDetailId ? `PATH1/${pageFamilyDetailId}` : null
    };
  });
}

function failure(code, message, details = null) {
  return {
    ok: false,
    code,
    reason: code.toLowerCase(),
    message,
    ...(details ? { details } : {})
  };
}

function validatePageViewsQuery(query = {}, options = {}) {
  const target = query && typeof query === 'object' && !Array.isArray(query) ? query : {};
  if (normalizeText(target.service) !== 'pageViews') {
    return failure('PAGE_VIEWS_SERVICE_REQUIRED', 'pageViews detail execution requires service=pageViews.');
  }
  if (normalizeText(target.queryModeKey) !== 'detail') {
    return failure('PAGE_VIEWS_QUERY_MODE_INVALID', 'pageViews only accepts queryModeKey=detail.');
  }

  const groups = Array.isArray(target.groups) ? target.groups.filter(Boolean) : [];
  if (groups.some((group) => normalizeText(group?.type) === 'PageFamilyDetail')) {
    return failure(
      'PAGE_FAMILY_DETAIL_GROUP_FORBIDDEN',
      'PageFamilyDetail is not a query group. Use pageViews with a trusted pageFamilyId.'
    );
  }
  const forbiddenFields = ['groups', 'metrics', 'metric', 'topMetric', 'granularity']
    .filter((field) => {
      const value = target[field];
      return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '';
    });
  if (forbiddenFields.length > 0) {
    return failure(
      'PAGE_VIEWS_QUERY_FIELDS_FORBIDDEN',
      `pageViews does not accept metric/group fields: ${forbiddenFields.join(', ')}.`,
      { forbiddenFields }
    );
  }

  const pageFamilyId = normalizeText(target.pageFamilyId);
  if (!pageFamilyId) {
    return failure('PAGE_FAMILY_ID_REQUIRED', 'pageViews requires a trusted pageFamilyId or a resolvable resultReference.');
  }
  if (!/^\d+$/.test(pageFamilyId)) {
    return failure('PAGE_FAMILY_ID_INVALID', 'pageViews.pageFamilyId must be a numeric NAPM page family identifier.');
  }

  let maxLimit;
  try {
    maxLimit = normalizePageViewsMaxLimit(target.maxLimit, options);
  } catch (error) {
    return failure(error.code || 'PAGE_VIEWS_MAX_LIMIT_INVALID', error.message, error.details || null);
  }

  if (options.validateTime !== false) {
    const hasDeclarativeTime = options.phase === 'construction'
      && Boolean(normalizeText(target?.timeRange?.key));
    const start = Number(target.start);
    const end = Number(target.end);
    if (!hasDeclarativeTime && (
      !Number.isInteger(start)
      || !Number.isInteger(end)
      || start <= 0
      || end <= start
      || start % 60 !== 0
      || end % 60 !== 0
    )) {
      return failure('PAGE_VIEWS_TIME_RANGE_INVALID', 'pageViews requires minute-aligned root start/end timestamps.');
    }
  }

  return {
    ok: true,
    query: {
      ...target,
      pageFamilyId,
      maxLimit
    }
  };
}

function buildPageViewsParams(query = {}, options = {}) {
  const validation = validatePageViewsQuery(query, options);
  if (!validation.ok) {
    const error = new Error(validation.message);
    error.code = validation.code;
    error.details = validation.details || null;
    throw error;
  }
  return {
    type: 'pageViews',
    start: Number(validation.query.start),
    end: Number(validation.query.end),
    json: 'true',
    pageFamilyId: validation.query.pageFamilyId,
    maxLimit: validation.query.maxLimit
  };
}

module.exports = {
  DEFAULT_PAGE_VIEWS_LIMIT,
  PAGE_VIEWS_PROTECTIVE_LIMIT,
  buildPageViewsParams,
  extractPageFamilyDetailId,
  extractPageFamilyId,
  extractRowsFromPageViewsPayload,
  normalizePageViewRows,
  normalizePageViewsMaxLimit,
  validatePageViewsQuery
};
