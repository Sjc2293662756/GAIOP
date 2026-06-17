'use strict';

const axios = require('axios');
const https = require('https');
const { URL, URLSearchParams } = require('url');

function normalizeHost(host = '') {
  const raw = String(host || '').trim();
  if (!raw) return null;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withProtocol);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
  } catch (_error) {
    return withProtocol;
  }
}

function buildNetInsideUrl(host, params = {}) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) {
    throw new Error('NETINSIDE_HOST is required.');
  }

  const base = new URL(normalizedHost);
  const isNetInsidePath = /\/webservice\/NetInside\/?$/i.test(base.pathname);
  const url = isNetInsidePath ? base : new URL('/webservice/NetInside', normalizedHost);
  url.search = '';

  const searchParams = params instanceof URLSearchParams ? params : new URLSearchParams();
  if (!(params instanceof URLSearchParams)) {
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) searchParams.append(key, String(item));
      } else {
        searchParams.set(key, String(value));
      }
    }
  }

  url.search = searchParams.toString();
  return url.toString();
}

function maskUrl(inputUrl = '') {
  try {
    const url = new URL(inputUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (/password|passwd|token|secret|authorization/i.test(key)) {
        url.searchParams.set(key, '***');
      }
    }
    return url.toString();
  } catch (_error) {
    return inputUrl;
  }
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  return JSON.parse(value);
}

class AlertApiService {
  constructor(options = {}) {
    this.host = options.host || process.env.NETINSIDE_HOST;
    this.username = options.username || process.env.NETINSIDE_USERNAME;
    this.password = options.password || process.env.NETINSIDE_PASSWORD;
    const tlsInsecureValue = options.tlsInsecure != null
      ? options.tlsInsecure
      : (process.env.NETINSIDE_TLS_INSECURE || '');
    this.tlsInsecure = String(tlsInsecureValue).toLowerCase() === 'true';
    this.timeoutMs = Number(options.timeoutMs || process.env.NAPM_ALERT_TIMEOUT_MS || 30000);
    this.requestHistory = [];
    this.client = axios.create({
      timeout: this.timeoutMs,
      httpsAgent: this.host && String(this.host).startsWith('https://')
        ? new https.Agent({ rejectUnauthorized: !this.tlsInsecure })
        : undefined,
      headers: {
        Accept: 'application/json,text/plain,*/*',
      },
    });
  }

  buildParams(type, params = {}) {
    const searchParams = new URLSearchParams();
    if (this.username) searchParams.set('UserName', this.username);
    if (this.password) searchParams.set('Password', this.password);
    searchParams.set('type', type);
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) searchParams.append(key, String(item));
      } else {
        searchParams.set(key, String(value));
      }
    }
    return searchParams;
  }

  buildUrl(type, params = {}) {
    return buildNetInsideUrl(this.host, this.buildParams(type, params));
  }

  async getJsonByParams(type, params = {}) {
    const url = this.buildUrl(type, params);
    this.requestHistory.push(maskUrl(url));
    const response = await this.client.get(url);
    return parseMaybeJson(response.data);
  }

  getRequestHistory() {
    return this.requestHistory.slice();
  }

  getLastRequestUrl() {
    return this.requestHistory[this.requestHistory.length - 1] || '';
  }

  async getSummary({ start, end }) {
    return this.getJsonByParams('alertsSummary', {
      start,
      end,
      json: 'true',
    });
  }

  async getTimeline({ start, end }) {
    return this.getJsonByParams('alertsSummaryTimeLine', {
      start,
      end,
      json: 'true',
    });
  }

  async getDetail({ eventIds, start, end }) {
    return this.getJsonByParams('alertsDetail', {
      eventids: eventIds,
      start,
      end,
      json: 'true',
    });
  }

  async getMetricSeries({ metric, groupType, group, start, end, granularity = 60 }) {
    return this.getJsonByParams('timeValues', {
      start,
      end,
      metrics: metric,
      granularity,
      numGroups: 1,
      groupType1: groupType,
      groupArgument1: group,
      json: 'true',
    });
  }
}

module.exports = AlertApiService;
module.exports.buildNetInsideUrl = buildNetInsideUrl;
module.exports.normalizeHost = normalizeHost;
module.exports.maskUrl = maskUrl;
