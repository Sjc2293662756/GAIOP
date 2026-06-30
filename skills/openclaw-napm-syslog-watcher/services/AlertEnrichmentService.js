'use strict';

/**
 * AlertEnrichmentService — 调 NAPM WebService API 获取告警详细信息。
 *
 * 直接复用现有 openclaw-napm-alert-query 技能中成熟的 AlertApiService，
 * 不重复造轮子。AlertApiService 已经处理好了：
 *   - GET 请求 + URL query string 传参
 *   - 认证（UserName / Password）
 *   - TLS 自签证书
 *   - 时间戳对齐
 *
 * 本服务只做两件事：
 *   1. 根据 Syslog 告警时间戳确定 API 查询窗口（±1 天）
 *   2. 调用 AlertApiService.getDetail() 并返回第一条告警详情
 */

const AlertApiService = require('../../openclaw-napm-alert-query/services/AlertApiService');

class AlertEnrichmentService {
  /**
   * @param {object} config - watcher 配置对象
   * @param {object} config.napm - NAPM API 连接配置
   */
  constructor(config) {
    const napm = config.napm || {};

    // 将 watcher 配置转换为 AlertApiService 所需的 options
    this.api = new AlertApiService({
      host: napm.host || napm.baseUrl || 'https://101.254.114.238/webservice/NetInside',
      username: napm.username || 'GAIOP',
      password: napm.password || '',
      tlsInsecure: napm.tlsInsecure === true,
      timeoutMs: napm.requestTimeoutMs || 15000,
    });
  }

  /**
   * 根据 elogid 或 alertId 获取告警详细信息。
   *
   * NAPM 中 alertid 是告警规则 ID（一对多），elogid 才是事件唯一标识。
   * 优先使用 elogid 查询。Syslog 中 `starttime`/`endtime` 是告警触发窗口，
   * 比从时间戳推算的窗口更准确。
   *
   * @param {object} opts
   * @param {number} opts.alertId - NAPM 告警规则 ID（fallback）
   * @param {string} [opts.elogid] - NAPM 事件日志 ID（优先使用）
   * @param {string} [opts.alertTimestamp] - Syslog 告警时间（ISO 8601），兜底用
   * @param {number} [opts.starttime] - Syslog 中的告警开始时间戳（秒）
   * @param {number} [opts.endtime] - Syslog 中的告警结束时间戳（秒）
   * @returns {object|null} 告警详情对象，失败时返回 null
   */
  async getAlertDetail(opts = {}) {
    const { alertId, elogid, alertTimestamp, starttime, endtime } = opts;

    // 优先用 elogid，fallback 用 alertId
    const eventIds = elogid ? [elogid] : (alertId ? [alertId] : []);

    if (eventIds.length === 0) return null;

    try {
      // 确定查询窗口：优先用 syslog 中的 starttime/endtime（精确）
      // 注意：endtime 可能为 0（NAPM 表示告警仍在持续）
      let start, end;
      const hasStart = typeof starttime === 'number' && starttime > 0;
      const hasEnd = typeof endtime === 'number' && endtime > 0;
      if (hasStart) {
        start = Math.floor(starttime / 60) * 60 - 1800;
        end = hasEnd
          ? Math.floor(endtime / 60) * 60 + 1800
          : Math.floor(starttime / 60) * 60 + 3600;  // endtime=0 时兜底：start + 1h
      } else if (alertTimestamp) {
        const ts = new Date(alertTimestamp).getTime();
        if (!isNaN(ts)) {
          end = Math.floor(ts / 1000 / 60) * 60 + 86400;
          start = Math.floor(ts / 1000 / 60) * 60 - 86400;
        }
      }
      // 兜底：最近 7 天
      if (!start || !end) {
        end = Math.floor(Date.now() / 1000 / 60) * 60;
        start = end - 7 * 86400;
      }

      // 复用现有 AlertApiService（成熟稳定的实现）
      const detailResult = await this.api.getDetail({
        eventIds,
        start,
        end,
      });

      // 记录请求 URL（脱敏）便于调试
      console.log(`[AlertEnrichment] 请求 URL: ${this.api.getLastRequestUrl()}`);

      // 从返回结果中提取告警详情
      // getDetail 返回 JSON 解析后的对象，结构取决于 NAPM API
      return this._extractAlert(detailResult, alertId);
    } catch (err) {
      console.error(`[AlertEnrichment] 请求失败 eventIds=${eventIds.join(',')}:`, err.message);
      return null;
    }
  }

  /**
   * 获取最后一次请求的 URL（密码已脱敏），供调试使用。
   */
  getLastRequestUrl() {
    return this.api.getLastRequestUrl();
  }

  // ---- 私有方法 ----

  /**
   * 从 NAPM API 返回的嵌套结构中提取第一条告警详情。
   * NAPM 返回结构：{ category: { "groupName": [alert1, alert2, ...] } }
   */
  _extractAlert(result, alertId) {
    if (!result) return null;

    // 标准结构：{ "userAlerts": { "group1": [{...}, ...] } }
    if (typeof result === 'object' && !Array.isArray(result)) {
      for (const category of Object.values(result)) {
        if (typeof category === 'object' && !Array.isArray(category)) {
          for (const alerts of Object.values(category)) {
            if (Array.isArray(alerts) && alerts.length > 0) {
              const match = alerts.find(
                (a) => String(a.id || a.alertId || '') === String(alertId)
              );
              if (match) return match;
              // 没精确匹配就返回第一条
              return alerts[0];
            }
          }
        }
      }
    }

    // 扁平结构：[{...}, {...}]
    if (Array.isArray(result) && result.length > 0) {
      return result[0];
    }

    return null;
  }
}

module.exports = AlertEnrichmentService;
