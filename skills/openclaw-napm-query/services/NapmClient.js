const axios = require('axios');
const https = require('https');
const logger = require('../../../src/utils/logger');
const { maskSensitiveParams, buildSafeUrl, buildOrderedParams } = require('../../../src/utils/auditLogger');

class NapmClient {
  constructor() {
    this.baseUrl = process.env.NETINSIDE_HOST || 'https://101.254.114.238/webservice/NetInside';
    this.username = process.env.NETINSIDE_USERNAME || 'admin';
    this.password = process.env.NETINSIDE_PASSWORD || 'admin';
    this.tlsInsecure = String(process.env.NETINSIDE_TLS_INSECURE || '').toLowerCase() === 'true';
    
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      httpsAgent: this.baseUrl.startsWith('https://')
        ? new https.Agent({ rejectUnauthorized: !this.tlsInsecure })
        : undefined,
      headers: {
        'Accept': 'application/json,text/csv'
      }
    });
    
    logger.info('NapmClient initialized', {
      baseUrl: this.baseUrl,
      username: this.username
    });
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
