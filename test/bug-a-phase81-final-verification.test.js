'use strict';

process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || 'https://example.invalid/webservice/NetInside';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'phase81-test-user';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'phase81-test-password';

const fs = require('node:fs');
const path = require('node:path');
const RequirementParserService = require('../skills/openclaw-napm-query/services/RequirementParserService');
const NapmQuerySerializer = require('../skills/openclaw-napm-query/services/NapmQuerySerializer');
const ExecutionAdmission = require('../skills/openclaw-napm-query/services/ResolvedQueryExecutionAdmissionService');
const RuntimeMetricCapabilityService = require('../skills/openclaw-napm-query/services/RuntimeMetricCapabilityService');
const plugin = require('../napm-openclaw-plugin.remote');
const {
  SouthboundCallCounter,
  FakeNapmClient,
  installRequirementParserFakeClient
} = require('./helpers/bug-a-phase0-southbound-call-counter');
const {
  inspectNapmPhase7SerializerContracts,
  inspectNapmPhase71TransportBoundaryContracts,
  inspectNapmPhase8OutcomeContracts
} = require('../scripts/verify-napm-skill-runtime-contract');

function query(overrides = {}) {
  return {
    schemaVersion: 'napm-resolved-query.v1',
    service: 'topValues',
    queryModeKey: 'topn',
    groups: [{ type: 'WebApplication' }],
    metrics: ['PGTME'],
    topMetric: 'PGTME',
    topCount: 5,
    start: 1788937200,
    end: 1788940800,
    format: 'json',
    ...overrides
  };
}

describe('BUG-A Phase 8.1 final verification and sign-off', () => {
  let restoreClient;
  let savedBaseline;

  beforeEach(() => {
    savedBaseline = process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
  });

  afterEach(() => {
    restoreClient?.();
    restoreClient = null;
    if (savedBaseline === undefined) delete process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
    else process.env.NAPM_VERIFIED_PRODUCT_BASELINE = savedBaseline;
    jest.restoreAllMocks();
  });

  test('verifies Phase 7, 7.1, and 8 runtime contracts remain green', () => {
    const workspaceRoot = path.resolve(__dirname, '..');
    const options = { workspaceRoot, skillsRoot: path.join(workspaceRoot, 'skills') };
    expect(inspectNapmPhase7SerializerContracts(options).every((item) => item.ok)).toBe(true);
    expect(inspectNapmPhase71TransportBoundaryContracts(options).every((item) => item.ok)).toBe(true);
    expect(inspectNapmPhase8OutcomeContracts(options).every((item) => item.ok)).toBe(true);
  });

  test('UNKNOWN + METRICS_FOR_GROUP + supported metric reaches Serializer and data once', async () => {
    delete process.env.NAPM_VERIFIED_PRODUCT_BASELINE;
    const counter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({
        counter,
        responses: {
          metricsForGroup: [{ id: 'PGTME' }],
          topValues: '[]'
        }
      })
    );
    const serializerSpy = jest.spyOn(NapmQuerySerializer, 'serialize');
    const kernelSpy = jest.spyOn(RequirementParserService.metricExecutionKernel, 'execute');

    const result = await RequirementParserService.executeGatewayRequest(query());

    expect(result).toMatchObject({
      ok: true,
      outcome: 'NO_DATA',
      dataRequestAttempted: true,
      dataRequestSucceeded: true
    });
    expect(counter.callsFor('metricsForGroup')).toHaveLength(1);
    expect(counter.callsFor('topValues')).toHaveLength(1);
    expect(serializerSpy).toHaveBeenCalledTimes(1);
    expect(kernelSpy).toHaveBeenCalledTimes(1);
  });

  test('UNKNOWN with an unqualified provider fails closed without runtime/data transport', async () => {
    const runtime = new RuntimeMetricCapabilityService({
      metadataService: { getMetricsForGroupPathEvidence: jest.fn() }
    });
    const validator = {
      validate: jest.fn().mockReturnValue({
        ok: false,
        status: 'UNKNOWN',
        reasonCode: 'RUNTIME_CAPABILITY_REQUIRED',
        requiredRuntimeChecks: [{
          type: 'SERVICE_CAPABILITY',
          provider: 'OTHER_PROVIDER',
          service: 'topValues',
          groupPathSignature: 'WebApplication',
          metricId: 'PGTME'
        }]
      })
    };
    const admission = new ExecutionAdmission({ validator, runtimeService: runtime });

    const result = await admission.evaluate(query());

    expect(result).toMatchObject({
      ok: false,
      finalAdmission: 'RUNTIME_CAPABILITY_FAILURE',
      reasonCode: 'RUNTIME_CAPABILITY_FAILURE'
    });
    expect(result.runtimeCapability).toMatchObject({
      status: 'INDETERMINATE',
      reasonCode: 'RUNTIME_CAPABILITY_PROVIDER_UNRESOLVED',
      metadataCalls: 0
    });
  });

  test.each([
    ['validation', query({ metrics: ['TRTI'], topMetric: 'TRTI' }), { topValues: '[]' }, 'VALIDATION_FAILURE'],
    ['empty', query(), { topValues: '[]' }, 'NO_DATA'],
    ['execution', query(), { topValues: new Error('timeout') }, 'EXECUTION_FAILURE']
  ])('Plugin/Gateway/Direct expose the same %s outcome', async (_label, request, responses, expectedOutcome) => {
    process.env.NAPM_VERIFIED_PRODUCT_BASELINE = 'netinside-napm-web-services-20201218+api-construction-rules-0725';
    const gatewayCounter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter: gatewayCounter, responses })
    );
    const gateway = await RequirementParserService.executeGatewayRequest(request);

    restoreClient();
    restoreClient = null;
    const directCounter = new SouthboundCallCounter();
    restoreClient = installRequirementParserFakeClient(
      RequirementParserService,
      new FakeNapmClient({ counter: directCounter, responses })
    );
    const direct = await RequirementParserService.executeDirectGatewayRequest(request);
    const pluginResult = plugin.__test__.makeToolResult(gateway).details;

    expect(gateway.outcome).toBe(expectedOutcome);
    expect(direct.outcome).toBe(expectedOutcome);
    expect(pluginResult.outcome).toBe(expectedOutcome);
    if (expectedOutcome === 'NO_DATA') {
      expect(gateway).toMatchObject({ dataRequestAttempted: true, dataRequestSucceeded: true, rowCount: 0 });
      expect(direct).toMatchObject({ dataRequestAttempted: true, dataRequestSucceeded: true, rowCount: 0 });
    }
  });

  test('LegacyMetricInputAdapter has only explicit execution-boundary callers', () => {
    const root = path.resolve(__dirname, '..');
    const files = [];
    const walk = (dir) => {
      fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !['node_modules', '.git', 'archive'].includes(entry.name)) walk(full);
        else if (entry.isFile() && full.endsWith('.js')) files.push(full);
      });
    };
    walk(root);
    const callers = files.filter((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return source.includes('LegacyMetricInputAdapter');
    }).map((file) => path.relative(root, file));

    expect(callers).toEqual(expect.arrayContaining([
      path.join('skills', 'openclaw-napm-query', 'services', 'RequirementParserService.js'),
      path.join('skills', 'openclaw-napm-query', 'scripts', 'OverviewPlanCompiler.js')
    ]));
    expect(callers).not.toContain(path.join('skills', 'openclaw-napm-query', 'services', 'MetricExecutionKernel.js'));
    expect(callers).not.toContain(path.join('skills', 'openclaw-napm-query', 'services', 'NapmQuerySerializer.js'));
  });
});
