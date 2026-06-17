'use strict';

const axios = require('axios');
const https = require('https');
const { URL, URLSearchParams } = require('url');

function normalizeHost(host = '') {
  const raw = String(host || '').trim();
  if (!raw) return null;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  url.username = '';
  url.password = '';
  return url.toString().replace(/\/$/, '');
}

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

function maskUrl(inputUrl = '') {
  try {
    const url = new URL(String(inputUrl || ''));
    for (const key of [...url.searchParams.keys()]) {
      if (/password|passwd|token|secret|authorization/i.test(key)) {
        url.searchParams.set(key, '***');
      }
    }
    return url.toString();
  } catch (_error) {
    return String(inputUrl || '');
  }
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.replace(/^\uFEFF/, '').trim();
  if (!text) return null;
  if (/^</.test(text)) return value;
  return JSON.parse(text);
}

class InspectionClient {
  constructor(options = {}) {
    this.host = options.host || process.env.NETINSIDE_HOST;
    this.username = options.username || process.env.NETINSIDE_USERNAME;
    this.password = options.password || process.env.NETINSIDE_PASSWORD;
    const tlsInsecureValue = options.tlsInsecure != null
      ? options.tlsInsecure
      : process.env.NETINSIDE_TLS_INSECURE;
    this.tlsInsecure = String(tlsInsecureValue || '').toLowerCase() === 'true';
    this.timeoutMs = Number(options.timeoutMs || process.env.NAPM_INSPECTION_TIMEOUT_MS || 30000);
    this.requestHistory = [];
    this.client = options.httpClient || axios.create({
      timeout: this.timeoutMs,
      httpsAgent: String(this.host || '').startsWith('https://')
        ? new https.Agent({ rejectUnauthorized: !this.tlsInsecure })
        : undefined,
      headers: {
        Accept: 'application/json,text/plain,*/*'
      }
    });
  }

  assertRuntimeAuth() {
    if (!this.host) {
      throw new Error('NETINSIDE_HOST is required for inspection requests.');
    }
    if (!this.username) {
      throw new Error('NETINSIDE_USERNAME is required for inspection requests.');
    }
    if (!this.password) {
      throw new Error('NETINSIDE_PASSWORD is required for inspection requests.');
    }
  }

  buildAuthParams() {
    this.assertRuntimeAuth();
    return {
      UserName: this.username,
      Password: this.password
    };
  }

  buildNetInsideUrl(type, params = {}) {
    const normalizedHost = normalizeHost(this.host);
    if (!normalizedHost) {
      throw new Error('NETINSIDE_HOST is required for inspection requests.');
    }
    const base = new URL(normalizedHost);
    const url = /\/webservice\/NetInside\/?$/i.test(base.pathname)
      ? base
      : new URL('/webservice/NetInside', normalizedHost);
    url.search = '';
    appendParams(url, {
      ...this.buildAuthParams(),
      type,
      ...params
    });
    if (type === 'packetsInfo' && !url.search.includes('%7B%7D') && !url.search.includes('{}')) {
      url.search = `${url.search}&{}`;
    }
    return url.toString();
  }

  buildAboutUrl(params = {}) {
    const normalizedHost = normalizeHost(this.host);
    if (!normalizedHost) {
      throw new Error('NETINSIDE_HOST is required for inspection requests.');
    }
    const url = new URL('/NetInside/About.jsp', normalizedHost);
    appendParams(url, {
      ...this.buildAuthParams(),
      ...params
    });
    return url.toString();
  }

  rememberRequest(type, url, extra = {}) {
    const record = {
      type,
      urlRedacted: maskUrl(url),
      ...extra
    };
    this.requestHistory.push(record);
    return record;
  }

  async requestUrl(type, url) {
    const record = this.rememberRequest(type, url);
    const response = await this.client.get(url);
    record.status = response.status;
    return {
      raw: response.data,
      requestUrlRedacted: record.urlRedacted,
      status: response.status
    };
  }

  async getJsonByType(type, params = {}) {
    const url = this.buildNetInsideUrl(type, params);
    const result = await this.requestUrl(type, url);
    return {
      ...result,
      data: parseMaybeJson(result.raw)
    };
  }

  async getApplianceInfo() {
    return this.getJsonByType('applianceInfo', { json: 'true' });
  }

  async getPacketsInfo() {
    return this.getJsonByType('packetsInfo', { json: 'true' });
  }

  async getAboutHtml() {
    const url = this.buildAboutUrl();
    const result = await this.requestUrl('About.jsp', url);
    return {
      ...result,
      data: String(result.raw || '')
    };
  }

  async getTimeValues(params = {}) {
    return this.getJsonByType('timeValues', { ...params, json: 'true' });
  }

  async getTopValues(params = {}) {
    return this.getJsonByType('topValues', { ...params, json: 'true' });
  }

  getRequestHistory() {
    return this.requestHistory.map((item) => ({ ...item }));
  }
}

module.exports = InspectionClient;
module.exports.normalizeHost = normalizeHost;
module.exports.maskUrl = maskUrl;
module.exports.parseMaybeJson = parseMaybeJson;
