const manifest = require('../openclaw.plugin.json');

const PRODUCTION_TOOLS = [
  'napm-alert-packet-analysis',
  'napm-alert-query',
  'napm-fault-diagnosis',
  'napm-inspection-snapshot',
  'napm-packet-analysis',
  'napm-report-export',
  'napm-skill-query',
  'napm-summary'
];

const DIAGNOSTIC_TOOLS = [
  'napm-mainflow-query',
  'napm-resolve-query'
];

function collectRegisteredTools({ diagnostic = false } = {}) {
  if (diagnostic) {
    process.env.NAPM_ENABLE_DEV_RESOLVER_TOOLS = 'true';
  } else {
    delete process.env.NAPM_ENABLE_DEV_RESOLVER_TOOLS;
  }

  jest.resetModules();
  const plugin = require('../napm-openclaw-plugin.remote.js');
  const tools = [];

  plugin.register({
    logger: { info() {}, warn() {}, error() {} },
    registerTool(definition) {
      tools.push(definition.name);
    },
    registerCommand() {},
    registerHook() {}
  });

  return tools.sort();
}

describe('napm-openclaw-plugin manifest contracts', () => {
  const originalDiagnosticFlag = process.env.NAPM_ENABLE_DEV_RESOLVER_TOOLS;

  afterEach(() => {
    if (originalDiagnosticFlag === undefined) {
      delete process.env.NAPM_ENABLE_DEV_RESOLVER_TOOLS;
    } else {
      process.env.NAPM_ENABLE_DEV_RESOLVER_TOOLS = originalDiagnosticFlag;
    }
    jest.resetModules();
  });

  test('declares every production tool registered by the plugin', () => {
    const registered = collectRegisteredTools();

    expect(registered).toEqual(PRODUCTION_TOOLS);
    expect(manifest.contracts.tools).toEqual(expect.arrayContaining(registered));
  });

  test('declares opt-in diagnostic tools before OpenClaw registers them', () => {
    const registered = collectRegisteredTools({ diagnostic: true });

    expect(registered).toEqual([...PRODUCTION_TOOLS, ...DIAGNOSTIC_TOOLS].sort());
    expect(manifest.contracts.tools).toEqual(expect.arrayContaining(registered));
  });

  test('does not advertise the removed gatewayBaseUrl configuration', () => {
    expect(manifest.configSchema).toMatchObject({
      type: 'object',
      additionalProperties: false
    });
    expect(manifest.configSchema.properties).toEqual({});
  });
});
