'use strict';

/**
 * WeComPushService — 通过企业微信机器人 Webhook 推送告警消息。
 *
 * 使用企业微信群机器人 Webhook API：
 *   https://developer.work.weixin.qq.com/document/path/91770
 *
 * 支持两种消息类型：
 *   - markdown：格式化告警卡片（默认）
 *   - text：纯文本（用于心跳/测试通知）
 *
 * 支持 HMAC-SHA256 签名（当 webhook 配置了 secret 时）。
 * 支持按告警严重级别路由到不同的 Webhook URL（可选）。
 */

const crypto = require('crypto');
const axios = require('axios');

// 严重级别对应的显示标签
const SEVERITY_LABEL = {
  '紧急': '🔴 紧急',
  '重大': '🟠 重大',
  '轻微': '轻微',
};

class WeComPushService {
  /**
   * @param {object} config - watcher 配置对象
   * @param {object} config.wecom - 企业微信配置
   */
  constructor(config) {
    const wecom = config.wecom || {};

    // 主 webhook URL
    this.defaultWebhookUrl = wecom.webhookUrl || '';

    // HMAC-SHA256 签名密钥（可选，如果 webhook 未配置 secret 则留空）
    this.secret = wecom.secret || '';

    // 可选：按严重级别分路由
    this.routing = wecom.routing || {};

    // 默认 @ 人员列表
    this.mentionedList = wecom.mentionedList || [];
    this.mentionedMobileList = wecom.mentionedMobileList || [];
  }

  // ---- 公开方法 ----

  /**
   * 推送告警通知到企业微信群。
   * @param {object} alert - 结构化告警对象
   * @returns {Promise<boolean>} 推送是否成功
   */
  async pushAlert(alert) {
    // NAPM 业务告警级别优先，syslog 协议层 severity 仅作兜底
    const severity = alert.alertSeverity || alert.severity || '';
    const route = this.routing[severity] || {};

    const webhookUrl = route.webhookUrl || this.defaultWebhookUrl;
    const mentionedMobileList = route.mentionedMobileList || this.mentionedMobileList;

    if (!webhookUrl) {
      console.error('[WeComPush] 未配置企业微信 Webhook URL，跳过推送');
      return false;
    }

    const signedUrl = this._signUrl(webhookUrl);
    const message = this._buildMarkdownMessage(alert, mentionedMobileList);

    try {
      const response = await axios.post(signedUrl, message, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      const errcode = response.data?.errcode;
      if (errcode !== 0) {
        console.error(
          `[WeComPush] 推送失败: errcode=${errcode}, errmsg=${response.data?.errmsg || 'unknown'}`
        );
        return false;
      }
      return true;
    } catch (err) {
      console.error('[WeComPush] 推送异常:', err.message);
      return false;
    }
  }

  /**
   * 推送纯文本消息（用于心跳/启动通知/测试）。
   * @param {string} text - 纯文本内容
   * @param {string} [webhookUrl] - 可选指定 webhook URL
   * @returns {Promise<boolean>}
   */
  async pushText(text, webhookUrl) {
    const url = webhookUrl || this.defaultWebhookUrl;
    if (!url) {
      console.error('[WeComPush] 未配置企业微信 Webhook URL，跳过文本推送');
      return false;
    }

    const signedUrl = this._signUrl(url);

    try {
      const response = await axios.post(signedUrl, {
        msgtype: 'text',
        text: {
          content: text,
          mentioned_list: this.mentionedList,
          mentioned_mobile_list: this.mentionedMobileList,
        },
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      if (response.data?.errcode !== 0) {
        console.error(`[WeComPush] 文本推送失败: ${response.data?.errmsg}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error('[WeComPush] 文本推送异常:', err.message);
      return false;
    }
  }

  // ---- 私有方法 ----

  /**
   * 对 webhook URL 进行 HMAC-SHA256 签名。
   * 如果未配置 secret，直接返回原 URL。
   *
   * 签名算法：
   *   1. 取当前 Unix 秒级时间戳
   *   2. 构造待签名字符串: timestamp + "\n" + secret
   *   3. 计算 HMAC-SHA256，Base64 编码
   *   4. 追加 &timestamp=xxx&sign=xxx 到 URL
   */
  _signUrl(url) {
    if (!this.secret) return url;

    const timestamp = Math.floor(Date.now() / 1000);
    const stringToSign = timestamp + '\n' + this.secret;
    const hmac = crypto.createHmac('sha256', this.secret);
    hmac.update(stringToSign);
    const sign = encodeURIComponent(hmac.digest('base64'));

    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}timestamp=${timestamp}&sign=${sign}`;
  }

  /**
   * 构建企业微信 Markdown 消息体。
   */
  _buildMarkdownMessage(alert, mentionedMobileList) {
    // NAPM 业务告警级别优先
    const severity = alert.alertSeverity || alert.severity || '';
    const sevDisplay = SEVERITY_LABEL[severity] || severity;

    let md = '## ⚠️ NAPM 告警通知\n';

    md += `> **告警名称**：${this._escapeMd(alert.alertName || alert.name || '-')}\n`;
    md += `> **严重级别**：${sevDisplay}\n`;

    if (alert.category) {
      md += `> **告警类别**：${this._escapeMd(alert.category)}\n`;
    }
    if (alert.timestamp) {
      md += `> **告警时间**：${this._escapeMd(alert.timestamp)}\n`;
    }
    if (alert.fromHost) {
      md += `> **来源主机**：${this._escapeMd(alert.fromHost)}\n`;
    }

    // 指标列表
    if (alert.metrics && alert.metrics.length > 0) {
      md += '> **指标**：\n';
      for (const m of alert.metrics) {
        const val = [m.value, m.unit].filter(Boolean).join(' ');
        md += `> - ${this._escapeMd(m.name)}: ${this._escapeMd(val)}\n`;
      }
    }

    // API 补充的详细信息
    const detail = alert.detail;
    if (detail) {
      if (detail.triggerCondition) {
        md += `> **触发条件**：${this._escapeMd(detail.triggerCondition)}\n`;
      }
      if (detail.description) {
        md += `> **描述**：${this._escapeMd(detail.description)}\n`;
      }
      if (detail.objectName) {
        md += `> **监控对象**：${this._escapeMd(detail.objectName)}\n`;
      }
      if (detail.status) {
        md += `> **状态**：${this._escapeMd(detail.status)}\n`;
      }
    }

    // 接收时间（北京时间）
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    md += `\n> 📅 接收时间：${now}`;

    return {
      msgtype: 'markdown',
      markdown: {
        content: md,
        mentioned_list: this.mentionedList,
        mentioned_mobile_list: mentionedMobileList,
      },
    };
  }

  /**
   * 转义企业微信 Markdown 特殊字符。
   */
  _escapeMd(text) {
    if (!text) return '';
    return String(text)
      .replace(/\n/g, ' ')
      .replace(/\r/g, '');
  }
}

module.exports = WeComPushService;
