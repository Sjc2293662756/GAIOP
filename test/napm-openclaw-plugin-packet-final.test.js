const plugin = require('../napm-openclaw-plugin.remote');

describe('NAPM packet deterministic final reply', () => {
  function createHarness() {
    const hooks = new Map();
    plugin.register({
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      registerTool() {},
      registerCommand() {},
      registerHook(name, handler) {
        (Array.isArray(name) ? name : [name]).forEach((eventName) => hooks.set(eventName, handler));
      }
    });
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
});
