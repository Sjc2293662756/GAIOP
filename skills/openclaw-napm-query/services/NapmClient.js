/**
 * NapmClient.js
 *
 * 封装访问 NAPM / NetInside 上游接口的基础 HTTP 客户端。
 * 负责读取连接环境变量、统一拼装鉴权参数、记录审计日志，以及提供 GET/POST/JSON 辅助方法。
 */
const axios = require('axios');
const https = require('https');
const logger = require('../../../src/utils/logger');
const { maskSensitiveParams, buildSafeUrl, buildOrderedParams } = require('../../../src/utils/auditLogger');
class NapmClient {
  // 初始化 axios 客户端，并按环境变量决定是否关闭 TLS 证书校验。
  constructor() {
    this.baseUrl = this.getRequiredEnv('NETINSIDE_HOST');
    this.username = this.getRequiredEnv('NETINSIDE_USERNAME');
    this.password = this.getRequiredEnv('NETINSIDE_PASSWORD');
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

  /**
   * 读取必须存在的环境变量。
   * 缺失时直接抛错，避免客户端在半初始化状态下继续运行。
   */
  getRequiredEnv(name) {
    const value = String(process.env[name] || '').trim();
    if (!value) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
  }

  /**
   * 发送 GET 请求，并自动补齐用户名密码等查询参数。
   */
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

  /**
   * 发送 POST 请求，并自动补齐用户名密码等表单参数。
   */
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

  /**
   * 获取 JSON 结果。
   * 当上游返回的是 JSON 字符串时，这里会负责做一次解析。
   */
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
