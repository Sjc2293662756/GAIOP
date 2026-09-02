const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const packet = require('../skills/openclaw-napm-packet-analysis/scripts/run_packet_analysis');
const plugin = require('../napm-openclaw-plugin.remote');

describe('openclaw-napm-packet-analysis workgroup and time resolution', () => {
  test('resolves relative packet time from the prompt with the shared time service', () => {
    const resolved = packet.resolveQuery({
      prompt: '分析 101.254.144.238 最近5分钟的数据包情况',
      mode: 'preview_only',
      host: 'http://netinside.example.test',
      criteria: {
        ips: ['101.254.144.238']
      }
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.task.criteria.timeRange).toMatchObject({
      key: 'last5minutes',
      displayText: '最近5分钟'
    });
    expect(resolved.task.criteria.end - resolved.task.criteria.start).toBe(300);
    expect(resolved.task.criteria.start % 60).toBe(0);
    expect(resolved.task.criteria.end % 60).toBe(0);
  });

  test('does not promote nested timeRange timestamps into packet execution', () => {
    const resolved = packet.resolveQuery({
      mode: 'preview_only',
      host: 'http://netinside.example.test',
      criteria: {
        ips: ['101.254.144.238'],
        timeRange: {
          key: 'last5minutes',
          start: 1788310680,
          end: 1788310980
        }
      }
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.task.criteria.start).not.toBe(1788310680);
    expect(resolved.task.criteria.end).not.toBe(1788310980);
    expect(resolved.task.criteria.end - resolved.task.criteria.start).toBe(300);
  });

  test('accepts a BusinessGroup target and plans member IP discovery', () => {
    const resolved = packet.resolveQuery({
      prompt: '服务器网段 分析这个业务组的最近5分钟的数据包情况',
      mode: 'preview_only',
      host: 'http://netinside.example.test',
      criteria: {
        groupType: 'BusinessGroup',
        groupArgument: '服务器网段',
        timeRange: { key: 'last5minutes' }
      }
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.task.needsBusinessGroupResolution).toBe(true);
    expect(resolved.task.downloadType).toBe('packetsDown');
    expect(resolved.task.criteria.businessGroupName).toBe('服务器网段');
  });

  test('injects the active packet prompt before tool execution', async () => {
    const hooks = new Map();
    plugin.register({
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      registerTool() {},
      registerCommand() {},
      registerHook(name, handler) {
        for (const eventName of (Array.isArray(name) ? name : [name])) {
          hooks.set(eventName, handler);
        }
      }
    });

    const ctx = {
      channelId: 'wecom',
      accountId: 'acct-packet-time',
      conversationId: 'conv-packet-time',
      sessionKey: 'session-packet-time',
      sessionId: 'session-packet-time',
      runId: 'run-packet-time'
    };
    const prompt = '服务器网段 分析这个业务组的最近5分钟的数据包情况';
    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);

    const prepared = await hooks.get('before_tool_call')({
      toolName: 'napm-packet-analysis',
      params: {
        mode: 'preview_only',
        criteria: {
          groupType: 'BusinessGroup',
          groupArgument: '服务器网段'
        }
      }
    }, ctx);

    expect(prepared.params.prompt).toBe(prompt);
    expect(prepared.params.userQuery).toBe(prompt);
    expect(prepared.params.traceId).toMatch(/^napm-/);
  });

  test('builds the BusinessGroup to MemberIPs to IPAddress discovery URL', () => {
    const url = new URL(packet.buildBusinessGroupTopValuesUrl(
      'http://netinside.example.test',
      { start: 1788310680, end: 1788310980 },
      '服务器网段'
    ));

    expect(url.searchParams.get('type')).toBe('topValues');
    expect(url.searchParams.get('numGroups')).toBe('3');
    expect(url.searchParams.get('groupType1')).toBe('BusinessGroup');
    expect(url.searchParams.get('groupArgument1')).toBe('服务器网段');
    expect(url.searchParams.get('groupType2')).toBe('MemberIPs');
    expect(url.searchParams.get('groupType3')).toBe('IPAddress');
  });

  test('extracts and deduplicates IP candidates from topValues rows', () => {
    expect(packet.extractPacketCandidateIps([
      { key: '10.0.0.1' },
      { group: { argument: '10.0.0.2' } },
      { groupPath: 'BusinessGroup/MemberIPs/IPAddress/10.0.0.1' }
    ])).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  test('discovers workgroup member IPs before preview and download', async () => {
    const calls = [];
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      calls.push(url.searchParams.get('type'));
      response.setHeader('content-type', 'application/json');

      if (url.searchParams.get('type') === 'topValues') {
        response.end(JSON.stringify({ topValues: [
          { key: '10.0.0.1' },
          { key: '10.0.0.2' }
        ] }));
        return;
      }
      if (url.searchParams.get('type') === 'packetsPreview') {
        response.end(JSON.stringify({ packetCount: 2, totalBytes: 1024 }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'unexpected request' }));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const result = await packet.handleSkillCall({
      prompt: '服务器网段 分析这个业务组的最近5分钟的数据包情况',
      mode: 'preview_only',
      host: `http://127.0.0.1:${address.port}`,
      criteria: {
        groupType: 'BusinessGroup',
        groupArgument: '服务器网段'
      }
    });
    await new Promise((resolve) => server.close(resolve));

    expect(result.ok).toBe(true);
    expect(result.criteria).toMatchObject({
      businessGroupName: '服务器网段',
      ips: ['10.0.0.1', '10.0.0.2']
    });
    expect(result.criteria.timeRange.key).toBe('last5minutes');
    expect(result.businessGroupResolution).toMatchObject({
      ok: true,
      businessGroupName: '服务器网段',
      memberIpCount: 2
    });
    expect(result.preview.overview.packetCount).toBe(2);
    expect(calls).toEqual(['topValues', 'packetsPreview']);
  });

  test('downloads after workgroup discovery when preview is non-empty', async () => {
    const calls = [];
    const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'napm-packet-workgroup-'));
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const type = url.searchParams.get('type');
      calls.push(type);
      if (type === 'topValues') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify([{ key: '10.0.0.3' }]));
        return;
      }
      if (type === 'packetsPreview') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ packetCount: 1, totalBytes: 512 }));
        return;
      }
      if (type === 'packetsDown') {
        response.setHeader('content-type', 'application/vnd.tcpdump.pcap');
        response.setHeader('content-disposition', 'attachment; filename="group.pcap"');
        response.end(Buffer.from('pcap-test'));
        return;
      }
      response.statusCode = 404;
      response.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const result = await packet.handleSkillCall({
      prompt: '服务器网段 分析这个业务组的最近5分钟的数据包情况',
      mode: 'preview_download',
      host: `http://127.0.0.1:${address.port}`,
      criteria: {
        groupType: 'BusinessGroup',
        groupArgument: '服务器网段'
      },
      filePolicy: {
        downloadDir,
        keepFiles: false,
        storagePolicy: { minFreeBytes: 0, blockPercent: 100, reserveMultiplier: 0 }
      }
    });
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(downloadDir, { recursive: true, force: true });

    expect(result.ok).toBe(true);
    expect(result.download).toMatchObject({ ok: true, fileName: 'group.pcap' });
    expect(calls).toEqual(['topValues', 'packetsPreview', 'packetsDown']);
  });
});
