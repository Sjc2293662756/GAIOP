/**
 * GroupPathPlannerService.js
 *
 * 负责根据静态 groups tree、当前 query 形态和用户问句语义，
 * 规划一条更适合执行的对象路径（group path）。
 * 它常用于把“顶层对象 + 下钻意图”收敛成明确的多层 groups 结构。
 */
const NapmMetadataService = require('./NapmMetadataService');
const GroupBuilder = require('./GroupBuilder');

// 问句中的对象概念提示，用于给候选路径打分时提升相关分支权重。
const PROMPT_CONCEPTS = [
  {
    id: 'other_app',
    patterns: [/\bOtherApp\b/i, /\bother\s*app(?:lication)?\b/i, /其他应用|其它应用|未知应用/],
    preferredContainers: ['OtherApps'],
    preferredTerminals: ['OtherApp']
  },
  {
    id: 'application',
    patterns: [/\bDefinedApp\b/i, /\bApplication\b/i, /\bapp(?:lication)?s?\b/i, /应用|协议/],
    preferredContainers: ['Applications', 'OtherApps'],
    preferredTerminals: ['DefinedApp', 'OtherApp', 'Application']
  },
  {
    id: 'client_ip',
    patterns: [/\bClientIPs\b/i, /\bclient(?:\s*ip|\s*ips)?\b/i, /客户端IP|客户端ip|客户端/],
    preferredContainers: ['ClientIPs'],
    preferredTerminals: ['IPAddress']
  },
  {
    id: 'server_ip',
    patterns: [/\bServerIPs\b/i, /\bserver(?:\s*ip|\s*ips)?\b/i, /服务端IP|服务器IP|服务端|服务器/],
    preferredContainers: ['ServerIPs'],
    preferredTerminals: ['IPAddress']
  },
  {
    id: 'member_ip',
    patterns: [/\bMemberIPs\b/i, /\bmember(?:\s*ip|\s*ips)?\b/i, /成员IP|成员/],
    preferredContainers: ['MemberIPs'],
    preferredTerminals: ['IPAddress', 'ConnectedIP']
  },
  {
    id: 'connected_group',
    patterns: [/\bConnectedGroups\b/i, /\bconnected\s*groups?\b/i, /连接组|对端业务组|对端组|连接业务组/],
    preferredContainers: ['ConnectedGroups'],
    preferredTerminals: ['BusinessGroup', 'ConnectedBusinessGroup']
  },
  {
    id: 'connected_ip',
    patterns: [/\bConnectedIPs\b/i, /\bConnectedIP\b/i, /\bconnected\s*ip(?:s)?\b/i, /\bpeer\s*ip(?:s)?\b/i, /连接IP|对端IP|连接对象|对端主机|对端/],
    preferredContainers: ['ConnectedIPs', 'ObservedIPs', 'AffiliatedIPs'],
    preferredTerminals: ['ConnectedIP', 'IPAddress']
  },
  {
    id: 'conversation',
    patterns: [/\bIPConversation\b/i, /\bIPConversations\b/i, /\bconversation\b/i, /\bsession\b/i, /会话/],
    preferredContainers: ['IPConversations'],
    preferredTerminals: ['IPConversation']
  },
  {
    id: 'page_family',
    patterns: [/\bPageFamilies\b/i, /\bPageFamily\b/i, /\bpage\s*famil(?:y|ies)\b/i, /页面族|页面分类|页面/],
    preferredContainers: ['PageFamilies'],
    preferredTerminals: ['PageFamily']
  },
  {
    id: 'originating_ip',
    patterns: [/\bOriginatingIPs\b/i, /\bOriginatingIP\b/i, /\boriginating\s*ip(?:s)?\b/i, /初始IP|源IP|发起IP/],
    preferredContainers: ['OriginatingIPs'],
    preferredTerminals: ['OriginatingIP', 'IPAddress']
  },
  {
    id: 'observed_ip',
    patterns: [/\bObservedIPs\b/i, /\bobserved\s*ip(?:s)?\b/i, /看到的IP|观察到的IP|可见IP/],
    preferredContainers: ['ObservedIPs'],
    preferredTerminals: ['ConnectedIP', 'IPAddress']
  },
  {
    id: 'affiliated_ip',
    patterns: [/\bAffiliatedIPs\b/i, /\baffiliated\s*ip(?:s)?\b/i, /关联IP|归属IP/],
    preferredContainers: ['AffiliatedIPs'],
    preferredTerminals: ['ConnectedIP', 'IPAddress']
  },
  {
    id: 'user',
    patterns: [/\bUsers\b/i, /\bUser\b/i, /\buser(?:s)?\b/i, /用户/],
    preferredContainers: ['Users'],
    preferredTerminals: ['User']
  }
];

// 在缺少更强语义信号时使用的默认下钻分支偏好。
const DEFAULT_BRANCHES = {
  WebApplication: [
    ['ClientIPs', 'IPAddress'],
    ['PageFamilies', 'PageFamily'],
    ['ServerIPs', 'IPAddress'],
    ['Users', 'User']
  ],
  PageFamily: [
    ['ClientIPs', 'IPAddress'],
    ['Users', 'User'],
    ['OriginatingIPs', 'OriginatingIP']
  ],
  BusinessGroup: [
    ['MemberIPs', 'IPAddress'],
    ['Applications', 'DefinedApp'],
    ['ConnectedIPs', 'IPAddress'],
    ['IPConversations', 'IPConversation']
  ],
  Prefix24: [
    ['MemberIPs', 'IPAddress'],
    ['Applications', 'DefinedApp'],
    ['ConnectedIPs', 'ConnectedIP'],
    ['IPConversations', 'IPConversation']
  ],
  IPAddress: [
    ['ConnectedIPs', 'ConnectedIP'],
    ['Applications', 'DefinedApp'],
    ['ConnectedGroups', 'BusinessGroup'],
    ['OtherApps', 'OtherApp']
  ],
  DefinedApp: [
    ['ObservedIPs', 'ConnectedIP'],
    ['AffiliatedIPs', 'ConnectedIP'],
    ['IPConversations', 'IPConversation']
  ],
  OtherApp: [
    ['ObservedIPs', 'ConnectedIP'],
    ['AffiliatedIPs', 'ConnectedIP'],
    ['IPConversations', 'IPConversation']
  ]
};

/**
 * 路径规划服务
 * 负责从静态 groups tree 中枚举候选路径，并结合语义信号挑选最佳执行路径。
 */
class GroupPathPlannerService {
  // 复用元数据服务与 group type 解析能力，统一路径中的对象类型口径。
  constructor() {
    this.napmMetadataService = NapmMetadataService;
    this.groupBuilder = GroupBuilder;
  }

  // 统一 groupType 表达，兼容静态树、运行时 key 与自然语言别名。
  normalizeGroupType(groupType = '') {
    const raw = String(groupType || '').trim();
    if (!raw) {
      return '';
    }

    const runtimeKey = this.napmMetadataService.normalizeRuntimeGroupKey(raw);
    const mapped = this.groupBuilder.parseGroupType(runtimeKey);
    return mapped || runtimeKey;
  }

  // 把输入 groups 规范化成仅保留 type/argument 的标准结构。
  normalizeGroups(groups = []) {
    if (!Array.isArray(groups)) {
      return [];
    }

    return groups
      .map((item) => ({
        type: this.normalizeGroupType(item?.type),
        argument: item?.argument ?? null
      }))
      .filter((item) => item.type);
  }

  // 从 query 的多个语义来源中收集目标对象类型候选。
  collectTargetTypes(query = {}) {
    const candidates = [
      query?.semanticConstraints?.targetObjectType,
      query?.candidateSpec?.semantic_constraints?.targetObjectType,
      query?.executionBinding?.rankingTargetType,
      query?.pathResolve?.target_group,
      query?.pathResolve?.initial_target_group,
      query?.resolutionHints?.group?.type
    ];

    return Array.from(new Set(
      candidates
        .map((item) => this.normalizeGroupType(item))
        .filter(Boolean)
    ));
  }

  isDrilldownPrompt(prompt = '') {
    const text = String(prompt || '').trim();
    if (!text) {
      return false;
    }

    return /(?:继续|接着|往下|下钻|深入|细看|明细|详情|详细|展开|下一层|具体到|具体看|钻取)/i.test(text);
  }

  matchPromptConcepts(prompt = '') {
    const text = String(prompt || '').trim();
    if (!text) {
      return [];
    }

    return PROMPT_CONCEPTS.filter((item) => item.patterns.some((pattern) => pattern.test(text)));
  }

  /**
   * 判断当前 query 是否值得尝试做路径规划。
   * 只有存在已有 groups、尚未规划过，且问句呈现下钻/对象切换信号时才会进入。
   */
  shouldAttemptPlan(query = {}, prompt = '', groups = []) {
    const currentGroups = this.normalizeGroups(groups);
    if (currentGroups.length === 0) {
      return false;
    }

    if (Array.isArray(query?.pathPlanning?.plannedGroups) && query.pathPlanning.plannedGroups.length > 0) {
      return false;
    }

    const concepts = this.matchPromptConcepts(prompt);
    const targetTypes = this.collectTargetTypes(query);
    const shouldDrilldown = this.isDrilldownPrompt(prompt)
      || String(query?.pathPlanning?.followUpAction || '').trim().toLowerCase() === 'drilldown'
      || String(query?.semanticConstraints?.followUpAction || '').trim().toLowerCase() === 'drilldown';

    if (shouldDrilldown) {
      return true;
    }

    if (concepts.length > 0) {
      return true;
    }

    const currentTerminalType = currentGroups[currentGroups.length - 1]?.type || '';
    return targetTypes.some((item) => item && item !== currentTerminalType);
  }

  // 读取并规范化静态 groups tree，作为路径规划的候选空间。
  getStaticGroupsTree() {
    const rawTree = this.napmMetadataService.loadStaticGroupsTreeRaw();
    if (!Array.isArray(rawTree) || rawTree.length === 0) {
      return [];
    }

    return rawTree.map((node) => this.napmMetadataService.normalizeGroupNode(node, []));
  }

  // 根据锚点对象类型找到静态树中最相关的起始节点。
  findAnchorNodes(anchorType = '') {
    const target = this.normalizeGroupType(anchorType);
    if (!target) {
      return [];
    }

    const tree = this.getStaticGroupsTree();
    const matches = [];
    this.napmMetadataService.collectGroupNodesByType(tree, target, matches);
    return matches.sort((left, right) => this.napmMetadataService.scoreGroupNode(right) - this.napmMetadataService.scoreGroupNode(left));
  }

  /**
   * 从锚点节点向下收集候选路径记录。
   * 这里返回的是“原始路径 + 运行时路径 + 终点能力”等评分所需上下文。
   */
  collectCandidatePaths(anchorType = '', options = {}) {
    const nodes = this.findAnchorNodes(anchorType);
    if (nodes.length === 0) {
      return [];
    }

    const maxDepth = Number.isFinite(Number(options?.maxDepth)) && Number(options.maxDepth) >= 1
      ? Number(options.maxDepth)
      : 4;
    const records = [];

    nodes.forEach((node) => {
      const pathRecords = this.napmMetadataService.collectDrilldownPathRecords(node, {
        maxDepth,
        includeIntermediate: true,
        leafOnly: false
      });
      records.push(...pathRecords);
    });

    return this.napmMetadataService.dedupeDrilldownPathRecords(records);
  }

  /**
   * 判断候选路径与当前已有 groups 的对齐关系。
   * 结果会告诉后续逻辑是精确前缀、需要补中间层，还是根本不兼容。
   */
  alignCandidatePath(candidatePath = [], existingGroups = []) {
    const path = Array.isArray(candidatePath) ? candidatePath.map((item) => this.normalizeGroupType(item)).filter(Boolean) : [];
    const groups = this.normalizeGroups(existingGroups);
    if (path.length === 0) {
      return null;
    }

    if (groups.length === 0) {
      return {
        exactPrefix: false,
        exactMatch: false,
        extendsCandidate: path.length > 1,
        insertedCount: 0,
        assignments: []
      };
    }

    let cursor = 0;
    const assignments = [];

    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      let foundIndex = -1;
      for (let candidateIndex = cursor; candidateIndex < path.length; candidateIndex += 1) {
        if (path[candidateIndex] === group.type) {
          foundIndex = candidateIndex;
          break;
        }
      }

      if (foundIndex < 0) {
        return null;
      }

      if (index === 0 && foundIndex !== 0) {
        return null;
      }

      assignments.push({
        candidateIndex: foundIndex,
        group
      });
      cursor = foundIndex + 1;
    }

    const exactPrefix = assignments.every((item, index) => item.candidateIndex === index);
    const exactMatch = exactPrefix && groups.length === path.length;
    const lastAssignment = assignments[assignments.length - 1] || null;
    const extendsCandidate = Boolean(lastAssignment && lastAssignment.candidateIndex < path.length - 1);
    const insertedCount = assignments.reduce((total, item, index) => total + Math.max(0, item.candidateIndex - index), 0);

    return {
      exactPrefix,
      exactMatch,
      extendsCandidate,
      insertedCount,
      assignments
    };
  }

  // 基于候选路径和对齐结果生成最终 plannedGroups，并尽量继承已有 argument。
  buildPlannedGroups(candidatePath = [], alignment = null, existingGroups = []) {
    const groups = candidatePath.map((type) => ({
      type: this.normalizeGroupType(type),
      argument: null
    }));

    if (!alignment || !Array.isArray(alignment.assignments)) {
      return groups;
    }

    alignment.assignments.forEach((item) => {
      if (!item?.group?.argument) {
        return;
      }
      if (!groups[item.candidateIndex]) {
        return;
      }
      groups[item.candidateIndex].argument = item.group.argument;
    });

    return groups;
  }

  // 当缺少显式语义提示时，给内置默认分支一点基础加分。
  scoreDefaultBranch(anchorType = '', candidatePath = []) {
    const branches = DEFAULT_BRANCHES[this.normalizeGroupType(anchorType)] || [];
    if (branches.length === 0) {
      return 0;
    }

    const normalizedPath = candidatePath.map((item) => this.normalizeGroupType(item));
    for (let index = 0; index < branches.length; index += 1) {
      const branch = branches[index];
      const branchPath = [this.normalizeGroupType(anchorType)].concat(branch.map((item) => this.normalizeGroupType(item)));
      const matches = branchPath.every((item, branchIndex) => normalizedPath[branchIndex] === item);
      if (matches) {
        return 18 - (index * 3);
      }
    }

    return 0;
  }

  /**
   * 为单条候选路径打分。
   * 分数会综合路径修复程度、下钻意图、终点可查询性、概念命中和语义目标命中。
   */
  scoreCandidate(record = {}, context = {}) {
    const candidatePath = Array.isArray(record?.runtimePath) ? record.runtimePath.map((item) => this.normalizeGroupType(item)) : [];
    const alignment = this.alignCandidatePath(candidatePath, context.groups);
    if (!alignment) {
      return null;
    }

    const reasons = [];
    let score = 0;
    const terminalType = this.normalizeGroupType(record?.terminalRuntimeKey || candidatePath[candidatePath.length - 1] || '');

    if (alignment.exactPrefix) {
      score += 24;
      reasons.push('exact_prefix');
    } else if (alignment.insertedCount > 0) {
      score += 6;
      reasons.push('path_repair');
    }

    if (alignment.extendsCandidate) {
      score += context.shouldDrilldown ? 18 : 10;
      reasons.push(context.shouldDrilldown ? 'extends_drilldown' : 'extends_prompt_target');
    } else if (context.shouldDrilldown && !alignment.exactMatch) {
      score += 4;
      reasons.push('repair_only');
    } else if (context.shouldDrilldown && alignment.exactMatch) {
      score -= 24;
    }

    if (record?.terminalCanQuery) {
      score += 8;
      reasons.push('queryable_terminal');
    }

    context.concepts.forEach((concept) => {
      const containerHit = concept.preferredContainers.some((item) => candidatePath.includes(this.normalizeGroupType(item)));
      const terminalHit = concept.preferredTerminals.some((item) => terminalType === this.normalizeGroupType(item));
      const pathHit = concept.preferredTerminals.some((item) => candidatePath.includes(this.normalizeGroupType(item)));

      if (containerHit) {
        score += 12;
        reasons.push(`concept_container:${concept.id}`);
      }
      if (terminalHit) {
        score += 18;
        reasons.push(`concept_terminal:${concept.id}`);
      } else if (pathHit) {
        score += 10;
        reasons.push(`concept_path:${concept.id}`);
      }
    });

    context.targetTypes.forEach((item) => {
      const targetType = this.normalizeGroupType(item);
      if (!targetType) {
        return;
      }
      if (terminalType === targetType) {
        score += 22;
        reasons.push(`semantic_terminal:${targetType}`);
      } else if (candidatePath.includes(targetType)) {
        score += 10;
        reasons.push(`semantic_path:${targetType}`);
      }
    });

    if (context.concepts.length === 0) {
      const defaultBranchScore = this.scoreDefaultBranch(context.anchorType, candidatePath);
      if (defaultBranchScore > 0) {
        score += defaultBranchScore;
        reasons.push('default_branch');
      }
    }

    score -= Math.max(0, candidatePath.length - Math.max(context.groups.length, 1));

    return {
      score,
      reasons,
      alignment,
      terminalType
    };
  }

  // 生成适合外部日志和调试展示的候选路径摘要。
  buildCandidateSummary(candidate = {}) {
    return {
      path: Array.isArray(candidate.path) ? candidate.path.slice() : [],
      pathText: String(candidate.pathText || '').trim(),
      score: Number(candidate.score || 0),
      reason: Array.isArray(candidate.reasons) ? candidate.reasons.join('; ') : String(candidate.reason || '').trim() || null
    };
  }

  comparePlannedGroups(left = [], right = []) {
    const leftGroups = this.normalizeGroups(left);
    const rightGroups = this.normalizeGroups(right);
    if (leftGroups.length !== rightGroups.length) {
      return false;
    }

    return leftGroups.every((item, index) => (
      item.type === rightGroups[index].type
      && String(item.argument || '') === String(rightGroups[index].argument || '')
    ));
  }

  /**
   * 主入口：为当前 query 规划最佳 group path。
   * 如果最佳候选不明显、得分过低，或者规划后与原 groups 等价，则返回 null。
   */
  planPath(query = {}, prompt = '', options = {}) {
    const groups = this.normalizeGroups(options?.groups || query?.groups || []);
    if (groups.length === 0) {
      return null;
    }

    const anchorType = groups[0]?.type || '';
    const candidates = this.collectCandidatePaths(anchorType, {
      maxDepth: options?.maxDepth || 4
    });
    if (candidates.length === 0) {
      return null;
    }

    const concepts = this.matchPromptConcepts(prompt);
    const targetTypes = this.collectTargetTypes(query);
    const shouldDrilldown = options?.shouldDrilldown === true || this.isDrilldownPrompt(prompt);
    const currentTerminalType = groups[groups.length - 1]?.type || '';

    if (!shouldDrilldown && concepts.length === 0 && targetTypes.every((item) => item === currentTerminalType)) {
      return null;
    }

    const scoredCandidates = candidates
      .map((record) => {
        const scored = this.scoreCandidate(record, {
          anchorType,
          groups,
          concepts,
          targetTypes,
          shouldDrilldown
        });
        if (!scored) {
          return null;
        }

        return {
          path: Array.isArray(record.runtimePath) ? record.runtimePath.map((item) => this.normalizeGroupType(item)) : [],
          pathText: String(record.runtimePathText || '').trim(),
          score: scored.score,
          reasons: scored.reasons,
          alignment: scored.alignment,
          terminalCanQuery: Boolean(record.terminalCanQuery)
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        if (left.path.length !== right.path.length) {
          return left.path.length - right.path.length;
        }
        return left.pathText.localeCompare(right.pathText);
      });

    const best = scoredCandidates[0] || null;
    if (!best || best.score < 10) {
      return null;
    }

    const plannedGroups = this.buildPlannedGroups(best.path, best.alignment, groups);
    if (this.comparePlannedGroups(plannedGroups, groups)) {
      return null;
    }

    const second = scoredCandidates[1] || null;
    const lead = Math.max(0, Number(best.score || 0) - Number(second?.score || 0));
    const confidence = Math.max(0.55, Math.min(0.98, Number(((best.score + lead) / 100).toFixed(2))));

    return {
      applied: true,
      shouldApply: true,
      strategy: 'static_groups_tree',
      followUpAction: shouldDrilldown ? 'drilldown' : null,
      confidence,
      anchorType,
      matchedConcepts: concepts.map((item) => item.id),
      targetTypes,
      plannedGroups,
      selectedPath: best.path.slice(),
      selectedPathText: best.pathText,
      templateCandidates: scoredCandidates.slice(0, 5).map((item) => this.buildCandidateSummary(item)),
      reason: best.reasons.join('; ')
    };
  }
}

module.exports = new GroupPathPlannerService();
