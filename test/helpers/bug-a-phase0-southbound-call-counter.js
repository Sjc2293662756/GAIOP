'use strict';

const METADATA_SERVICES = Object.freeze([
  'applications',
  'businessGroups',
  'groups',
  'groupArguments',
  'metrics',
  'metricsForGroup',
  'granularities'
]);

const DATA_SERVICES = Object.freeze([
  'topValues',
  'averageValues',
  'timeValues',
  'pageViews'
]);

function buildBucket(serviceNames) {
  return Object.fromEntries(serviceNames.map((service) => [service, 0]));
}

class SouthboundCallCounter {
  constructor() {
    this.calls = [];
    this.total = 0;
    this.metadata = buildBucket(METADATA_SERVICES);
    this.data = buildBucket(DATA_SERVICES);
  }

  record(method, params = {}) {
    const service = String(params?.type || '').trim();
    this.total += 1;
    this.calls.push({
      method: String(method || ''),
      service,
      params: { ...params }
    });

    if (Object.prototype.hasOwnProperty.call(this.metadata, service)) {
      this.metadata[service] += 1;
    }
    if (Object.prototype.hasOwnProperty.call(this.data, service)) {
      this.data[service] += 1;
    }
  }

  snapshot() {
    return {
      total: this.total,
      metadata: { ...this.metadata },
      data: { ...this.data }
    };
  }

  callsFor(service) {
    const normalized = String(service || '').trim();
    return this.calls.filter((call) => call.service === normalized);
  }
}

class FakeNapmClient {
  constructor({ counter = new SouthboundCallCounter(), responses = {} } = {}) {
    this.counter = counter;
    this.responses = responses;
    this.username = 'phase0-test-user';
    this.password = 'phase0-test-password';
    this.baseUrl = 'https://example.invalid/webservice/NetInside';
  }

  async get(params = {}) {
    this.counter.record('get', params);
    return this.resolveResponse('get', params, '[]');
  }

  async getJson(params = {}) {
    this.counter.record('getJson', params);
    return this.resolveResponse('getJson', params, []);
  }

  async resolveResponse(method, params, fallback) {
    const service = String(params?.type || '').trim();
    const configured = this.responses[service];
    const value = typeof configured === 'function'
      ? await configured({ method, params: { ...params } })
      : configured;

    if (value instanceof Error) {
      throw value;
    }
    return value === undefined ? fallback : value;
  }
}

function installRequirementParserFakeClient(requirementParserService, fakeClient) {
  const service = requirementParserService;
  const metadataService = service.napmMetadataService;
  const original = {
    serviceClient: service.napmClient,
    metadataClient: metadataService.napmClient,
    metadataKernelClient: service.metadataExecutionKernel.context.napmClient,
    metadataKernelService: service.metadataExecutionKernel.context.napmMetadataService,
    metricKernelClient: service.metricExecutionKernel.context.napmClient,
    detailKernelClient: service.pageViewsExecutionKernel.context.napmClient
  };

  service.napmClient = fakeClient;
  metadataService.napmClient = fakeClient;
  service.metadataExecutionKernel.context.napmClient = fakeClient;
  service.metadataExecutionKernel.context.napmMetadataService = metadataService;
  service.metricExecutionKernel.context.napmClient = fakeClient;
  service.pageViewsExecutionKernel.context.napmClient = fakeClient;
  metadataService.clearCache();

  return function restoreRequirementParserClients() {
    service.napmClient = original.serviceClient;
    metadataService.napmClient = original.metadataClient;
    service.metadataExecutionKernel.context.napmClient = original.metadataKernelClient;
    service.metadataExecutionKernel.context.napmMetadataService = original.metadataKernelService;
    service.metricExecutionKernel.context.napmClient = original.metricKernelClient;
    service.pageViewsExecutionKernel.context.napmClient = original.detailKernelClient;
    metadataService.clearCache();
  };
}

module.exports = {
  DATA_SERVICES,
  METADATA_SERVICES,
  SouthboundCallCounter,
  FakeNapmClient,
  installRequirementParserFakeClient
};
