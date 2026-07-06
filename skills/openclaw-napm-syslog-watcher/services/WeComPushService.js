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

// 告警类别 → 中文标签
const CATEGORY_LABEL = {
  'networkAlerts': '网络性能告警',
  'networkIssueAlerts': '网络异常告警',
  'appAlerts': '应用性能告警',
  'busAlerts': '业务故障告警',
  'userAlerts': '用户体验告警',
  'securityAlerts': '安全事件告警',
  'AIAlerts': '智能分析告警',
};

class WeComPushService {
  /**
   * @param {object} config - watcher 配置对象
   * @param {object} config.wecom - 企业微信配置
   */
  constructor(config) {
    const wecom = config.wecom || {};
    const napm = config.napm || {};

    // 主 webhook URL
    this.defaultWebhookUrl = wecom.webhookUrl || '';

    // HMAC-SHA256 签名密钥（可选，如果 webhook 未配置 secret 则留空）
    this.secret = wecom.secret || '';

    // 可选：按严重级别分路由
    this.routing = wecom.routing || {};

    // 默认 @ 人员列表
    this.mentionedList = wecom.mentionedList || [];
    this.mentionedMobileList = wecom.mentionedMobileList || [];

    // NAPM 控制台地址（用于生成告警详情链接）
    const napmRaw = napm.host || napm.baseUrl || '';
    this.napmConsoleUrl = this._extractOrigin(napmRaw);
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

      if (response.data?.errcode !== 0) {
        console.error(
          `[WeComPush] 推送失败: errcode=${response.data?.errcode}, errmsg=${response.data?.errmsg || 'unknown'}`
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
   *
   * 卡片结构：
   *   标题 + 基本字段（名称/级别/类别/时间）
   *   详情区（触发条件 / 监控对象 / 指标）
   *   标识区（alertId / elogid）
   *   操作区（NAPM 控制台链接）
   */
  _buildMarkdownMessage(alert, mentionedMobileList) {
    const severity = alert.alertSeverity || alert.severity || '';
    const sevDisplay = SEVERITY_LABEL[severity] || severity;

    let md = '## ⚠️ NAPM 告警通知\n';

    // ---- 基本信息 ----
    md += `> **告警名称**：${this._escapeMd(alert.alertName || alert.name || '-')}\n`;
    md += `> **严重级别**：${sevDisplay}\n`;

    if (alert.category) {
      const catLabel = CATEGORY_LABEL[alert.category] || alert.category;
      md += `> **告警类别**：${this._escapeMd(catLabel)}\n`;
    }
    if (alert.timestamp) {
      // 截断微秒，只保留秒级
      const ts = alert.timestamp.replace(/\.\d+/, '');
      md += `> **告警时间**：${this._escapeMd(ts)}\n`;
    }

    // ---- 详情区 ----
    // 触发条件（syslog 里就有，或从 API 补充）
    let condition = alert.extra?.condition || alert.detail?.condition || alert.detail?.triggerCondition || '';
    if (condition) {
      // 替换英文告警级别为中文
      condition = condition
        .replace(/\bCritical\b/g, '紧急')
        .replace(/\bMajor\b/g, '重大')
        .replace(/\bMinor\b/g, '轻微')
        .replace(/\bNone\b/g, '无');
      md += `> **触发条件**：${this._escapeMd(condition)}\n`;
    }

    // 监控对象（syslog canongrouppath 比 API objectName 更直观）
    const object =
      alert.extra?.canongrouppath ||
      alert.detail?.objectName ||
      alert.detail?.group ||
      '';
    if (object) {
      md += `> **监控对象**：${this._escapeMd(object)}\n`;
    }

    // 指标列表
    if (alert.metrics && alert.metrics.length > 0) {
      md += '> **指标**：\n';
      for (const m of alert.metrics) {
        const val = [m.value, m.unit].filter(Boolean).join(' ');
        md += `> - ${this._escapeMd(m.name)}: ${this._escapeMd(val)}\n`;
      }
    }

    // ---- 标识区 ----
    md += '\n';
    md += `> Alert ID: **${alert.alertId || '-'}**`;
    if (alert.extra?.elogid) {
      md += ` | Event ID: **${this._escapeMd(alert.extra.elogid)}**`;
    }
    md += '\n';

    // 告警窗口时间（endtime 可能为 0，表示告警仍在持续）
    const rawStart = parseInt(alert.extra?.starttime, 10) || 0;
    const rawEnd = parseInt(alert.extra?.endtime, 10) || 0;
    const hasStart = rawStart > 0;
    const hasEnd = rawEnd > 0;
    if (hasStart) {
      const st = this._formatTimestamp(rawStart);
      if (hasEnd) {
        md += `> ⏱ 告警窗口: ${st} ~ ${this._formatTimestamp(rawEnd)}\n`;
      } else {
        md += `> ⏱ 告警开始: ${st}（持续中）\n`;
      }
      // 快捷查询指令 — 灰色代码块
      if (alert.extra?.elogid) {
        const qStart = hasEnd
          ? Math.floor(rawStart / 60) * 60 - 60
          : Math.floor(rawStart / 60) * 60 - 120;
        const qEnd = hasEnd
          ? Math.floor(rawEnd / 60) * 60 + 60
          : Math.floor(rawStart / 60) * 60 + 120;
        // 追加指标名，供 AI 分析时定位
        const metricNames = (alert.metrics || [])
          .map(m => m.name)
          .filter(Boolean);
        const metricPart = metricNames.length > 0 ? ' ' + metricNames.join(' ') : '';
        md += `\n> 💬 深入分析\n\n\`\`\`\n分析这个告警数据包 ${alert.extra.elogid} ${qStart} ${qEnd}${metricPart}\n\`\`\`\n`;
      }
    }

    // 接收时间（北京时间）
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    md += `\n> 📅 接收时间：${now}`;

    return {
      msgtype: 'markdown_v2',
      markdown_v2: {
        content: md,
      },
    };
  }

  /**
   * 从 NAPM host 配置中提取控制台根地址。
   * "https://101.254.114.238/webservice/NetInside" → "https://101.254.114.238"
   */
  _extractOrigin(raw) {
    if (!raw) return '';
    try {
      const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      const url = new URL(withProtocol);
      return url.origin;
    } catch (_err) {
      return '';
    }
  }

  /**
   * Unix 秒级时间戳 → 可读时间字符串（北京时间）。
   */
  _formatTimestamp(sec) {
    if (!sec) return '';
    const n = parseInt(sec, 10);
    if (isNaN(n)) return '';
    const d = new Date(n * 1000);
    return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
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
