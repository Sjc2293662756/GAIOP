const fs = require('fs');
const path = require('path');
const {
  sanitize,
  maskSensitiveParams,
  buildSafeUrl
} = require('../skills/openclaw-napm-query/src/utils/auditLogger');

describe('NAPM query log safety', () => {
  test('redacts credentials, internal URLs, IPs, object names, and response bodies', () => {
    const safe = sanitize({
      username: 'operator',
      baseUrl: 'https://10.0.0.8/webservice',
      businessName: '支付平台',
      groupArgument1: '核心业务',
      response: { rows: [{ ip: '10.1.2.3' }] },
      note: 'request failed at https://10.0.0.8/webservice?token=secret'
    });

    expect(safe).toMatchObject({
      username: '[masked]',
      baseUrl: '[masked]',
      businessName: '[masked]',
      groupArgument1: '[masked]',
      response: '[masked]'
    });
    expect(JSON.stringify(safe)).not.toContain('operator');
    expect(JSON.stringify(safe)).not.toContain('支付平台');
    expect(JSON.stringify(safe)).not.toContain('10.0.0.8');
    expect(safe.note).toContain('[internal-url]');
  });

  test('masks authentication and named-object parameters in debug URLs', () => {
    const params = maskSensitiveParams({
      UserName: 'operator',
      Password: 'secret',
      groupArgument1: '支付平台',
      metrics: 'BYTIO'
    });
    const url = buildSafeUrl('https://example.invalid/webservice', params);

    expect(url).not.toContain('operator');
    expect(url).not.toContain('secret');
    expect(url).not.toContain(encodeURIComponent('支付平台'));
    expect(url).toContain('metrics=BYTIO');
  });

  test('does not log raw NAPM payload snippets or primitive Winston metadata', () => {
    const serviceRoot = path.resolve(__dirname, '../skills/openclaw-napm-query');
    const files = [
      'services/MetricExecutionKernel.js',
      'services/NapmClient.js',
      'services/RequirementParserService.js',
      'src/utils/TimeUtils.js'
    ];
    const source = files
      .map((relativePath) => fs.readFileSync(path.join(serviceRoot, relativePath), 'utf8'))
      .join('\n');

    expect(source).not.toMatch(/rawPayload\.substring\(/);
    expect(source).not.toMatch(/response:\s*error\.response\s*\?/);
    expect(source).not.toMatch(/logger\.(?:error|warn|info)\([^,\n]+,\s*error\.message\s*\)/);
    expect(source).not.toMatch(/logger\.(?:error|warn|info)\([^,\n]+,\s*`[^`]*`\s*\)/);
  });
});
