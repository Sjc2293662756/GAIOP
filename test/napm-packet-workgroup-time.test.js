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

  test('repairs a model-generated group name that was placed in ipRanges', () => {
    const resolved = packet.resolveQuery({
      prompt: '请分析业务组“服务器网段”最近5分钟的数据包情况，先预览，不下载。',
      mode: 'preview_only',
      host: 'http://netinside.example.test',
      criteria: {
        ipRanges: ['服务器网段'],
        timeRange: { key: 'last5minutes' }
      }
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.task.needsBusinessGroupResolution).toBe(true);
    expect(resolved.task.criteria.businessGroupName).toBe('服务器网段');
    expect(resolved.task.criteria.ips).toEqual([]);
    expect(resolved.task.criteria.ipRanges).toEqual([]);
  });

  test.each([
    {
      label: 'infers an untyped workgroup name from the packet prompt',
      criteria: {}
    },
    {
      label: 'repairs an untyped workgroup name misplaced in ipRanges',
      criteria: { ipRanges: ['服务器网段'] }
    }
  ])('$label without requiring a prior workgroup inventory query', ({ criteria }) => {
    const resolved = packet.resolveQuery({
      prompt: '看一下最近一分钟服务器网段的数据包情况！',
      mode: 'preview_only',
      host: 'http://netinside.example.test',
      criteria
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.task.needsBusinessGroupResolution).toBe(true);
    expect(resolved.task.criteria).toMatchObject({
      businessGroupName: '服务器网段',
      groupType: 'BusinessGroup',
      groupArgument: '服务器网段',
      ips: [],
      ipRanges: []
    });
  });

  test('keeps malformed IPv4 as a target validation error instead of treating it as a group name', () => {
    const resolved = packet.resolveQuery({
      prompt: '分析 999.999.999.999 最近一分钟的数据包情况',
      mode: 'preview_only',
      host: 'http://netinside.example.test',
      criteria: { ips: ['999.999.999.999'] }
    });

    expect(resolved.ok).toBe(false);
    expect(resolved.error.code).toBe('PACKET_TARGET_INVALID');
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

  test('builds the businessGroups CSV discovery URL', () => {
    const url = new URL(packet.buildBusinessGroupsUrl('http://netinside.example.test'));

    expect(url.pathname).toBe('/webservice/NetInside');
    expect(url.searchParams.get('type')).toBe('businessGroups');
    expect(url.searchParams.get('csv')).toBe('true');
    expect(url.searchParams.has('start')).toBe(false);
    expect(url.searchParams.has('end')).toBe(false);
  });

  test('parses quoted business-group CSV and splits member IPs and ranges', () => {
    const rows = packet.parseBusinessGroupsCsv('\ufeffName,IpMembers,Description\r\n"服务器网段","10.0.0.1, 10.0.0.2, 10.0.0.0-10.0.0.255,not-an-ip","主机,生产"\r\n');
    expect(rows).toEqual([
      {
        Name: '服务器网段',
        IpMembers: '10.0.0.1, 10.0.0.2, 10.0.0.0-10.0.0.255,not-an-ip',
        Description: '主机,生产'
      }
    ]);
    expect(packet.parseBusinessGroupIpMembers(rows[0].IpMembers)).toEqual({
      ips: ['10.0.0.1', '10.0.0.2'],
      ipRanges: ['10.0.0.0-10.0.0.255'],
      invalidMembers: ['not-an-ip']
    });
  });

  test('discovers workgroup member IPs before preview and download', async () => {
    const calls = [];
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      calls.push(url.searchParams.get('type'));
      if (url.searchParams.get('type') === 'businessGroups') {
        response.setHeader('content-type', 'text/csv; charset=utf-8');
        response.end('Name,IpMembers\r\n服务器网段,"10.0.0.1,10.0.0.2,10.0.0.0-10.0.0.255"\r\n');
        return;
      }
      if (url.searchParams.get('type') === 'packetsPreview') {
        expect(url.searchParams.getAll('ips')).toEqual(['10.0.0.1', '10.0.0.2']);
        expect(url.searchParams.getAll('ipRanges')).toEqual(['10.0.0.0-10.0.0.255']);
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
      memberIpCount: 2,
      path: ['businessGroups', 'IpMembers'],
      memberIpRanges: ['10.0.0.0-10.0.0.255'],
      invalidMembers: []
    });
    expect(result.preview.overview.packetCount).toBe(2);
    expect(calls).toEqual(['businessGroups', 'packetsPreview']);
  });

  test('discovers an untyped workgroup name before preview without a prior inventory query', async () => {
    const calls = [];
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const type = url.searchParams.get('type');
      calls.push(type);
      if (type === 'businessGroups') {
        response.setHeader('content-type', 'text/csv; charset=utf-8');
        response.end('Name,IpMembers\n服务器网段,"10.0.0.8-10.0.0.9"\n');
        return;
      }
      if (type === 'packetsPreview') {
        expect(url.searchParams.getAll('ips')).toEqual([]);
        expect(url.searchParams.getAll('ipRanges')).toEqual(['10.0.0.8-10.0.0.9']);
        response.end(JSON.stringify({ packetCount: 2, totalBytes: 2048 }));
        return;
      }
      response.statusCode = 404;
      response.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const result = await packet.handleSkillCall({
      prompt: '看一下最近一分钟服务器网段的数据包情况！',
      mode: 'preview_only',
      host: `http://127.0.0.1:${address.port}`,
      criteria: {}
    });
    await new Promise((resolve) => server.close(resolve));

    expect(result.ok).toBe(true);
    expect(result.criteria).toMatchObject({
      businessGroupName: '服务器网段',
      ipRanges: ['10.0.0.8-10.0.0.9']
    });
    expect(result.businessGroupResolution).toMatchObject({
      ok: true,
      businessGroupName: '服务器网段',
      memberIpRangeCount: 1
    });
    expect(result.preview.overview.packetCount).toBe(2);
    expect(calls).toEqual(['businessGroups', 'packetsPreview']);
  });

  test('downloads after workgroup discovery when preview is non-empty', async () => {
    const calls = [];
    const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'napm-packet-workgroup-'));
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const type = url.searchParams.get('type');
      calls.push(type);
      if (type === 'businessGroups') {
        response.setHeader('content-type', 'text/csv; charset=utf-8');
        response.end('Name,IpMembers\n服务器网段,"10.0.0.3"\n');
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
    expect(calls).toEqual(['businessGroups', 'packetsPreview', 'packetsDown']);
  });

  test('does not call packet endpoints when the business-group name is not found', async () => {
    const calls = [];
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const type = url.searchParams.get('type');
      calls.push(type);
      if (type === 'businessGroups') {
        response.setHeader('content-type', 'text/csv; charset=utf-8');
        response.end('Name,IpMembers\nother-group,"10.0.0.4"\n');
        return;
      }
      response.statusCode = 500;
      response.end('packet endpoint must not be called');
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

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('BUSINESS_GROUP_NOT_FOUND');
    expect(calls).toEqual(['businessGroups']);
  });
});
