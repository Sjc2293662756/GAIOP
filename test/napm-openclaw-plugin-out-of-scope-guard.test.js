const path = require('path');

describe('napm-openclaw-plugin out-of-scope guard', () => {
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
    return { hooks, tools };
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

  test.each([
    '你好？',
    '您好！',
    '嗨',
    '哈喽',
    'Hello',
    '早上好',
    '下午好',
    '晚上好',
    '在吗？',
    '你是谁？',
    '你叫什么名字？',
    '你的身份是什么？',
    '你是做什么的？',
    '你能做什么？',
    '你能做些什么？',
    '你可以干什么？',
    '你能干什么？',
    '你会干些什么？',
    '你可以做哪些事？',
    '你都能帮我做什么？',
    '你会做啥？',
    '你能干嘛？',
    '你有什么功能？',
    '你有哪些能力？',
    '你运行在哪里？',
    '你基于什么平台？',
    '请介绍一下你自己。'
  ])('should classify %s as a platform identity prompt', (prompt) => {
    expect(plugin.__test__.isPlatformIdentityPrompt(prompt)).toBe(true);
  });

  test.each([
    '今天天气怎么样？',
    '讲个笑话。',
    '你好，今天天气怎么样？',
    '您好，讲个笑话。',
    '你好，帮我查一下现在系统情况。',
    '你能帮我查一下现在系统情况吗？',
    '你可以干什么来分析 239web？',
    '你都能帮我做什么，先查一下 239web？',
    '你有什么功能，顺便查一下现在系统情况？',
    '你是谁，帮我看看 239web 最近情况？',
    '系统支持哪些指标？'
  ])('should not classify %s as a platform identity prompt', (prompt) => {
    expect(plugin.__test__.isPlatformIdentityPrompt(prompt)).toBe(false);
  });

  test('should use an immutable three-state turn policy without requiring an identity regex match', () => {
    const { buildTurnPolicy, turnPolicyRoutes } = plugin.__test__;
    const modelOwned = buildTurnPolicy({ prompt: '你是？' });
    const explicitOutOfScope = buildTurnPolicy({ prompt: '今天天气怎么样？' });
    const napmCandidate = buildTurnPolicy({
      prompt: '看看 239web 最近情况',
      napmRelated: true,
      domainRelated: true
    });

    expect(plugin.__test__.isPlatformIdentityPrompt('你是？')).toBe(false);
    expect(Object.isFrozen(modelOwned)).toBe(true);
    expect(modelOwned).toMatchObject({
      route: turnPolicyRoutes.MODEL_OWNED,
      modelOwnsResponse: true,
      toolActionsAllowed: false
    });
    expect(explicitOutOfScope.route).toBe(turnPolicyRoutes.EXPLICIT_OUT_OF_SCOPE);
    expect(napmCandidate).toMatchObject({
      route: turnPolicyRoutes.NAPM_CANDIDATE,
      toolActionsAllowed: true
    });
  });

  test.each([
    ['greeting', '你好？'],
    ['time-greeting', '早上好'],
    ['identity', '你是谁？'],
    ['capability', '你能做什么？'],
    ['capability-synonym', '你可以干什么？'],
    ['platform', '你运行在哪里？']
  ])('should preserve the model answer for a %s prompt in both outgoing hooks', async (suffix, prompt) => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const messageSending = hooks.get('message_sending');
    const beforeMessageWrite = hooks.get('before_message_write');
    const ctx = createWeComCtx(suffix);
    const identityReply = '我是观枢AI，运行在 OpenClaw 上，面向观枢 GAIOP / NAPM 提供智能运维服务。';

    messageReceived({ content: prompt }, ctx);
    const promptBuildResult = await beforePromptBuild({ prompt }, ctx);

    expect(promptBuildResult.appendSystemContext).toContain('IDENTITY.md');
    expect(promptBuildResult.appendSystemContext).toContain('不得调用 NAPM skill');
    await expect(messageSending({ content: identityReply }, ctx)).resolves.toBeUndefined();
    expect(beforeMessageWrite({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: identityReply }]
      }
    }, ctx)).toBeUndefined();
  });

  test.each([
    ['short-identity', '你是？'],
    ['formal-short-identity', '您是？'],
    ['preferred-name', '怎么称呼？'],
    ['brief-introduction', '简单介绍下？']
  ])('should leave unenumerated model-owned prompt %s to the model', async (suffix, prompt) => {
    const { hooks } = createApiHarness();
    const ctx = createWeComCtx(`model-owned-${suffix}`);
    const modelReply = '我是观枢AI，运行在 OpenClaw 上，面向观枢 GAIOP / NAPM 提供智能运维服务。';

    hooks.get('message_received')({ content: prompt }, ctx);
    const promptBuildResult = await hooks.get('before_prompt_build')({ prompt }, ctx);

    expect(promptBuildResult.appendSystemContext).toContain('MODEL-OWNED');
    await expect(hooks.get('message_sending')({ content: modelReply }, ctx)).resolves.toBeUndefined();
    expect(hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: modelReply }]
      }
    }, ctx)).toBeUndefined();
  });

  test('should leave an elliptical identity follow-up to the model after a NAPM turn', async () => {
    const { hooks } = createApiHarness();
    const ctx = createWeComCtx('napm-then-model-owned-identity');
    const modelReply = '我是观枢AI。';

    hooks.get('message_received')({ content: '看看 239web 最近情况' }, ctx);
    await hooks.get('before_prompt_build')({ prompt: '看看 239web 最近情况' }, ctx);

    hooks.get('message_received')({ content: '那你呢？' }, ctx);
    const promptBuildResult = await hooks.get('before_prompt_build')({ prompt: '那你呢？' }, ctx);

    expect(promptBuildResult.appendSystemContext).toContain('MODEL-OWNED');
    await expect(hooks.get('message_sending')({ content: modelReply }, ctx)).resolves.toBeUndefined();
  });

  test('should keep identity plus NAPM composite requests behind Skill evidence', async () => {
    const { hooks } = createApiHarness();
    const ctx = createWeComCtx('identity-plus-napm');
    const prompt = '你是？顺便帮我看看 239web 最近情况。';

    hooks.get('message_received')({ content: prompt }, ctx);
    const promptBuildResult = await hooks.get('before_prompt_build')({ prompt }, ctx);
    const outgoing = await hooks.get('message_sending')({ content: '我是观枢AI。239web 正常。' }, ctx);

    expect(promptBuildResult.appendSystemContext).toContain('TOOL ROUTING');
    expect(outgoing.content).toContain('必须经 NAPM skill');
  });

  test('should block tools while an unenumerated prompt is model-owned', async () => {
    const { hooks } = createApiHarness();
    const ctx = createWeComCtx('model-owned-tool-call');
    const prompt = '你是？';

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);

    const result = hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      params: {
        prompt,
        resolvedQuery: {
          service: 'overview',
          queryModeKey: 'overview',
          overviewScene: 'global',
          timeRange: { key: 'last1hour' }
        }
      }
    }, ctx);

    expect(result).toMatchObject({ block: true });
    expect(result.blockReason).toContain('模型直接回答');
  });

  test('should preserve a greeting immediately after /new', async () => {
    const { hooks } = createApiHarness();
    const ctx = createWeComCtx('new-then-greeting');
    const greetingReply = '你好，我是观枢AI。';

    hooks.get('message_received')({ content: '/new' }, ctx);
    await expect(hooks.get('message_sending')({
      content: 'New session started.'
    }, ctx)).resolves.toBeUndefined();

    hooks.get('message_received')({ content: '你好？' }, ctx);
    const promptBuildResult = await hooks.get('before_prompt_build')({ prompt: '你好？' }, ctx);

    expect(promptBuildResult.appendSystemContext).toContain('IDENTITY.md');
    await expect(hooks.get('message_sending')({ content: greetingReply }, ctx)).resolves.toBeUndefined();
    expect(hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: greetingReply }]
      }
    }, ctx)).toBeUndefined();
  });

  test.each([
    '你有什么功能？',
    '你有哪些能力？'
  ])('should preserve the identity answer for %s immediately after /new', async (prompt) => {
    const { hooks } = createApiHarness();
    const ctx = createWeComCtx(`new-then-${prompt}`);
    const identityReply = '我是观枢AI，可以协助查询和分析观枢 GAIOP / NAPM 监控数据。';

    hooks.get('message_received')({ content: '/new' }, ctx);
    await expect(hooks.get('message_sending')({
      content: 'New session started.'
    }, ctx)).resolves.toBeUndefined();

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);

    await expect(hooks.get('message_sending')({ content: identityReply }, ctx)).resolves.toBeUndefined();
    expect(hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: identityReply }]
      }
    }, ctx)).toBeUndefined();
  });

  test('should not inherit NAPM state when a capability prompt follows an inspection turn', async () => {
    const { hooks } = createApiHarness();
    const ctx = createWeComCtx('inspection-then-capability');
    const identityReply = '我是观枢AI，可以协助处理观枢 GAIOP / NAPM 智能运维任务。';

    hooks.get('message_received')({ content: '生成一份系统巡检报告' }, ctx);
    await hooks.get('before_prompt_build')({ prompt: '生成一份系统巡检报告' }, ctx);

    hooks.get('message_received')({ content: '你能做些什么？' }, ctx);
    await hooks.get('before_prompt_build')({ prompt: '你能做些什么？' }, ctx);

    await expect(hooks.get('message_sending')({ content: identityReply }, ctx)).resolves.toBeUndefined();
    expect(hooks.get('before_message_write')({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: identityReply }]
      }
    }, ctx)).toBeUndefined();
  });

  test.each([
    ['你有什么功能？', { napmRelated: false }],
    ['你能做些什么？', { napmRelated: true }]
  ])('should never require Skill evidence for identity prompt %s', (prompt, guardState) => {
    expect(plugin.__test__.shouldRequireSkillBackedReply(prompt, guardState, null)).toBe(false);
    expect(plugin.__test__.shouldForceSkillRecordForPrompt(prompt, guardState)).toBe(false);
  });

  test('should reject tool calls during a pure identity turn', async () => {
    const { hooks } = createApiHarness();
    const ctx = createWeComCtx('identity-tool-call');
    const prompt = '你有什么功能？';

    hooks.get('message_received')({ content: prompt }, ctx);
    await hooks.get('before_prompt_build')({ prompt }, ctx);

    const result = hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      params: { prompt }
    }, ctx);

    expect(result).toMatchObject({
      block: true
    });
    expect(result.blockReason).toContain('身份');
  });

  test('should keep real NAPM inventory prompts behind Skill evidence', () => {
    const prompt = '系统里有哪些业务？';

    expect(plugin.__test__.classifyNapmWorkflow(prompt)).toMatchObject({
      workflowType: 'object_inventory',
      targetObjectType: 'WebApplication'
    });
    expect(plugin.__test__.shouldRequireSkillBackedReply(prompt, { napmRelated: true }, null)).toBe(true);
  });

  test('should restore the general out-of-scope guard on the next ordinary turn', async () => {
    const { hooks } = createApiHarness();
    const ctx = createWeComCtx('identity-then-weather');

    hooks.get('message_received')({ content: '你是谁？' }, ctx);
    await hooks.get('before_prompt_build')({ prompt: '你是谁？' }, ctx);
    await expect(hooks.get('message_sending')({
      content: '我是观枢AI，面向观枢 GAIOP / NAPM。'
    }, ctx)).resolves.toBeUndefined();

    hooks.get('message_received')({ content: '今天天气怎么样？' }, ctx);
    await hooks.get('before_prompt_build')({ prompt: '今天天气怎么样？' }, ctx);
    const weatherReply = await hooks.get('message_sending')({ content: '今天晴。' }, ctx);

    expect(weatherReply.content).toContain('像天气、闲聊、泛问答这类内容不在当前技能范围内');
  });

  test('should rewrite weather prompt during message_sending', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const messageSending = hooks.get('message_sending');

    const ctx = createWeComCtx('weather-send');
    const prompt = '今天天气怎么样？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    const result = await messageSending({
      content: '北京今天（5月14日）天气：晴，29°C。'
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.content).toContain('我当前只处理系统监控');
    expect(result.content).toContain('天气');
  });

  test('should block all tool actions for an explicit out-of-scope prompt', async () => {
    const { hooks } = createApiHarness();
    const ctx = createWeComCtx('weather-tool-call');
    const prompt = '今天天气怎么样？';

    hooks.get('message_received')({ content: prompt }, ctx);
    const promptBuildResult = await hooks.get('before_prompt_build')({ prompt }, ctx);
    const result = hooks.get('before_tool_call')({
      toolName: 'napm-skill-query',
      params: { prompt }
    }, ctx);

    expect(promptBuildResult.appendSystemContext).toContain('EXPLICIT OUT-OF-SCOPE');
    expect(result).toMatchObject({ block: true });
  });

  test('should rewrite weather prompt during before_message_write', async () => {
    const { hooks } = createApiHarness();
    const messageReceived = hooks.get('message_received');
    const beforePromptBuild = hooks.get('before_prompt_build');
    const beforeMessageWrite = hooks.get('before_message_write');

    const ctx = createWeComCtx('weather-write');
    const prompt = '今天天气怎么样？';

    messageReceived({ content: prompt }, ctx);
    await beforePromptBuild({ prompt }, ctx);

    const result = await beforeMessageWrite({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '北京今天（5月14日）天气：晴，29°C。' }]
      }
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.message.content[0].text).toContain('我当前只处理系统监控');
    expect(result.message.content[0].text).toContain('天气');
  });
});
