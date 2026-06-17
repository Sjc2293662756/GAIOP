'use strict';

const InspectionClient = require('./InspectionClient');
const InspectionFieldMapperService = require('./InspectionFieldMapperService');
const InspectionRuleService = require('./InspectionRuleService');
const InspectionTrafficAnalysisService = require('./InspectionTrafficAnalysisService');
const InspectionBusinessPerformanceService = require('./InspectionBusinessPerformanceService');

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function collectQueryEvidence(inspection = {}) {
  const evidence = [];
  for (const section of [inspection.trafficAnalysis?.recentHour, inspection.trafficAnalysis?.recentDay]) {
    if (section?.queryEvidence) evidence.push(section.queryEvidence);
  }
  if (Array.isArray(inspection.businessPerformance?.queryEvidence)) {
    evidence.push(...inspection.businessPerformance.queryEvidence);
  }
  return evidence;
}

class InspectionReportDataService {
  constructor(options = {}) {
    this.clientOptions = options;
    this.fieldMapper = options.fieldMapper || new InspectionFieldMapperService(options);
    this.ruleService = options.ruleService || new InspectionRuleService(options);
    this.client = options.client || null;
    this.trafficService = options.trafficService || null;
    this.businessService = options.businessService || null;
  }

  buildInspectionFromSources(source = {}, options = {}) {
    const mapped = this.fieldMapper.mapInspection(source, options);
    const withAnalysis = {
      ...mapped,
      trafficAnalysis: isPlainObject(source.trafficAnalysis)
        ? source.trafficAnalysis
        : mapped.trafficAnalysis,
      businessPerformance: isPlainObject(source.businessPerformance)
        ? source.businessPerformance
        : mapped.businessPerformance
    };
    return this.ruleService.evaluate(withAnalysis);
  }

  buildReportData(inspection = {}, options = {}) {
    const title = asText(options.title)
      || `${inspection.customerName ? `${inspection.customerName}` : ''}流量分析系统健康检查报告`;
    return {
      schema: 'openclaw_napm_report_data.v1',
      reportType: 'inspection_report',
      templateId: 'napm_traffic_health_inspection_v1',
      format: options.format || 'docx',
      defaultFormat: 'docx',
      title,
      sourceQuestion: asText(options.sourceQuestion || options.prompt) || '生成流量分析系统巡检报告',
      dataSource: {
        system: 'NAPM',
        sourceSkill: 'openclaw-napm-inspection',
        queryService: 'inspectionSnapshot'
      },
      inspection,
      sections: [
        {
          type: 'inspection',
          title: '巡检报告',
          dataPath: 'inspection'
        }
      ],
      audit: {
        sourceSkill: 'openclaw-napm-inspection',
        sourceSchema: inspection.schema || 'openclaw_napm_inspection.v1',
        authMode: 'query_params',
        queryEvidence: collectQueryEvidence(inspection),
        requestHistory: Array.isArray(options.requestHistory) ? options.requestHistory : []
      }
    };
  }

  buildResult(inspection = {}, options = {}) {
    const reportData = this.buildReportData(inspection, options);
    return {
      ok: true,
      schema: 'openclaw_napm_inspection_result.v1',
      inspection,
      reportData,
      summary: {
        title: reportData.title,
        status: inspection.summary?.overallStatus || 'unknown',
        highlights: Array.isArray(inspection.summary?.abnormalItems) && inspection.summary.abnormalItems.length > 0
          ? inspection.summary.abnormalItems
          : [inspection.summary?.conclusion || '巡检数据已生成。']
      },
      narrationInput: {
        schema: 'openclaw_napm_inspection.v1',
        type: 'inspection_result',
        inspection
      }
    };
  }

  async collectSources(options = {}) {
    const client = this.client || new InspectionClient({
      ...this.clientOptions,
      ...options
    });
    const [appliance, packets, about] = await Promise.all([
      client.getApplianceInfo(),
      client.getPacketsInfo(),
      client.getAboutHtml()
    ]);
    const trafficService = this.trafficService || new InspectionTrafficAnalysisService({
      client,
      nowSeconds: options.nowSeconds,
      timezone: options.timezone,
      thresholds: options.thresholds
    });
    const businessService = this.businessService || new InspectionBusinessPerformanceService({
      client,
      nowSeconds: options.nowSeconds,
      thresholds: options.thresholds
    });
    const [trafficAnalysis, businessPerformance] = await Promise.all([
      trafficService.collect(),
      businessService.collect()
    ]);
    return {
      applianceInfo: appliance.data,
      packetsInfo: packets.data,
      aboutHtml: about.data,
      trafficAnalysis,
      businessPerformance,
      requestHistory: typeof client.getRequestHistory === 'function' ? client.getRequestHistory() : []
    };
  }

  async run(input = {}) {
    const source = isPlainObject(input.source) ? input.source : null;
    const options = {
      customerName: input.customerName,
      projectName: input.projectName,
      reportDate: input.reportDate,
      title: input.title,
      sourceQuestion: input.sourceQuestion || input.prompt,
      format: input.format || 'docx',
      nowSeconds: input.nowSeconds,
      timezone: input.timezone || 'Asia/Shanghai',
      thresholds: input.thresholds,
      host: input.host,
      username: input.username,
      password: input.password,
      tlsInsecure: input.tlsInsecure,
      timeoutMs: input.timeoutMs
    };
    const collected = source
      ? {
          ...source,
          requestHistory: Array.isArray(source.requestHistory) ? source.requestHistory : []
        }
      : await this.collectSources(options);
    const inspection = this.buildInspectionFromSources(collected, options);
    return this.buildResult(inspection, {
      ...options,
      requestHistory: collected.requestHistory || []
    });
  }
}

module.exports = InspectionReportDataService;
module.exports.__test__ = {
  collectQueryEvidence
};
