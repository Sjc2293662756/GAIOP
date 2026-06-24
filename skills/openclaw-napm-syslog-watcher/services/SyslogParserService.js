'use strict';

/**
 * SyslogParserService — 解析 NAPM 发出的 Syslog 行，提取结构化告警字段。
 *
 * NAPM Syslog 行格式（rsyslog 模板 NetinsideSyslogRaw）：
 *   2025-06-16T10:30:00+08:00 from=101.254.114.238 host=101.254.114.238
 *   facility=local0 severity=notice tag=紧急:
 *   userAlerts severity=紧急 name=SNMP测试 alertid=113 ...
 *   metric1=流量（流入和流出） value1=123.45 units1=兆字节
 *
 * 解析结果是一个扁平对象，包含时间戳、来源、告警类别、严重级别、alertId、
 * 指标列表等字段。
 */

class SyslogParserService {
  /**
   * 解析单行 NAPM Syslog 文本。
   * @param {string} line - 原始 syslog 行
   * @returns {object|null} 结构化告警对象，如果不是 NAPM 告警行则返回 null
   */
  parse(line) {
    if (!line || typeof line !== 'string') return null;

    // ---- 1. 匹配 rsyslog 模板前缀 ----
    // 格式：<ISO时间戳> from=<ip> host=<hostname> facility=<...> severity=<...> tag=<tag>: <body>
    const headerRe = new RegExp(
      '^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?[+-]\\d{2}:\\d{2})\\s+' +
      'from=([^\\s]+)\\s+' +
      'host=([^\\s]+)\\s+' +
      'facility=([^\\s]+)\\s+' +
      'severity=([^\\s]+)\\s+' +
      'tag=([^:]+):\\s*' +
      '(.*)$'
    );
    const headerMatch = line.match(headerRe);
    if (!headerMatch) return null;

    const [, timestamp, fromHost, host, facility, severity, tag, body] = headerMatch;

    // ---- 2. 从 body 中匹配 NAPM 告警特征行 ----
    // 格式：<category>Alerts severity=<级别> name=<告警名称> alertid=<数字>
    const alertRe = /(\w+Alerts)\s+severity=([^\s]+)\s+name=(.+?)\s+alertid=(\d+)/;
    const alertMatch = body.match(alertRe);
    if (!alertMatch) return null;

    const category = alertMatch[1];
    const alertSeverity = alertMatch[2];
    const alertName = alertMatch[3];
    const alertId = parseInt(alertMatch[4], 10);

    // ---- 3. 提取所有 key=value 对 ----
    const kvPairs = {};
    // 匹配 key=value，其中 value 可能是带引号的字符串或无引号 token
    const kvRe = /(\w+)=(?:"([^"]*)"|(\S+))/g;
    let m;
    while ((m = kvRe.exec(body)) !== null) {
      kvPairs[m[1]] = m[2] !== undefined ? m[2] : m[3];
    }

    // ---- 4. 提取指标 ----
    const metrics = [];
    for (let i = 1; ; i++) {
      const nameKey = `metric${i}`;
      const valueKey = `value${i}`;
      const unitKey = `units${i}`;
      if (!kvPairs[nameKey]) break;
      metrics.push({
        name: kvPairs[nameKey] || '',
        value: kvPairs[valueKey] || '',
        unit: kvPairs[unitKey] || '',
      });
    }

    return {
      timestamp,
      fromHost,
      host,
      facility,
      severity,
      tag: tag.trim(),
      category,
      alertSeverity,
      alertName,
      alertId,
      metrics,
      rawBody: body,
      // 附加提取的额外字段（如 alertType 等可能存在的字段）
      extra: this._extractExtra(kvPairs),
    };
  }

  /**
   * 提取非标准但有价值的附加字段。
   */
  _extractExtra(kvPairs) {
    const knownKeys = new Set(['severity', 'name', 'alertid']);
    // 动态移除 metricN / valueN / unitsN
    const extra = {};
    for (const [k, v] of Object.entries(kvPairs)) {
      if (knownKeys.has(k)) continue;
      if (/^(metric|value|units)\d+$/.test(k)) continue;
      extra[k] = v;
    }
    return extra;
  }
}

module.exports = SyslogParserService;
