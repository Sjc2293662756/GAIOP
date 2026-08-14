const fs = require('node:fs');
const path = require('node:path');

/**
 * ResolutionSpecService
 * 负责集中读取并分发语义查询所依赖的 resolution spec 配置。
 * 对外暴露的都是只读访问接口，内部通过缓存 + 深拷贝保证性能与数据隔离。
 */

// 基于当前服务目录回溯到技能根目录，用于统一拼接配置文件路径。
const skillRoot = path.resolve(__dirname, '..');
// Resolution Spec 是语义解析阶段的核心配置，这里固定指向版本化的 JSON 文件。
const specPath = path.join(skillRoot, 'config', 'napm-resolution-spec.v1.json');

// 进程级缓存：避免每次读取配置时都重复访问磁盘。
let cachedSpec = null;

/**
 * 对 JSON 兼容对象做深拷贝，确保调用方拿到的是副本而不是缓存原对象。
 * 这样外部即使修改返回值，也不会污染进程内缓存。
 */
function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/**
 * 加载并解析 Resolution Spec。
 * 首次调用时从磁盘读取，后续优先走缓存，同时始终返回一份独立副本。
 */
function loadResolutionSpec() {
  if (cachedSpec) {
    // 命中缓存时仍返回副本，避免调用方通过引用修改缓存内容。
    return cloneJson(cachedSpec);
  }

  // 首次加载时按 UTF-8 读取配置文件，确保与 JSON 文件编码保持一致。
  const raw = fs.readFileSync(specPath, 'utf8');
  cachedSpec = JSON.parse(raw);
  return cloneJson(cachedSpec);
}

/**
 * 按服务名读取服务级规范定义，例如 topValues、groups 等服务的约束。
 */
function getServiceSpec(serviceName = '') {
  const spec = loadResolutionSpec();
  // 统一清理输入空白，避免因为前后空格导致服务键无法命中。
  const normalized = String(serviceName || '').trim();
  return cloneJson(spec?.services?.[normalized] || null);
}

function getServiceNames() {
  const spec = loadResolutionSpec();
  return Object.keys(spec?.services || {});
}

// 读取查询契约定义，用于约束整体查询对象的结构与字段语义。
function getQueryContract() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.queryContract || null);
}

// 读取对象别名映射，用于把自然语言中的对象名称归一到标准对象类型。
function getObjectAliases() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.objects?.aliases || {});
}

// 读取服务路由规则，用于决定查询请求该如何分发到不同能力链路。
function getRoutingRules() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.routingRules || {});
}

// 读取元数据处理规则，用于约束元数据补全、筛选和校验行为。
function getMetadataRules() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.metadataRules || {});
}

// 读取服务画像配置，用于描述各服务的能力边界和输入偏好。
function getServiceProfiles() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.serviceProfiles || {});
}

// 读取对象目录，用于获取对象类型的标准定义和静态描述信息。
function getObjectCatalog() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.objects?.catalog || {});
}

// 读取对象归一化规则，用于统一对象名称、层级路径或变体写法。
function getObjectNormalizationRules() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.objects?.normalizationRules || {});
}

// 读取分组相关规范，用于约束 group path、层级和可选组合。
function getGroupSpec() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.groups || {});
}

// 读取指标相关规范，用于约束指标映射、口径和兼容性。
function getMetricSpec() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.metrics || {});
}

// 读取澄清策略配置，用于在语义信息不足时指导追问流程。
function getClarificationSpec() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.clarification || {});
}

// 读取时间语义配置，用于统一时间范围、粒度和默认值处理。
function getTimeSpec() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.time || {});
}

// 读取模板配置，用于技能运行时选择稳定模板或其他查询模板能力。
function getTemplateSpec() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.templates || {});
}

// 读取运行时元数据契约，用于约束执行阶段需要补齐的元数据字段。
function getRuntimeMetadataContracts() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.runtimeMetadataContracts || {});
}

// 读取查询构造策略，用于控制语义结果到最终请求体的组装方式。
function getQueryConstructionPolicy() {
  const spec = loadResolutionSpec();
  return cloneJson(spec?.queryConstructionPolicy || {});
}

/**
 * 获取边界模式。
 * 运行时固定 strict，兼容模式已下线，环境变量不再打开 prompt fallback。
 */
function getBoundaryMode(defaultMode = 'strict') {
  return 'strict';
}

// 判断当前是否处于严格边界模式，供外部直接进行布尔判断。
function isStrictBoundaryMode(defaultMode = 'strict') {
  return getBoundaryMode(defaultMode) === 'strict';
}

// 清空缓存，通常用于测试场景或配置文件热更新后的手动重载。
function resetCache() {
  cachedSpec = null;
}

// 统一导出只读访问接口，供语义解析、校验和执行阶段按需引用。
module.exports = {
  loadResolutionSpec,
  getServiceSpec,
  getServiceNames,
  getQueryContract,
  getObjectAliases,
  getRoutingRules,
  getMetadataRules,
  getServiceProfiles,
  getObjectCatalog,
  getObjectNormalizationRules,
  getGroupSpec,
  getMetricSpec,
  getClarificationSpec,
  getTimeSpec,
  getTemplateSpec,
  getRuntimeMetadataContracts,
  getQueryConstructionPolicy,
  getBoundaryMode,
  isStrictBoundaryMode,
  resetCache,
  specPath
};
