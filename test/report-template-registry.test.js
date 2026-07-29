const {
  GENERIC_QUERY_TEMPLATE_ID,
  REPORT_SCHEMA,
  findRegistration,
  normalizeRegistration
} = require('../skills/openclaw-napm-report/services/ReportTemplateRegistry');
const ReportGenerationService = require('../skills/openclaw-napm-report/services/ReportGenerationService');
const FaultDiagnosisService = require('../skills/openclaw-napm-fault-diagnosis/services/FaultDiagnosisService');

describe('report template registry', () => {
  test('applies the only safe default to generic query reports', () => {
    expect(normalizeRegistration({ reportType: 'quick_report' })).toMatchObject({
      schema: REPORT_SCHEMA,
      reportType: 'quick_report',
      templateId: GENERIC_QUERY_TEMPLATE_ID
    });
  });

  test('does not infer a diagnostic template', () => {
    const normalized = normalizeRegistration({
      schema: REPORT_SCHEMA,
      reportType: 'diagnostic_report'
    });

    expect(normalized.templateId).toBeUndefined();
    expect(findRegistration(normalized)).toBeNull();
  });

  test('rejects unregistered report combinations before rendering', async () => {
    const service = new ReportGenerationService();
    await expect(service.generate({
      schema: REPORT_SCHEMA,
      reportType: 'diagnostic_report',
      format: 'docx',
      sections: [{ type: 'summary', content: 'unsupported diagnostic payload' }]
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'REPORT_TEMPLATE_NOT_FOUND'
    });
  });

  test('builds fault reports with the template registered for the active flow', () => {
    const service = new FaultDiagnosisService({ client: { requestHistory: [] } });
    const baseSession = {
      context: {},
      target: {},
      faultInput: {},
      completedSteps: [],
      description: 'test fault'
    };

    expect(service.buildReportData({ ...baseSession, flowType: 'bs_app_slow' }).templateId).toBe('napm_bs_fault_diagnosis_v2');
    expect(service.buildReportData({ ...baseSession, flowType: 'bs_page_perf' }).templateId).toBe('napm_bs_page_perf_v1');
    expect(service.buildReportData({ ...baseSession, flowType: 'cs_app_slow' }).templateId).toBe('napm_cs_fault_diagnosis_v1');
  });
});
