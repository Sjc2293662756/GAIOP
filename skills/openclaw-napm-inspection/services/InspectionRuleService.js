'use strict';

const fs = require('fs');
const path = require('path');

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function toNumber(value) {
  const match = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const numeric = Number(match[0]);
  return Number.isFinite(numeric) ? numeric : null;
}

function findItem(section = {}, name = '') {
  return Array.isArray(section.items)
    ? section.items.find((item) => String(item?.name || '').includes(name))
    : null;
}

function getItemNumber(section = {}, name = '') {
  return toNumber(findItem(section, name)?.value);
}

function parseDiskUsagePercent(value = '') {
  const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const used = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return (used / total) * 100;
}

function loadDefaultRules() {
  const configPath = path.resolve(__dirname, '..', '..', '..', 'config', 'inspection-report-rules.v1.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_error) {
    return {
      thresholds: {}
    };
  }
}

function normalizeFindings(items = [], okText = '正常。') {
  const normalized = items.map((item) => String(item || '').trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : [okText];
}

class InspectionRuleService {
  constructor(options = {}) {
    this.rules = options.rules || loadDefaultRules();
    this.thresholds = {
      ...(this.rules.thresholds || {}),
      ...(options.thresholds || {})
    };
  }

  evaluatePerformance(performance = {}) {
    const next = clone(performance) || {};
    const findings = [];
    const recommendations = [];
    const packetDrops = getItemNumber(next, '丢包数');
    const dupRate = getItemNumber(next, '重复率');
    const cpuUsage = getItemNumber(next, 'CPU');
    const diskUsagePercent = parseDiskUsagePercent(findItem(next, '磁盘')?.value);

    if (packetDrops !== null && packetDrops > Number(this.thresholds.packetDropsWarningGreaterThan ?? 0)) {
      findings.push(`丢包数为${packetDrops}，需要关注采集链路或镜像口。`);
      recommendations.push('建议检查采集链路、镜像口和设备丢包情况。');
    }
    if (this.thresholds.packetDupRateWarningGreaterThan !== null
      && this.thresholds.packetDupRateWarningGreaterThan !== undefined
      && dupRate !== null
      && dupRate > Number(this.thresholds.packetDupRateWarningGreaterThan)) {
      findings.push(`数据包重复率为${dupRate}%，高于阈值。`);
      recommendations.push('建议检查镜像策略、链路聚合、重复流量和采集口配置。');
    }
    if (diskUsagePercent !== null && diskUsagePercent >= Number(this.thresholds.diskUsageWarningPercent ?? 85)) {
      findings.push(`磁盘使用率约${Number(diskUsagePercent.toFixed(2))}%，接近或超过阈值。`);
      recommendations.push('建议检查数据保留策略和存储空间。');
    }
    if (cpuUsage !== null && cpuUsage >= Number(this.thresholds.cpuUsageWarningPercent ?? 85)) {
      findings.push(`CPU 使用率为${cpuUsage}%，接近或超过阈值。`);
      recommendations.push('建议结合流量峰值和采集策略继续观察 CPU 负载。');
    }

    next.status = findings.length > 0 ? 'warning' : 'ok';
    next.findings = normalizeFindings(findings);
    next.recommendations = recommendations;
    return next;
  }

  evaluateDataRetention(dataRetention = {}, device = {}) {
    const next = clone(dataRetention) || {};
    const findings = [];
    const recommendations = [];
    const oneMinute = getItemNumber(next, '1分钟数据');
    if (oneMinute !== null && oneMinute < Number(this.thresholds.minOneMinuteRetentionDays ?? 7)) {
      findings.push(`1分钟粒度数据仅保留${oneMinute}天，低于建议值。`);
      recommendations.push('建议检查数据保留策略或流量策略。');
    }

    const latestTime = Date.parse(String(next.latestDataTime || '').replace(/-/g, '/'));
    const applianceTime = Date.parse(String(device.applianceTime || '').replace(/-/g, '/'));
    if (Number.isFinite(latestTime) && Number.isFinite(applianceTime)) {
      const lagMinutes = Math.abs(applianceTime - latestTime) / 60000;
      if (lagMinutes > Number(this.thresholds.dataLagWarningMinutes ?? 30)) {
        findings.push(`最新数据采集时间与设备时间相差约${Math.round(lagMinutes)}分钟。`);
        recommendations.push('建议检查数据采集是否存在中断。');
      }
    }

    next.status = findings.length > 0 ? 'warning' : 'ok';
    next.findings = normalizeFindings(findings);
    next.recommendations = recommendations;
    return next;
  }

  evaluateConfiguration(configuration = {}) {
    const next = clone(configuration) || {};
    const findings = [];
    const recommendations = [];
    const businessGroupCount = getItemNumber(next, '业务组数量');
    if (businessGroupCount !== null && businessGroupCount === Number(this.thresholds.defaultBusinessGroupCount ?? 4)) {
      findings.push('业务组数量为4，需要确认是否仍为默认配置。');
      recommendations.push('建议结合客户实际业务范围确认业务组配置是否完整。');
    }
    next.status = findings.length > 0 ? 'warning' : 'ok';
    next.findings = normalizeFindings(findings);
    next.recommendations = recommendations;
    return next;
  }

  evaluatePacketStorage(packetStorage = {}) {
    const next = clone(packetStorage) || {};
    const findings = Array.isArray(next.findings)
      ? next.findings.filter((item) => String(item || '').trim() && String(item).trim() !== '正常。')
      : [];
    const minDays = this.thresholds.minPacketStorageDays;
    const durationDays = toNumber(next.durationText);
    if (minDays !== null && minDays !== undefined && durationDays !== null && durationDays < Number(minDays)) {
      findings.push(`原始数据包保存时长约${next.durationText}，低于现场要求。`);
    }
    next.status = findings.length > 0 ? 'warning' : 'ok';
    next.findings = normalizeFindings(findings);
    next.recommendations = findings.length > 0 ? ['建议检查原始报文存储策略和存储容量。'] : [];
    return next;
  }

  buildSummary(inspection = {}) {
    const firstDevice = inspection.devices?.[0] || {};
    const performance = inspection.performance || {};
    const performanceItem = (name) => findItem(performance, name)?.value || '';
    const warningSections = [
      inspection.performance,
      inspection.dataRetention,
      inspection.configuration,
      inspection.packetStorage,
      inspection.trafficAnalysis,
      inspection.businessPerformance
    ].filter((section) => section?.status === 'warning');
    const abnormalItems = warningSections.flatMap((section) => (
      Array.isArray(section.findings)
        ? section.findings.map((item) => (typeof item === 'string' ? item : item?.text)).filter(Boolean)
        : []
    )).filter((item) => item !== '正常。');

    return {
      overallStatus: warningSections.length > 0 ? 'warning' : 'ok',
      devices: [
        {
          deviceName: firstDevice.systemName || firstDevice.ipAddress || '',
          cpuUsage: performanceItem('CPU'),
          diskUsage: performanceItem('磁盘'),
          packetDrops: performanceItem('丢包数'),
          health: warningSections.length > 0 ? '需关注' : '良好',
          remark: ''
        }
      ],
      abnormalItems,
      conclusion: abnormalItems.length > 0
        ? '本次巡检发现部分指标需要关注，建议结合查询证据继续排查。'
        : '本次巡检未发现明显异常。'
    };
  }

  evaluate(inspection = {}) {
    const next = clone(inspection) || {};
    const firstDevice = next.devices?.[0] || {};
    next.performance = this.evaluatePerformance(next.performance || {});
    next.dataRetention = this.evaluateDataRetention(next.dataRetention || {}, firstDevice);
    next.configuration = this.evaluateConfiguration(next.configuration || {});
    next.packetStorage = this.evaluatePacketStorage(next.packetStorage || {});
    if (!next.trafficAnalysis) next.trafficAnalysis = { status: 'unknown', findings: [] };
    if (!next.businessPerformance) next.businessPerformance = { status: 'unknown', findings: [] };
    next.summary = this.buildSummary(next);
    return next;
  }
}

module.exports = InspectionRuleService;
module.exports.__test__ = {
  toNumber,
  parseDiskUsagePercent,
  findItem
};
