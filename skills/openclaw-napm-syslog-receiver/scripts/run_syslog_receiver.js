#!/usr/bin/env node
'use strict';

const http = require('http');
const path = require('path');
const AlertEventStoreService = require('../services/AlertEventStoreService');
const AlertReceiverSettingsStore = require('../services/AlertReceiverSettingsStore');
const SyslogReceiverService = require('../services/SyslogReceiverService');

const host = process.env.GAIOP_ALERT_RECEIVER_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.GAIOP_ALERT_RECEIVER_PORT || '19090', 10);
const syslogPath = process.env.GAIOP_SYSLOG_PATH || '/var/log/netinside/syslog.log';
const dataDir = process.env.GAIOP_ALERTS_DATA_DIR || path.join(__dirname, '..', 'data');
const accessToken = process.env.GAIOP_ALERT_RECEIVER_TOKEN || '';
const maxEntries = Math.max(3000, Number.parseInt(process.env.GAIOP_ALERT_RECEIVER_MAX_ENTRIES || '100000', 10) || 100000);
const retentionDays = Math.max(1, Number.parseInt(process.env.GAIOP_ALERT_RECEIVER_RETENTION_DAYS || '31', 10) || 31);
const settingsStore = new AlertReceiverSettingsStore({
  dataDir,
  defaultEnabled: process.env.GAIOP_ALERT_RECEIVER_ENABLED !== 'false',
});
const receiver = new SyslogReceiverService({
  syslogPath,
  eventStore: new AlertEventStoreService({ dataDir, maxEntries, retentionDays }),
  enabled: settingsStore.get().enabled,
});

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function authorized(request) {
  return !accessToken || request.headers['x-gaiop-alert-token'] === accessToken;
}

const server = http.createServer((request, response) => {
  if (!authorized(request)) return sendJson(response, 401, { ok: false, code: 'ALERT_RECEIVER_UNAUTHORIZED' });
  if (request.method === 'GET' && request.url === '/health') return sendJson(response, 200, { ok: true, health: receiver.health() });
  if (request.method === 'GET' && request.url?.startsWith('/alerts')) {
    const query = new URL(request.url, 'http://localhost').searchParams;
    const page = Math.max(1, Number.parseInt(query.get('page') || '1', 10) || 1);
    const pageSize = Math.min(3000, Math.max(1, Number.parseInt(query.get('pageSize') || '10', 10) || 10));
    return sendJson(response, 200, {
      ok: true,
      ...receiver.eventStore.list({
        page,
        pageSize,
        severity: query.get('severity'),
        category: query.get('category'),
        keyword: query.get('keyword'),
        startAt: query.get('startAt'),
        endAt: query.get('endAt'),
      }),
    });
  }
  if (request.method === 'PUT' && request.url === '/config') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        const input = JSON.parse(body || '{}');
        if (typeof input.enabled !== 'boolean') return sendJson(response, 400, { ok: false, code: 'ALERT_RECEIVER_CONFIG_INVALID' });
        settingsStore.setEnabled(input.enabled);
        receiver.setEnabled(input.enabled);
        return sendJson(response, 200, { ok: true, health: receiver.health() });
      } catch (_error) { return sendJson(response, 400, { ok: false, code: 'ALERT_RECEIVER_CONFIG_INVALID' }); }
    });
    return;
  }
  sendJson(response, 404, { ok: false, code: 'ALERT_RECEIVER_NOT_FOUND' });
});

receiver.start();
server.listen(port, host, () => console.log(`[GAIOP Syslog Receiver] listening on ${host}:${port}`));
process.on('SIGTERM', () => { receiver.stop(); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { receiver.stop(); server.close(() => process.exit(0)); });
