'use strict';

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function propertiesToMap(applianceInfo = {}) {
  const entries = Array.isArray(applianceInfo?.properties) ? applianceInfo.properties : [];
  const prop = {};
  for (const item of entries) {
    if (!isPlainObject(item)) continue;
    const key = asText(item.key);
    if (!key) continue;
    prop[key] = item.value;
    prop[key.toLowerCase()] = item.value;
  }
  return prop;
}

function readPath(source = {}, path = '') {
  const parts = String(path || '').split('.').filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    const arrayMatch = part.match(/^(.+)\[(\d+)]$/);
    if (arrayMatch) {
      current = current[arrayMatch[1]];
      current = Array.isArray(current) ? current[Number(arrayMatch[2])] : undefined;
      continue;
    }
    current = current[part];
  }
  return current;
}

function firstValue(source = {}, paths = []) {
  for (const path of paths) {
    const value = readPath(source, path);
    if (value !== undefined && value !== null && asText(value)) {
      return value;
    }
  }
  return '';
}

function formatTimestamp(value, options = {}) {
  const includeSeconds = options.includeSeconds !== false;
  const timezone = options.timezone || 'Asia/Shanghai';
  const text = asText(value);
  if (!text) return '';

  const numeric = toFiniteNumber(text);
  if (numeric !== null && numeric > 1000000000) {
    const date = new Date(numeric * 1000);
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: includeSeconds ? '2-digit' : undefined,
      hour12: false
    }).formatToParts(date).reduce((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});
    const suffix = includeSeconds ? `:${parts.second}` : '';
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${suffix}`;
  }

  return text
    .replace(/\//g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDuration(seconds = 0) {
  let remaining = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(remaining / 86400);
  remaining -= days * 86400;
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  remaining -= minutes * 60;
  const parts = [];
  if (days) parts.push(`${days}天`);
  if (hours) parts.push(`${hours}小时`);
  if (minutes) parts.push(`${minutes}分钟`);
  if (remaining || parts.length === 0) parts.push(`${remaining}秒`);
  return parts.join('');
}

function formatUptime(value = '') {
  return asText(value)
    .replace(/\byears?\b/gi, '年')
    .replace(/\bmons?\b/gi, '月')
    .replace(/\bdays?\b/gi, '天')
    .replace(/\bhrs?\b/gi, '小时')
    .replace(/\bmins?\b/gi, '分钟')
    .replace(/\bsecs?\b/gi, '秒')
    .replace(/\s+/g, '');
}

function appendSuffix(value, suffix) {
  const text = asText(value);
  if (!text) return '';
  return text.endsWith(suffix) ? text : `${text}${suffix}`;
}

function formatSerialNumber(value = '') {
  const text = asText(value);
  if (!text) return '';
  if (/^(ARXVXA|ARX3800)-/i.test(text)) {
    return text.replace(/^(ARXVXA|ARX3800)/i, 'NetInside NAPM 4.0');
  }
  return text;
}

function parseSysVersion(aboutHtml = '') {
  const html = String(aboutHtml || '');
  const match = html.match(/id=["']sysVersion["'][^>]*>([^<]+)</i);
  return match ? asText(match[1]) : '';
}

class InspectionFieldMapperService {
  constructor(options = {}) {
    this.timezone = options.timezone || 'Asia/Shanghai';
  }

  buildSource(applianceInfo = {}) {
    return {
      ...applianceInfo,
      properties: propertiesToMap(applianceInfo)
    };
  }

  validateApplianceInfo(applianceInfo = {}) {
    const errors = [];
    if (!isPlainObject(applianceInfo)) {
      errors.push('applianceInfo must be an object.');
      return { ok: false, errors };
    }
    if (!Array.isArray(applianceInfo.properties)) {
      errors.push('applianceInfo.properties must be an array.');
    } else {
      applianceInfo.properties.forEach((item, index) => {
        if (!isPlainObject(item) || !Object.prototype.hasOwnProperty.call(item, 'key') || !Object.prototype.hasOwnProperty.call(item, 'value')) {
          errors.push(`applianceInfo.properties[${index}] must contain key and value.`);
        }
      });
    }
    const source = this.buildSource(applianceInfo);
    ['hostname', 'ipAddress', 'SerialNumber', 'cpuUsage', 'diskusage', 'datainfo'].forEach((key) => {
      const value = source.properties[key] ?? source.properties[key.toLowerCase()];
      if (!asText(value)) errors.push(`applianceInfo missing recommended field: ${key}.`);
    });
    return { ok: errors.length === 0, errors };
  }

  mapDevice(applianceInfo = {}, aboutHtml = '', options = {}) {
    const source = this.buildSource(applianceInfo);
    const systemName = firstValue(source, ['properties.hostname', 'properties.BoxName', 'boxName']);
    const ipAddress = firstValue(source, ['properties.ipAddress', 'properties.IpAddress', 'address']);
    const softwareVersion = asText(options.softwareVersion || parseSysVersion(aboutHtml) || source.mktVersion || source.uiVersion);
    const serialNumber = formatSerialNumber(firstValue(source, ['properties.SerialNumber', 'properties.serialNumber', 'serialNumber']));
    return {
      index: Number(options.index || 1),
      systemName: asText(systemName),
      ipAddress: asText(ipAddress),
      softwareVersion,
      serialNumber,
      applianceTime: formatTimestamp(firstValue(source, ['properties.appliance_time']), { timezone: this.timezone }),
      uptime: formatUptime(firstValue(source, ['properties.uptime'])),
      raw: {
        address: asText(source.address),
        boxName: asText(source.boxName),
        model: asText(source.model),
        mktVersion: asText(source.mktVersion),
        uiVersion: asText(source.uiVersion)
      }
    };
  }

  mapPerformance(applianceInfo = {}) {
    const source = this.buildSource(applianceInfo);
    return {
      status: 'unknown',
      items: [
        { index: 1, name: '每秒数据包个数', value: asText(firstValue(source, ['properties.packetPerSecond'])), remark: '' },
        { index: 2, name: '每秒连接数', value: asText(firstValue(source, ['properties.connPerSecond'])), remark: '' },
        { index: 3, name: '每分钟IP地址数', value: asText(firstValue(source, ['properties.ipsPerMinute'])), remark: '' },
        { index: 4, name: '丢包数', value: asText(firstValue(source, ['properties.packetDrops'])), remark: '' },
        { index: 5, name: '数据包重复率', value: appendSuffix(firstValue(source, ['properties.packetDupRate']), '%'), remark: '' },
        { index: 6, name: '磁盘使用', value: appendSuffix(firstValue(source, ['properties.diskusage']), 'MB'), remark: '' },
        { index: 7, name: 'CPU使用', value: appendSuffix(firstValue(source, ['properties.cpuUsage']), '%'), remark: '' }
      ],
      findings: [],
      recommendations: []
    };
  }

  mapDataRetention(applianceInfo = {}) {
    const source = this.buildSource(applianceInfo);
    const valuePair = (currentKey, maxKey) => {
      const current = asText(firstValue(source, [`properties.${currentKey}`]));
      const max = asText(firstValue(source, [`properties.${maxKey}`]));
      return current || max ? `${current || '-'}/${max || '-'}天` : '';
    };
    return {
      status: 'unknown',
      latestDataTime: formatTimestamp(firstValue(source, ['properties.datainfo']), { timezone: this.timezone }),
      items: [
        { index: 1, name: '最新数据采集时间', value: formatTimestamp(firstValue(source, ['properties.datainfo']), { timezone: this.timezone }), remark: '' },
        { index: 2, name: '1分钟数据', value: valuePair('1minDataRetention', '1minMaxRetention'), remark: '' },
        { index: 3, name: '5分钟数据', value: valuePair('5minDataRetention', '5minMaxRetention'), remark: '' },
        { index: 4, name: '1小时数据', value: valuePair('1hourDataRetention', '1hourMaxRetention'), remark: '' },
        { index: 5, name: '1天数据', value: valuePair('1dayDataRetention', '1dayMaxRetention'), remark: '' }
      ],
      findings: [],
      recommendations: []
    };
  }

  mapConfiguration(applianceInfo = {}) {
    const source = this.buildSource(applianceInfo);
    return {
      status: 'unknown',
      items: [
        { index: 1, name: '所有应用数量', value: asText(firstValue(source, ['properties.applicationCnt'])), remark: '' },
        { index: 2, name: '端口应用数量', value: asText(firstValue(source, ['properties.applStandardCnt'])), remark: '' },
        { index: 3, name: '服务器应用数量', value: asText(firstValue(source, ['properties.applServerCnt'])), remark: '' },
        { index: 4, name: 'Web应用数量', value: asText(firstValue(source, ['properties.applWebCnt'])), remark: '' },
        { index: 5, name: 'URL数量', value: asText(firstValue(source, ['properties.applUrlCnt'])), remark: '' },
        { index: 6, name: '业务组数量', value: asText(firstValue(source, ['properties.busGroupCnt'])), remark: '' }
      ],
      findings: [],
      recommendations: []
    };
  }

  mapPacketStorage(packetsInfo = {}) {
    const rbRange = Array.isArray(packetsInfo?.rbRange) ? packetsInfo.rbRange : [];
    const start = toFiniteNumber(rbRange[0]);
    const end = toFiniteNumber(rbRange[1]);
    const valid = start !== null && end !== null && start > 0 && end >= start;
    const duration = valid ? formatDuration(end - start) : '';
    return {
      status: valid ? 'unknown' : 'unknown',
      startTime: valid ? formatTimestamp(start, { includeSeconds: false, timezone: this.timezone }) : '',
      endTime: valid ? formatTimestamp(end, { includeSeconds: false, timezone: this.timezone }) : '',
      durationText: duration,
      items: [
        { index: 1, name: '开始时间', value: valid ? formatTimestamp(start, { includeSeconds: false, timezone: this.timezone }) : '', remark: '' },
        { index: 2, name: '结束时间', value: valid ? formatTimestamp(end, { includeSeconds: false, timezone: this.timezone }) : '', remark: '' },
        { index: 3, name: '共计时长', value: duration, remark: '' }
      ],
      findings: valid ? [] : ['未获取到原始数据包存储范围。'],
      recommendations: [],
      raw: {
        rbRange
      }
    };
  }

  mapInspection(source = {}, options = {}) {
    const applianceInfo = source.applianceInfo || {};
    const packetsInfo = source.packetsInfo || {};
    const aboutHtml = source.aboutHtml || '';
    const reportDate = asText(options.reportDate || source.reportDate)
      || formatTimestamp(options.nowSeconds || Math.floor(Date.now() / 1000), { includeSeconds: false, timezone: this.timezone }).slice(0, 10);
    return {
      schema: 'openclaw_napm_inspection.v1',
      customerName: asText(options.customerName || source.customerName),
      projectName: asText(options.projectName || source.projectName || '基于AI的全流量性能分析平台'),
      reportDate,
      timezone: this.timezone,
      devices: [this.mapDevice(applianceInfo, aboutHtml)],
      performance: this.mapPerformance(applianceInfo),
      dataRetention: this.mapDataRetention(applianceInfo),
      configuration: this.mapConfiguration(applianceInfo),
      packetStorage: this.mapPacketStorage(packetsInfo),
      trafficAnalysis: source.trafficAnalysis || { status: 'unknown', findings: [] },
      businessPerformance: source.businessPerformance || { status: 'unknown', findings: [] },
      summary: {}
    };
  }
}

module.exports = InspectionFieldMapperService;
module.exports.__test__ = {
  propertiesToMap,
  parseSysVersion,
  formatTimestamp,
  formatDuration,
  formatUptime,
  formatSerialNumber,
  appendSuffix
};
