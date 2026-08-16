const axios = require('axios');
const https = require('https');
const logger = require('../src/utils/logger');
const { maskSensitiveParams, buildSafeUrl, buildOrderedParams } = require('../src/utils/auditLogger');

class NapmClient {
  constructor() {
    this.initialized = false;
    this._baseUrl = null;
    this._username = null;
    this._password = null;
    this._tlsInsecure = false;
    this._client = null;
  }

  ensureInitialized() {
    if (this.initialized) {
      return;
    }

    this._baseUrl = this.getRequiredEnv('NETINSIDE_HOST');
    this._username = this.getRequiredEnv('NETINSIDE_USERNAME');
    this._password = this.getRequiredEnv('NETINSIDE_PASSWORD');
    this._tlsInsecure = String(process.env.NETINSIDE_TLS_INSECURE || '').toLowerCase() === 'true';

    this._client = axios.create({
      baseURL: this._baseUrl,
      timeout: 30000,
      httpsAgent: this._baseUrl.startsWith('https://')
        ? new https.Agent({ rejectUnauthorized: !this._tlsInsecure })
        : undefined,
      headers: {
        Accept: 'application/json,text/csv'
      }
    });

    this.initialized = true;
    logger.info('NapmClient initialized', {
      baseUrl: this._baseUrl,
      username: this._username
    });
  }

  get baseUrl() {
    this.ensureInitialized();
    return this._baseUrl;
  }

  get username() {
    this.ensureInitialized();
    return this._username;
  }

  get password() {
    this.ensureInitialized();
    return this._password;
  }

  get tlsInsecure() {
    this.ensureInitialized();
    return this._tlsInsecure;
  }

  get client() {
    this.ensureInitialized();
    return this._client;
  }

  getRequiredEnv(name) {
    const value = String(process.env[name] || '').trim();
    if (!value) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
  }

  async get(params) {
    const queryParams = buildOrderedParams({
      UserName: this.username,
      Password: this.password,
      ...params
    });

    try {
      logger.info('Making NAPM API request', {
        queryParams: maskSensitiveParams(queryParams),
        url: buildSafeUrl(this.baseUrl, queryParams)
      });

      const response = await this.client.get('', {
        params: queryParams
      });

      logger.info('NAPM API response received', {
        status: response.status,
        dataLength: typeof response.data === 'string' ? response.data.length : undefined
      });

      return response.data;
    } catch (error) {
      logger.error('NAPM API request failed', {
        error: error.message,
        params: maskSensitiveParams(queryParams),
        response: error.response ? error.response.data : null
      });
      throw new Error(`NAPM API error: ${error.message}`);
    }
  }

  async post(data) {
    const requestData = buildOrderedParams({
      UserName: this.username,
      Password: this.password,
      ...data
    });

    try {
      logger.info('Making NAPM API POST request', {
        requestData: maskSensitiveParams(requestData)
      });

      const response = await this.client.post('', requestData);

      logger.info('NAPM API POST response received', {
        status: response.status
      });

      return response.data;
    } catch (error) {
      logger.error('NAPM API POST request failed', {
        error: error.message,
        data: maskSensitiveParams(requestData)
      });
      throw new Error(`NAPM API error: ${error.message}`);
    }
  }

  async getJson(params) {
    const raw = await this.get({
      ...params,
      json: 'true'
    });

    if (typeof raw === 'object' && raw !== null) {
      return raw;
    }

    if (typeof raw === 'string') {
      return JSON.parse(raw);
    }

    return raw;
  }
}

module.exports = NapmClient;
