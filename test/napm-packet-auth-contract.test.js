'use strict';

const http = require('node:http');
const {
  executePacketTask
} = require('../skills/openclaw-napm-packet-analysis/scripts/run_packet_analysis');

describe('NAPM packet runtime authentication contract', () => {
  let server;
  let host;
  let receivedUrl;
  let originalUsername;
  let originalPassword;
  let originalCookie;

  beforeEach(async () => {
    originalUsername = process.env.NETINSIDE_USERNAME;
    originalPassword = process.env.NETINSIDE_PASSWORD;
    originalCookie = process.env.NETINSIDE_COOKIE;
    process.env.NETINSIDE_USERNAME = 'runtime-user';
    process.env.NETINSIDE_PASSWORD = 'runtime-password';
    delete process.env.NETINSIDE_COOKIE;

    server = http.createServer((request, response) => {
      receivedUrl = new URL(request.url, 'http://127.0.0.1');
      const authenticated = receivedUrl.searchParams.get('UserName') === 'runtime-user'
        && receivedUrl.searchParams.get('Password') === 'runtime-password';
      response.statusCode = authenticated ? 200 : 403;
      response.setHeader('Content-Type', authenticated ? 'application/json' : 'text/plain');
      response.end(authenticated ? JSON.stringify({ data: [{ available: true }] }) : 'denied');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    host = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv('NETINSIDE_USERNAME', originalUsername);
    restoreEnv('NETINSIDE_PASSWORD', originalPassword);
    restoreEnv('NETINSIDE_COOKIE', originalCookie);
  });

  test('uses runtime query credentials internally without exposing them in public URLs', async () => {
    const result = await executePacketTask({
      mode: 'preview_only',
      host,
      criteria: {
        ips: ['101.254.114.237', '101.254.114.238'],
        start: 1786327320,
        end: 1786327560
      }
    });

    expect(result).toMatchObject({
      ok: true,
      preview: {
        ok: true,
        statusCode: 200,
        empty: false
      }
    });
    expect(receivedUrl.searchParams.get('UserName')).toBe('runtime-user');
    expect(receivedUrl.searchParams.get('Password')).toBe('runtime-password');
    expect(result.urls.preview).not.toContain('runtime-user');
    expect(result.urls.preview).not.toContain('runtime-password');
    expect(result.preview.urlMasked).not.toContain('runtime-user');
    expect(result.preview.urlMasked).not.toContain('runtime-password');
  });
});

function restoreEnv(key, value) {
  if (value == null) delete process.env[key];
  else process.env[key] = value;
}
