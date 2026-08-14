'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ConversationScopeRegistry,
  resolveConversationScope
} = require('../plugin/ConversationScopeResolver');
const ReportSourceStore = require('../plugin/ReportSourceStore');

describe('report source handoff', () => {
  test('uses the trusted session key when channel tuple is incomplete', () => {
    expect(resolveConversationScope({
      sessionKey: 'wecom:account-1:conversation-7',
      channelId: null,
      accountId: null,
      conversationId: null
    })).toBe('session:wecom:account-1:conversation-7');

    expect(resolveConversationScope({
      channelId: 'wecom',
      accountId: 'account-1',
      conversationId: 'conversation-7'
    })).toBe('conversation:wecom:account-1:conversation-7');

    expect(resolveConversationScope({ sessionKey: '  ' })).toBe('');
  });

  test('resolves split hook identities to the canonical session scope', () => {
    const registry = new ConversationScopeRegistry({ now: () => 1000 });
    const canonicalScope = registry.resolve({
      sessionKey: 'agent:main:wecom:direct:shijc',
      channelId: 'wecom',
      accountId: 'default',
      conversationId: 'shijc'
    });

    expect(canonicalScope).toBe('session:agent:main:wecom:direct:shijc');
    expect(registry.resolve({
      channelId: 'wecom',
      accountId: 'default',
      conversationId: 'shijc'
    })).toBe(canonicalScope);
    expect(registry.clearScope(canonicalScope)).toBe(2);
    expect(registry.resolve({
      channelId: 'wecom',
      accountId: 'default',
      conversationId: 'shijc'
    })).toBe('conversation:wecom:default:shijc');
  });

  test('persists an owned source across store instances and protects scope', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-report-source-'));
    let now = 1_000;
    const first = new ReportSourceStore({ baseDir, now: () => now, ttlMs: 1_000 });
    const stored = first.put({
      scope: 'session:wecom:account-1:conversation-7',
      sourceTool: 'napm-summary',
      reportData: { reportType: 'summary_report', title: 'Daily', sections: [{ heading: 'A' }] }
    });

    expect(stored.ok).toBe(true);
    expect(stored.reportSourceId).toMatch(/^rps_[a-f0-9-]+$/);
    expect(first.get({
      reportSourceId: stored.reportSourceId,
      scope: 'session:wecom:account-1:conversation-7'
    })).toMatchObject({ ok: true, reportSourceId: stored.reportSourceId });

    const restarted = new ReportSourceStore({ baseDir, now: () => now, ttlMs: 1_000 });
    expect(restarted.get({
      reportSourceId: stored.reportSourceId,
      scope: 'session:wecom:account-1:conversation-7'
    }).reportData.title).toBe('Daily');
    expect(restarted.get({
      reportSourceId: stored.reportSourceId,
      scope: 'session:wecom:other-conversation'
    })).toMatchObject({ ok: false, errorCode: 'REPORT_SOURCE_FORBIDDEN' });

    now += 1_001;
    expect(restarted.get({
      reportSourceId: stored.reportSourceId,
      scope: 'session:wecom:account-1:conversation-7'
    })).toMatchObject({ ok: false, errorCode: 'REPORT_SOURCE_EXPIRED' });

    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('does not guess when more than one fresh source is available', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-report-source-'));
    const store = new ReportSourceStore({ baseDir, now: () => 10_000, ttlMs: 60_000 });
    store.put({ scope: 'session:a', sourceTool: 'napm-summary', reportData: { reportType: 'summary_report' } });
    store.put({ scope: 'session:a', sourceTool: 'napm-alert-query', reportData: { reportType: 'alert_report' } });

    expect(store.findForScope('session:a')).toMatchObject({
      ok: false,
      errorCode: 'REPORT_SOURCE_AMBIGUOUS'
    });
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('rejects oversized report sources before writing them', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-report-source-'));
    const store = new ReportSourceStore({ baseDir, maxBytes: 100 });
    expect(store.put({
      scope: 'session:a',
      sourceTool: 'napm-summary',
      reportData: { reportType: 'summary_report', value: 'x'.repeat(200) }
    })).toMatchObject({ ok: false, errorCode: 'REPORT_SOURCE_TOO_LARGE' });
    expect(fs.readdirSync(baseDir)).toHaveLength(0);
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('clears persisted report sources for one scope only', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napm-report-source-clear-'));
    const store = new ReportSourceStore({ baseDir, now: () => 10_000, ttlMs: 60_000 });
    const removed = store.put({
      scope: 'session:one',
      sourceTool: 'napm-summary',
      reportData: { reportType: 'summary_report', title: 'remove' }
    });
    const retained = store.put({
      scope: 'session:two',
      sourceTool: 'napm-summary',
      reportData: { reportType: 'summary_report', title: 'keep' }
    });

    expect(store.clearScope('session:one')).toBe(1);
    expect(store.get({ reportSourceId: removed.reportSourceId, scope: 'session:one' })).toMatchObject({
      ok: false,
      errorCode: 'REPORT_SOURCE_NOT_FOUND'
    });
    expect(store.get({ reportSourceId: retained.reportSourceId, scope: 'session:two' })).toMatchObject({
      ok: true,
      reportSourceId: retained.reportSourceId
    });
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
});
