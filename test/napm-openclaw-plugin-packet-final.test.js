const plugin = require('../napm-openclaw-plugin.remote');
const packetRuntime = require('../skills/openclaw-napm-packet-analysis/scripts/run_packet_analysis');

describe('NAPM packet deterministic final reply', () => {
  function createHarness() {
    const hooks = new Map();
    const tools = new Map();
    plugin.register({
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      registerHook(name, handler) {
        (Array.isArray(name) ? name : [name]).forEach((eventName) => hooks.set(eventName, handler));
      }
    });
    hooks.tools = tools;
    return hooks;
  }

  function createContext() {
    return {
      channelId: 'wecom',
      accountId: 'packet-final-account',
      conversationId: 'packet-final-conversation',
      sessionKey: 'packet-final-session',
      sessionId: 'packet-final-session',
      runId: 'packet-final-run'
    };
  }

  test('canonicalizes a misclassified workgroup and blocks shell bypass', async () => {
    const hooks = createHarness();
    const ctx = createContext();
    const prompt = '请分析业务组“服务器网段”最近5分钟的数据包情况，先预览，不下载。';
    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);

    const prepared = await hooks.get('before_tool_call')({
      toolName: 'napm-packet-analysis',
      toolCallId: 'packet-canonicalize',
      params: {
        mode: 'preview_only',
        criteria: {
          ipRanges: ['服务器网段'],
          timeRange: { key: 'last5minutes' }
        }
      }
    }, ctx);

    expect(prepared.params.criteria).toMatchObject({
      businessGroupName: '服务器网段',
      groupType: 'BusinessGroup',
      groupArgument: '服务器网段',
      ips: [],
      ipRanges: []
    });

    const blocked = await hooks.get('before_tool_call')({
      toolName: 'exec',
      params: { command: 'echo packet probe' }
    }, ctx);
    expect(blocked).toMatchObject({ block: true });
  });

  test('does not let a stale native-command marker bypass packet guards', async () => {
    const hooks = createHarness();
    const ctx = createContext();
    hooks.get('message_received')({ content: '/status' }, ctx);

    const blocked = await hooks.get('before_tool_call')({
      toolName: 'exec',
      params: {
        prompt: '请分析业务组“服务器网段”最近5分钟的数据包情况',
        command: 'curl https://netinside.example.test/webservice/NetInside?type=packetsPreview'
      }
    }, ctx);

    expect(blocked).toMatchObject({ block: true });
  });

  test('continues a confirmed packet preview with fixed criteria and executes the skill once', async () => {
    const hooks = createHarness();
    const previewCtx = createContext();
    previewCtx.runId = 'packet-preview-confirmation-run';
    const previewPrompt = '分析 101.254.114.238 最近5分钟的数据包情况';
    hooks.get('message_received')({ content: previewPrompt }, previewCtx);
    await hooks.get('before_prompt_build')({ prompt: previewPrompt }, previewCtx);
    const previewBound = await hooks.get('before_tool_call')({
      toolName: 'napm-packet-analysis',
      toolCallId: 'packet-preview-confirmation',
      params: {
        prompt: previewPrompt,
        mode: 'preview_download_analyze',
        criteria: {
          ips: ['101.254.114.238'],
          timeRange: { key: 'last5minutes' }
        }
      }
    }, previewCtx);
    const scope = plugin.__test__.getTrustedConversationKey(previewBound.params);
    const previewTurnId = plugin.__test__.getTrustedTurnId(previewBound.params);
    plugin.__test__.rememberSkillResult(previewPrompt, {
      ok: false,
      mode: 'preview_download_analyze',
      criteria: {
        prompt: previewPrompt,
        userQuery: previewPrompt,
        ips: ['101.254.114.238'],
        ipRanges: [],
        start: 1788493200,
        end: 1788493500,
        timeRange: {
          key: 'last5minutes',
          start: 1788493200,
          end: 1788493500
        }
      },
      preview: {
        ok: true,
        empty: false,
        overview: { rowCount: 101 },
        risk: { level: 'unknown', recommendation: 'CONFIRM_DOWNLOAD' }
      },
      decision: { next_action: 'CONFIRM_DOWNLOAD' },
      error: { code: 'PACKET_PREVIEW_REQUIRES_CONFIRMATION' },
      narrationInput: { schema: 'openclaw_napm_packet_analysis.v1' }
    }, scope, 'napm-packet-analysis', previewTurnId);

    const followUpCtx = { ...previewCtx, runId: 'packet-download-confirmation-run' };
    const followUpPrompt = '确认下载并分析；';
    hooks.get('message_received')({ content: followUpPrompt }, followUpCtx);
    await hooks.get('before_prompt_build')({ prompt: followUpPrompt }, followUpCtx);

    const modelParams = {
      prompt: previewPrompt,
      mode: 'preview_download_analyze',
      criteria: {
        ips: ['203.0.113.99'],
        timeRange: { key: 'last5minutes' }
      }
    };
    const firstBound = await hooks.get('before_tool_call')({
      toolName: 'napm-packet-analysis',
      toolCallId: 'packet-download-confirmation-1',
      params: modelParams
    }, followUpCtx);
    const secondBound = await hooks.get('before_tool_call')({
      toolName: 'napm-packet-analysis',
      toolCallId: 'packet-download-confirmation-2',
      params: modelParams
    }, followUpCtx);

    expect(firstBound.block).not.toBe(true);
    expect(firstBound.params).toMatchObject({
      mode: 'preview_download_analyze',
      previewRiskAccepted: true,
      criteria: {
        ips: ['101.254.114.238'],
        ipRanges: [],
        start: 1788493200,
        end: 1788493500
      }
    });
    expect(firstBound.params.criteria.timeRange).toBeUndefined();
    expect(firstBound.params.prompt).toContain('数据包');
    expect(firstBound.params.traceId).toBeTruthy();
    expect(plugin.__test__.queryTurnCoordinator.get(
      scope,
      plugin.__test__.getTrustedTurnId(firstBound.params)
    )).toMatchObject({ route: 'OTHER_SKILL' });

    const completedResult = {
      ok: true,
      mode: 'preview_download_analyze',
      criteria: firstBound.params.criteria,
      preview: { ok: true, empty: false, overview: { rowCount: 101 } },
      download: { ok: true, fileName: 'capture.pcap', bytes: 2048 },
      analysis: {
        ok: true,
        capinfos: { number_of_packets: '42' },
        protocolHierarchy: ['eth frames:42 bytes:2048', '  ip frames:42 bytes:2048'],
        endpoints: ['10.0.0.1 10 1024'],
        conversations: ['10.0.0.1 <-> 10.0.0.2 10 1024'],
        dnsQueries: [{ value: 'example.test', count: 2 }],
        httpRows: ['example.test|/health|200'],
        tlsSni: [{ value: 'example.test', count: 1 }]
      },
      narrationInput: { schema: 'openclaw_napm_packet_analysis.v1' }
    };
    const executeSpy = jest.spyOn(packetRuntime, 'handleSkillCall')
      .mockImplementation(async () => completedResult);
    const packetTool = hooks.tools.get('napm-packet-analysis');
    const [firstResult, replayResult] = await Promise.all([
      packetTool.execute('packet-download-confirmation-1', firstBound.params),
      packetTool.execute('packet-download-confirmation-2', secondBound.params)
    ]);

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(firstResult.details).toEqual(completedResult);
    expect(replayResult.details).toEqual(completedResult);

    const outgoing = await hooks.get('message_sending')({ content: 'I will summarize the packet.' }, followUpCtx);
    expect(outgoing.content).toContain('下载完成：capture.pcap');
    expect(outgoing.content).toContain('协议分析：已完成');
    expect(outgoing.content).toContain('数据包数：42 个');
    expect(outgoing.content).toContain('协议层级：eth frames:42 bytes:2048');
    expect(outgoing.content).toContain('DNS 查询：example.test（2 次）');
    expect(outgoing.content).toContain('HTTP 记录：example.test|/health|200');
    expect(outgoing.content).toContain('TLS SNI：example.test（1 次）');
  });

  test('does not authorize a bare download command without a pending packet preview', async () => {
    const hooks = createHarness();
    const ctx = {
      ...createContext(),
      conversationId: 'packet-no-pending-conversation',
      runId: 'packet-no-pending-run'
    };
    const prompt = '进行下载分析！';
    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);

    const guarded = await hooks.get('before_tool_call')({
      toolName: 'napm-packet-analysis',
      toolCallId: 'packet-no-pending',
      params: {
        prompt,
        mode: 'preview_download_analyze',
        previewRiskAccepted: true,
        criteria: {
          ips: ['203.0.113.99'],
          start: 1788493200,
          end: 1788493500,
          previewRiskAccepted: true
        }
      }
    }, ctx);

    expect(guarded).toMatchObject({ block: true });
  });

  test('strips model-provided packet preview confirmation from an initial request', async () => {
    const hooks = createHarness();
    const ctx = {
      ...createContext(),
      conversationId: 'packet-untrusted-confirmation-conversation',
      runId: 'packet-untrusted-confirmation-run'
    };
    const prompt = '分析 101.254.114.238 最近5分钟的数据包情况';
    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);

    const guarded = await hooks.get('before_tool_call')({
      toolName: 'napm-packet-analysis',
      toolCallId: 'packet-untrusted-confirmation',
      params: {
        prompt,
        mode: 'preview_download_analyze',
        previewRiskAccepted: true,
        packetQuery: {
          previewRiskAccepted: true,
          criteria: { previewRiskAccepted: true }
        },
        criteria: {
          ips: ['101.254.114.238'],
          timeRange: { key: 'last5minutes' },
          previewRiskAccepted: true
        }
      }
    }, ctx);

    expect(guarded.block).not.toBe(true);
    expect(guarded.params.previewRiskAccepted).toBeUndefined();
    expect(guarded.params.criteria.previewRiskAccepted).toBeUndefined();
    expect(guarded.params.packetQuery.previewRiskAccepted).toBeUndefined();
    expect(guarded.params.packetQuery.criteria.previewRiskAccepted).toBeUndefined();
  });

  test('does not accept confirmation for a preview that requires a narrower time range', async () => {
    const hooks = createHarness();
    const previewCtx = {
      ...createContext(),
      conversationId: 'packet-narrow-range-conversation',
      runId: 'packet-narrow-range-preview-run'
    };
    const previewPrompt = '分析 101.254.114.238 最近1小时的数据包情况';
    hooks.get('message_received')({ content: previewPrompt }, previewCtx);
    await hooks.get('before_prompt_build')({ prompt: previewPrompt }, previewCtx);
    const previewBound = await hooks.get('before_tool_call')({
      toolName: 'napm-packet-analysis',
      toolCallId: 'packet-narrow-range-preview',
      params: {
        prompt: previewPrompt,
        mode: 'preview_download_analyze',
        criteria: {
          ips: ['101.254.114.238'],
          start: 1788489900,
          end: 1788493500
        }
      }
    }, previewCtx);
    plugin.__test__.rememberSkillResult(previewPrompt, {
      ok: false,
      mode: 'preview_download_analyze',
      criteria: previewBound.params.criteria,
      preview: {
        ok: true,
        empty: false,
        overview: { rowCount: 101 },
        risk: { level: 'high', recommendation: 'SUGGEST_NARROW_TIME_RANGE' }
      },
      decision: { next_action: 'SUGGEST_NARROW_TIME_RANGE' },
      error: { code: 'PACKET_PREVIEW_TOO_LARGE' },
      narrationInput: { schema: 'openclaw_napm_packet_analysis.v1' }
    }, plugin.__test__.getTrustedConversationKey(previewBound.params), 'napm-packet-analysis',
    plugin.__test__.getTrustedTurnId(previewBound.params));

    const followUpCtx = { ...previewCtx, runId: 'packet-narrow-range-confirm-run' };
    const followUpPrompt = '确认下载！';
    hooks.get('message_received')({ content: followUpPrompt }, followUpCtx);
    await hooks.get('before_prompt_build')({ prompt: followUpPrompt }, followUpCtx);
    const guarded = await hooks.get('before_tool_call')({
      toolName: 'napm-packet-analysis',
      toolCallId: 'packet-narrow-range-confirm',
      params: {
        prompt: followUpPrompt,
        mode: 'preview_download_analyze',
        previewRiskAccepted: true,
        criteria: previewBound.params.criteria
      }
    }, followUpCtx);

    expect(guarded.params?.previewRiskAccepted).toBeUndefined();
    expect(guarded.params?.criteria?.previewRiskAccepted).toBeUndefined();
  });

  test('replaces model planning text with the current packet result exactly once', async () => {
    const hooks = createHarness();
    const ctx = createContext();
    ctx.runId = 'packet-final-run-delivery';
    const prompt = '请分析业务组“服务器网段”最近5分钟的数据包情况，先预览，不下载。';
    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);
    const bound = await hooks.get('before_tool_call')({
      toolName: 'napm-packet-analysis',
      toolCallId: 'packet-delivery',
      params: { mode: 'preview_only', criteria: { businessGroupName: '服务器网段' } }
    }, ctx);
    const params = bound.params;
    const scope = plugin.__test__.getTrustedConversationKey(params);
    const turnId = plugin.__test__.getTrustedTurnId(params);
    plugin.__test__.rememberSkillResult(prompt, {
      ok: true,
      mode: 'preview_only',
      criteria: { businessGroupName: '服务器网段', start: 1788394620, end: 1788394920 },
      businessGroupResolution: {
        ok: true,
        businessGroupName: '服务器网段',
        memberIpCount: 0,
        memberIpRangeCount: 1,
        memberCount: 1
      },
      preview: { ok: true, empty: false, overview: { rowCount: 101 } },
      urls: { preview: 'https://netinside.example.test/?type=packetsPreview&Password=***' },
      narrationInput: { schema: 'openclaw_napm_packet_analysis.v1' }
    }, scope, 'napm-packet-analysis', turnId);

    const leaked = 'Let me check the packet skill and then summarize the 101 sessions.';
    const first = await hooks.get('message_sending')({ content: leaked }, ctx);
    const second = await hooks.get('message_sending')({ content: leaked }, ctx);

    expect(first.content).toContain('预览记录数：101 条');
    expect(first.content).not.toContain(leaked);
    expect(second).toEqual({ cancel: true });
  });

  test('reports preview records without inventing packet counts, traffic, or health judgments', () => {
    const reply = plugin.__test__.buildPacketFinalReply({
      ok: true,
      mode: 'preview_only',
      criteria: {
        businessGroupName: '服务器网段',
        start: 1788394620,
        end: 1788394920
      },
      businessGroupResolution: {
        ok: true,
        businessGroupName: '服务器网段',
        memberIpCount: 0,
        memberIpRangeCount: 1,
        memberCount: 1,
        memberIpRanges: ['101.254.114.235-101.254.114.242']
      },
      preview: {
        ok: true,
        empty: false,
        overview: {
          packetCount: null,
          estimatedBytes: null,
          rowCount: 101
        }
      },
      urls: {
        preview: 'https://netinside.example.test/webservice/NetInside?type=packetsPreview&Password=***'
      },
      summary: {
        highlights: ['预览接口返回了数据。']
      }
    });

    expect(reply).toContain('时间范围：2026-09-03 08:17:00 至 2026-09-03 08:22:00');
    expect(reply).toContain('业务组：服务器网段');
    expect(reply).toContain('预览记录数：101 条');
    expect(reply).toContain('仅预览，未下载');
    expect(reply).not.toContain('101 个包');
    expect(reply).not.toContain('14 MB');
    expect(reply).not.toContain('拥塞');
    expect(reply).not.toContain('扫描特征');
  });

  test('renders NetInside preview traffic evidence and omits unusable masked URLs by default', () => {
    const reply = plugin.__test__.buildPacketFinalReply({
      ok: true,
      mode: 'preview_only',
      criteria: {
        businessGroupName: '服务器网段',
        start: 1788394620,
        end: 1788394920,
      },
      businessGroupResolution: {
        ok: true,
        businessGroupName: '服务器网段',
        memberIpCount: 0,
        memberIpRangeCount: 1,
        memberIpRanges: ['101.254.114.235-101.254.114.242'],
      },
      preview: {
        ok: true,
        empty: false,
        overview: {
          packetCount: null,
          estimatedBytes: null,
          rowCount: 3,
          trafficSummary: {
            conversationCount: 3,
            endpointCount: 4,
            trafficBytes: 3584,
            trafficSizeText: '3.50 KB',
            directions: {
              outbound: { conversationCount: 1, bytes: 2048, sizeText: '2.00 KB' },
              inbound: { conversationCount: 1, bytes: 1024, sizeText: '1.00 KB' },
              internal: { conversationCount: 1, bytes: 512, sizeText: '512 B' },
              unmatched: { conversationCount: 0, bytes: 0, sizeText: '0 B' },
            },
            topGroupMembers: [
              { ip: '101.254.114.237', bytes: 2560, sizeText: '2.50 KB', conversationCount: 2 },
              { ip: '101.254.114.238', bytes: 1536, sizeText: '1.50 KB', conversationCount: 2 },
            ],
            topConversations: [
              { sourceIp: '101.254.114.237', destinationIp: '8.8.8.8', bytes: 2048, sizeText: '2.00 KB', direction: 'outbound' },
              { sourceIp: '9.9.9.9', destinationIp: '101.254.114.238', bytes: 1024, sizeText: '1.00 KB', direction: 'inbound' },
            ],
          },
        },
      },
      urls: {
        preview: 'https://netinside.example.test/webservice/NetInside?UserName=***&Password=***&type=packetsPreview',
      },
    });

    expect(reply).toContain('成员范围：101.254.114.235-101.254.114.242');
    expect(reply).toContain('预览命中：3 条通信记录，涉及 4 个端点');
    expect(reply).toContain('预览流量：3.50 KB');
    expect(reply).toContain('业务组流向：发出 2.00 KB（1 条）、进入 1.00 KB（1 条）、组内互访 512 B（1 条）');
    expect(reply).toContain('活跃成员：101.254.114.237 2.50 KB（2 条）');
    expect(reply).toContain('主要通信：101.254.114.237 -> 8.8.8.8 2.00 KB');
    expect(reply).toContain('尚未执行 pcap 协议分析');
    expect(reply).not.toContain('预览链接');
    expect(reply).not.toContain('Password=');
  });

  test('keeps time and target context when packet preview is empty', () => {
    const reply = plugin.__test__.buildPacketFinalReply({
      ok: false,
      mode: 'preview_download_analyze',
      criteria: {
        ips: ['101.254.144.238'],
        start: 1788420840,
        end: 1788421140,
      },
      preview: {
        ok: true,
        empty: true,
        overview: { rowCount: 0 },
      },
      error: {
        code: 'PACKET_PREVIEW_EMPTY',
        message: 'packetsPreview 未返回可下载数据。',
      },
      decision: {
        next_action: 'NO_DOWNLOAD',
      },
    });

    expect(reply).toContain('数据包分析结果');
    expect(reply).toContain('时间范围：2026-09-03 15:34:00 至 2026-09-03 15:39:00');
    expect(reply).toContain('目标 IP：101.254.144.238');
    expect(reply).toContain('预览结果：未发现匹配的数据包');
    expect(reply).toContain('未下载，也未执行协议分析');
    expect(reply).not.toBe('packetsPreview 未返回可下载数据。');
  });

  test('does not render missing preview traffic evidence as zero', () => {
    const reply = plugin.__test__.buildPacketFinalReply({
      ok: true,
      mode: 'preview_only',
      criteria: {
        ips: ['10.0.0.1'],
        start: 1788420840,
        end: 1788421140,
      },
      preview: {
        ok: true,
        empty: false,
        overview: {
          rowCount: 1,
          trafficSummary: {
            conversationCount: 1,
            endpointCount: 2,
            trafficBytes: null,
            trafficSizeText: null,
            directions: {
              outbound: { conversationCount: 1, bytes: null, sizeText: null },
            },
            topGroupMembers: [
              { ip: '10.0.0.1', bytes: null, sizeText: null, conversationCount: null },
            ],
            topConversations: [
              { sourceIp: '10.0.0.1', destinationIp: '8.8.8.8', bytes: null, sizeText: null },
            ],
          },
        },
      },
    });

    expect(reply).not.toContain('预览流量：0 B');
    expect(reply).toContain('目标流向：发出 流量未知（1 条）');
    expect(reply).toContain('活跃成员：10.0.0.1 流量未知');
    expect(reply).toContain('主要通信：10.0.0.1 -> 8.8.8.8 流量未知');
    expect(reply).not.toContain('流量未知（0 条）');
  });
});
