const path = require('path');

describe('napm-openclaw-plugin meta follow-up guard', () => {
  const originalExecutor = process.env.NAPM_SKILL_EXECUTOR;
  let plugin = null;

  beforeAll(() => {
    process.env.NAPM_SKILL_EXECUTOR = path.resolve(__dirname, '../skills/openclaw-napm-query/scripts/run_napm_query.js');
    jest.resetModules();
    plugin = require('../napm-openclaw-plugin.remote.js');
  });

  afterAll(() => {
    if (originalExecutor === undefined) {
      delete process.env.NAPM_SKILL_EXECUTOR;
      return;
    }
    process.env.NAPM_SKILL_EXECUTOR = originalExecutor;
  });

  function createApiHarness() {
    const hooks = new Map();
    const tools = new Map();
    const api = {
      config: {},
      logger: {
        info() {},
        warn() {},
        error() {}
      },
      registerTool(def) {
        tools.set(def.name, def);
      },
      registerCommand() {},
      registerHook(name, handler) {
        if (Array.isArray(name)) {
          name.forEach((item) => hooks.set(item, handler));
          return;
        }
        hooks.set(name, handler);
      }
    };

    plugin.register(api);
    return {
      hooks,
      tools
    };
  }

  function createWeComCtx(suffix) {
    return {
      channelId: 'wecom',
      accountId: `acct-${suffix}`,
      conversationId: `conv-${suffix}`,
      sessionKey: `session-${suffix}`,
      sessionId: `session-${suffix}`,
      runId: `run-${suffix}`
    };
  }

  test('should recognize napm meta follow-up prompt from previous napm context', () => {
    const testApi = plugin.__test__;
    expect(testApi.isNapmMetaFollowUpPrompt('你这次用了多长时间？时间都消耗在哪里了？', { napmRelated: true })).toBe(true);
    expect(testApi.isNapmMetaFollowUpPrompt('你构成api的思路是什么和方法来源是哪里？', { napmRelated: true })).toBe(true);
    expect(testApi.isNapmMetaFollowUpPrompt('这个你是怎么查询的？', { napmRelated: true })).toBe(true);
    expect(testApi.isNapmMetaFollowUpPrompt('python过滤输出是什么？谁在做？', { napmRelated: true })).toBe(true);
    expect(testApi.isNapmMetaFollowUpPrompt('今天星期几？', { napmRelated: true })).toBe(false);
  });

  test('should require skill-backed reply for napm meta follow-up without remembered result', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const messageSending = hooks.get('message_sending');

    const ctx = createWeComCtx('meta-followup-required');

    messageReceived({ content: '业务组都有什么下钻路径？' }, ctx);
    await beforePromptBuild({ prompt: '业务组都有什么下钻路径？' }, ctx);

    messageReceived({ content: '你这次用了多长时间？时间都消耗在哪里了？' }, ctx);
    await beforePromptBuild({ prompt: '你这次用了多长时间？时间都消耗在哪里了？' }, ctx);

    const result = await messageSending({
      content: '从收到问题到返回结果约 8 秒，我先写了 Node.js 脚本，然后又重试了一次。'
    }, ctx);

    expect(result).toBeTruthy();
    expect(typeof result.content).toBe('string');
    expect(result.content).toContain('当前没有可核验的 NAPM skill 执行记录');
    expect(result.content).not.toContain('Node.js 脚本');
    expect(result.content).not.toContain('约 8 秒');
  });

  test('should answer execution trace follow-up only from verifiable skill record', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const messageSending = hooks.get('message_sending');

    const ctx = createWeComCtx('meta-followup-trace');

    messageReceived({ content: '丢包最大的IP地址是谁？' }, ctx);
    await beforePromptBuild({ prompt: '丢包最大的IP地址是谁？' }, ctx);

    messageReceived({ content: '这次你怎么查的？' }, ctx);
    await beforePromptBuild({ prompt: '这次你怎么查的？' }, ctx);

    const result = await messageSending({
      content: '这次我直接 curl 调了 NetInside 底层 API，然后用 Python 解析，没有走 skill。'
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.content).toContain('当前没有可核验的 NAPM skill 执行记录');
    expect(result.content).not.toContain('直接 curl 调了');
    expect(result.content).not.toContain('Python 解析');
    expect(result.content).not.toContain('没有走 skill');
  });

  test('should answer business inventory trace from recent skill metadata instead of model inference', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const messageSending = hooks.get('message_sending');
    const testApi = plugin.__test__;

    const ctx = createWeComCtx('business-inventory-trace');

    messageReceived({ content: '现在系统中有哪些业务？' }, ctx);
    await beforePromptBuild({ prompt: '现在系统中有哪些业务？' }, ctx);
    testApi.rememberSkillResult('现在系统中有哪些业务？', {
      ok: true,
      service: 'groups',
      resolvedQuery: {
        service: 'groups',
        queryModeKey: 'metadata',
        groups: [{ type: 'WebApplication' }],
        semanticConstraints: {
          operation: 'metadata_list'
        }
      },
      requestParamsJson: {
        type: 'applications',
        json: 'true'
      },
      metadata: {
        providerType: 'applications',
        apiType: 'applications',
        applicationTypeFilter: [3]
      },
      summary: {
        displayText: '系统中目前有 9 个业务系统（WebApplication，applications Type=3）'
      }
    }, testApi.getConversationKey(ctx));

    messageReceived({ content: '这个你是怎么查询的呢？' }, ctx);
    await beforePromptBuild({ prompt: '这个你是怎么查询的呢？' }, ctx);

    const result = await messageSending({
      content: 'applications 接口返回的是近期有流量数据的活跃应用，所以 Esxi-Web 和 Zabbix-web 近期有流量了。'
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.content).toContain('requestParams：{"type":"applications","json":"true"}');
    expect(result.content).toContain('providerType=applications');
    expect(result.content).toContain('applicationTypeFilter=[3]');
    expect(result.content).toContain('这不是按流量活跃度过滤');
    expect(result.content).toContain('也不是中文名称过滤');
    expect(result.content).not.toContain('近期有流量数据的活跃应用');
    expect(result.content).not.toContain('近期有流量了');
  });

  test('should replace exec/python bypass trace for business inventory with skill trace', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const messageSending = hooks.get('message_sending');
    const testApi = plugin.__test__;

    const ctx = createWeComCtx('business-inventory-python-bypass-trace');
    const prompt = '当前系统里有哪些业务系统？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);
    testApi.rememberSkillResult(prompt, {
      ok: true,
      service: 'groups',
      resolvedQuery: {
        service: 'groups',
        queryModeKey: 'metadata',
        groups: [{ type: 'WebApplication' }],
        semanticConstraints: {
          workflowType: 'object_inventory',
          operation: 'metadata_list',
          targetObjectType: 'WebApplication'
        }
      },
      requestParamsJson: {
        type: 'applications',
        json: 'true'
      },
      metadata: {
        providerType: 'applications',
        apiType: 'applications',
        applicationTypeFilter: [3]
      },
      summary: {
        displayText: '系统中目前有 9 个业务系统（WebApplication，applications Type=3）。'
      }
    }, testApi.getConversationKey(ctx));

    messageReceived({ content: 'python过滤输出是什么？谁在做？' }, ctx);
    await beforePromptBuild({ prompt: 'python过滤输出是什么？谁在做？' }, ctx);

    const result = await messageSending({
      content: 'python过滤输出是我通过 exec 工具执行 python 命令，直接从API返回的119条原始数据里筛选，没有经过 napm-skill-query 的中间管道。'
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.content).toContain('napm-skill-query');
    expect(result.content).toContain('service');
    expect(result.content).toContain('providerType=applications');
    expect(result.content).toContain('applicationTypeFilter=[3]');
    expect(result.content).not.toContain('exec 工具');
    expect(result.content).not.toContain('python 命令');
    expect(result.content).not.toContain('没有经过 napm-skill-query');
  });

  test('should replace unsupported active-traffic explanation in business inventory answer', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const messageSending = hooks.get('message_sending');
    const testApi = plugin.__test__;

    const ctx = createWeComCtx('business-inventory-active-claim');
    const prompt = '现在系统中有哪些业务？';
    const displayText = [
      '系统中目前有 9 个业务系统（WebApplication，applications Type=3）：',
      '1. 回溯238web',
      '2. Esxi-Web',
      '查询口径：南向 applications 目录，按 Type=3 识别 WebApplication/业务系统；这不是按流量活跃度过滤，也不是中文名称过滤。'
    ].join('\n');

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);
    const seededResult = {
      ok: true,
      service: 'groups',
      resolvedQuery: {
        service: 'groups',
        groups: [{ type: 'WebApplication' }]
      },
      summary: {
        displayText
      }
    };
    const scope = testApi.getConversationKey(ctx);
    const turnId = testApi.queryTurnCoordinator.resolveTurnId(scope, ctx.runId);
    testApi.rememberSkillResult(prompt, seededResult, scope, 'napm-skill-query', turnId);
    testApi.queryTurnCoordinator.recordDecision({
      scope,
      turnId,
      queryDraft: seededResult.resolvedQuery,
      decision: { action: 'EXECUTE_QUERY', southboundAllowed: true }
    });
    testApi.queryTurnCoordinator.beginExecution({
      scope,
      turnId,
      attemptId: 'business-inventory-result',
      queryDraft: seededResult.resolvedQuery
    });
    testApi.queryTurnCoordinator.recordResult({
      scope,
      turnId,
      result: seededResult,
      finalContent: displayText
    });

    const result = await messageSending({
      content: '现在系统中有 9 个业务系统，通过 type=applications 接口查询，返回近期有活跃流量的业务应用。'
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.content).toContain('不是按流量活跃度过滤');
    expect(result.content).toContain('不是中文名称过滤');
    expect(result.content).not.toContain('近期有活跃流量');
  });

  test('should block first-answer business inventory bypass without skill record', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const messageSending = hooks.get('message_sending');

    const ctx = createWeComCtx('business-inventory-first-answer-bypass');
    const prompt = '系统中有哪些业务？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    const result = await messageSending({
      content: [
        '系统中"业务"相关共 14个：',
        'Web业务应用（9个）：Esxi-Web、Zabbix-web、交通可观测性分析平台',
        '自定义业务应用（5个）：Esxi-local、HIS系统1、Zabbix、可观测239、回溯238',
        '查询方式：直接调用后端 type=applications API -> python按type字段过滤 -> 返回结果，未经过中间管道过滤。'
      ].join('\n')
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.content).toContain('NAPM skill');
    expect(result.content).toContain('未拿到有效 skill 结果');
    expect(result.content).not.toContain('14个');
    expect(result.content).not.toContain('自定义业务应用');
    expect(result.content).not.toContain('python按type字段过滤');
    expect(result.content).not.toContain('未经过中间管道');
  });
});
