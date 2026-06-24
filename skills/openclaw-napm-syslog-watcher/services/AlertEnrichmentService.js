'use strict';

/**
 * AlertEnrichmentService — 调 NAPM WebService API 获取告警详细信息。
 *
 * NAPM API 是 GET 请求，参数通过 URL query string 传递：
 *   https://{host}/webservice/NetInside?UserName=xxx&Password=xxx&type=alertsDetail&eventids=113&start=...&end=...&json=true
 *
 * 在 Syslog 中只能拿到 alertId 和基本字段（名称、严重级别等）。
 * 本服务通过 NAPM 的 alertsDetail 接口补充触发条件、监控对象、
 * 告警描述、恢复状态等详细字段，使企业微信推送内容更完整。
 */

const axios = require('axios');
const https = require('https');
const { URL, URLSearchParams } = require('url');

class AlertEnrichmentService {
  /**
   * @param {object} config - watcher 配置对象
   * @param {object} config.napm - NAPM API 连接配置
   * @param {string} config.napm.host - NAPM 主机地址
   * @param {string} config.napm.username - NAPM 用户名
   * @param {string} config.napm.password - NAPM 密码
   * @param {boolean} config.napm.tlsInsecure - 是否跳过 TLS 证书验证
   * @param {number} config.napm.requestTimeoutMs - 请求超时（毫秒）
   */
  constructor(config) {
    const napm = config.napm || {};

    // 主机地址：支持带或不带协议前缀、带或不带 /webservice/NetInside 路径
    this.host = this._normalizeHost(napm.host || napm.baseUrl || 'https://101.254.114.238/webservice/NetInside');
    this.username = napm.username || 'GAIOP';
    this.password = napm.password || '';
    this.tlsInsecure = napm.tlsInsecure === true;
    this.requestTimeoutMs = napm.requestTimeoutMs || 15000;

    this.client = axios.create({
      timeout: this.requestTimeoutMs,
      httpsAgent: this.host && String(this.host).startsWith('https://')
        ? new https.Agent({ rejectUnauthorized: !this.tlsInsecure })
        : undefined,
      headers: {
        Accept: 'application/json,text/plain,*/*',
      },
    });

    // 记录最后一次请求 URL（脱敏），便于调试
    this.lastRequestUrl = '';
  }

  /**
   * 根据 alertId 和告警类别获取告警详细信息。
   *
   * 使用 syslog 中告警时间戳 ± 1 天作为查询窗口。
   *
   * @param {number} alertId - NAPM 告警事件 ID
   * @param {string} category - 告警类别，如 "userAlerts"
   * @param {string} [alertTimestamp] - Syslog 中的告警时间（ISO 8601），用于确定查询窗口
   * @returns {object|null} 告警详情对象，失败时返回 null
   */
  async getAlertDetail(alertId, category, alertTimestamp) {
    try {
      // 以告警时间戳为中心，前后各 1 天作为查询窗口
      // NAPM API 要求时间戳对齐到分钟（60 的整数倍）
      let start, end;
      if (alertTimestamp) {
        const ts = new Date(alertTimestamp).getTime();
        if (!isNaN(ts)) {
          end = Math.floor(ts / 1000 / 60) * 60 + 86400;   // 对齐分钟 + 1 天
          start = Math.floor(ts / 1000 / 60) * 60 - 86400;  // 对齐分钟 - 1 天
        }
      }
      // 兜底：最近 7 天
      if (!start || !end) {
        end = Math.floor(Date.now() / 1000 / 60) * 60;
        start = end - 7 * 86400;
      }

      const url = this._buildUrl('alertsDetail', {
        eventids: String(alertId),
        start,
        end,
        json: 'true',
      });

      this.lastRequestUrl = this._maskUrl(url);
      console.log(`[AlertEnrichment] 请求 URL: ${this.lastRequestUrl}`);

      const response = await this.client.get(url);
      const data = response.data;

      // NAPM alertsDetail 返回格式：可能是对象或字符串（json=true 时自动解析）
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;

      // 尝试多种可能的返回结构
      const alerts =
        parsed?.data?.alerts ||
        parsed?.alerts ||
        (Array.isArray(parsed?.data) ? parsed.data : null) ||
        (Array.isArray(parsed) ? parsed : null);

      if (alerts && alerts.length > 0) {
        return alerts[0];
      }
      return null;
    } catch (err) {
      if (err.response) {
        console.error(
          `[AlertEnrichment] NAPM API 返回错误 alertId=${alertId}:`,
          err.response.status,
          JSON.stringify(err.response.data).slice(0, 300)
        );
      } else {
        console.error(`[AlertEnrichment] 请求失败 alertId=${alertId}:`, err.message);
      }
      return null;
    }
  }

  /**
   * 获取最后一次请求的 URL（密码已脱敏），供调试使用。
   */
  getLastRequestUrl() {
    return this.lastRequestUrl;
  }

  // ---- 私有方法 ----

  /**
   * 规范化主机地址。
   * 输入："101.254.114.238" 或 "https://101.254.114.238/webservice/NetInside"
   * 输出："https://101.254.114.238/webservice/NetInside"（无尾部斜杠）
   */
  _normalizeHost(raw) {
    const str = String(raw || '').trim();
    if (!str) return '';

    // 确保有协议前缀
    const withProtocol = /^https?:\/\//i.test(str) ? str : `https://${str}`;

    try {
      const url = new URL(withProtocol);
      // 清除已有的用户名密码
      url.username = '';
      url.password = '';
      // 确保路径是 /webservice/NetInside
      if (!/\/webservice\/NetInside\/?$/i.test(url.pathname)) {
        url.pathname = '/webservice/NetInside';
      }
      return url.toString().replace(/\/$/, '');
    } catch (_err) {
      return withProtocol;
    }
  }

  /**
   * 构建 NAPM API URL（GET 请求，参数在 query string 中）。
   */
  _buildUrl(type, params = {}) {
    const base = new URL(this.host);
    const searchParams = new URLSearchParams();

    // 认证参数
    if (this.username) searchParams.set('UserName', this.username);
    if (this.password) searchParams.set('Password', this.password);

    // API 类型
    searchParams.set('type', type);

    // 业务参数
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      searchParams.set(key, String(value));
    }

    base.search = searchParams.toString();
    return base.toString();
  }

  /**
   * 对 URL 中的密码进行脱敏，用于日志输出。
   */
  _maskUrl(url) {
    try {
      const u = new URL(url);
      if (u.searchParams.has('Password')) {
        u.searchParams.set('Password', '***');
      }
      return u.toString();
    } catch (_err) {
      return url;
    }
  }
}

module.exports = AlertEnrichmentService;
