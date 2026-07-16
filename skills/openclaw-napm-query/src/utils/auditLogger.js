/**
 * auditLogger.js
 * 
 * 审计日志工具模块
 * 
 * 提供审计日志记录功能，包括日志记录、敏感信息脱敏、URL 安全构建等工具函数。
 * 
 * 修改日期：2026-04-16
 */
const winston = require('winston');
const path = require('path');
const fs = require('fs');

// 确保日志目录存在
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// 创建审计日志传输
const auditTransport = new winston.transports.File({
  filename: path.join(logsDir, 'audit.log')
});

/**
 * 创建审计日志记录器
 * 
 * 配置包括：
 * - 日志级别：默认 info，可通过环境变量 LOG_LEVEL 覆盖
 * - 格式：时间戳 + 错误堆栈 + JSON 格式
 * - 默认元数据：channel=audit, service=napm-semantic-gateway
 * - 传输：记录到 audit.log 文件
 */
const auditLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: {
    channel: 'audit',
    service: 'napm-semantic-gateway'
  },
  transports: [auditTransport]
});

/**
 * 敏感字段集合
 * 
 * 这些字段的值在记录日志时会被脱敏处理
 */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'token',
  'authorization',
  'secret'
]);

/**
 * 截断字符串
 * 
 * @param {string} value - 要截断的字符串
 * @param {number} maxLength - 最大长度，默认 4000
 * @returns {string} - 截断后的字符串
 */
function truncateString(value, maxLength = 4000) {
  const text = String(value);
  return text.length > maxLength
    ? `${text.slice(0, maxLength)}...[truncated:${text.length - maxLength}]`
    : text;
}

/**
 * 递归脱敏值
 * 
 * 对值进行脱敏处理，包括：
 * - 敏感字段值替换为 [masked]
 * - 字符串截断
 * - 数组截断（最多 50 个元素）
 * - 对象截断（最多 80 个属性）
 * - 递归深度限制（最多 5 层）
 * 
 * @param {any} value - 要脱敏的值
 * @param {number} depth - 当前递归深度
 * @returns {any} - 脱敏后的值
 */
function sanitize(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }

  if (depth >= 5) {
    return '[max-depth]';
  }

  if (typeof value === 'string') {
    return truncateString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Error) {
    return {
      message: value.message,
      stack: value.stack
    };
  }

  if (Array.isArray(value)) {
    const sliced = value.slice(0, 50).map(item => sanitize(item, depth + 1));
    if (value.length > 50) {
      sliced.push(`[truncated:${value.length - 50}]`);
    }
    return sliced;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value).slice(0, 80);
    const normalized = {};
    entries.forEach(([key, item]) => {
      if (SENSITIVE_KEYS.has(String(key).toLowerCase())) {
        normalized[key] = '[masked]';
        return;
      }
      normalized[key] = sanitize(item, depth + 1);
    });
    if (Object.keys(value).length > 80) {
      normalized.__truncated__ = Object.keys(value).length - 80;
    }
    return normalized;
  }

  return String(value);
}

/**
 * 构建审计元数据
 * 
 * @param {object} requestContext - 请求上下文
 * @param {object} payload - 负载数据
 * @returns {object} - 审计元数据对象
 */
function buildAuditMeta(requestContext = {}, payload = {}) {
  const normalizedContext = requestContext || {};
  return {
    requestId: normalizedContext.requestId || null,
    method: normalizedContext.method || null,
    path: normalizedContext.path || null,
    feature: normalizedContext.feature || null,
    ...sanitize(payload)
  };
}

/**
 * 记录审计日志
 * 
 * @param {string} event - 事件名称
 * @param {object} payload - 负载数据
 * @param {object} requestContext - 请求上下文
 */
function logAudit(event, payload = {}, requestContext = {}) {
  auditLogger.info(event, {
    event,
    ...buildAuditMeta(requestContext, payload)
  });
}

/**
 * 脱敏敏感参数
 * 
 * 将敏感字段的值替换为 [masked]
 * 
 * @param {object} params - 参数对象
 * @returns {object} - 脱敏后的参数对象
 */
function maskSensitiveParams(params = {}) {
  const normalized = {};
  Object.entries(params || {}).forEach(([key, value]) => {
    normalized[key] = SENSITIVE_KEYS.has(String(key).toLowerCase()) ? '[masked]' : value;
  });
  return normalized;
}

/**
 * 构建有序参数条目
 * 
 * 按固定顺序排列参数，用于构建规范化的 URL 查询参数
 * 
 * @param {object} params - 参数对象
 * @returns {array} - 参数条目数组 [[key, value], ...]
 */
function buildOrderedParamEntries(params = {}) {
  const source = params && typeof params === 'object' ? params : {};
  const entries = [];
  const appended = new Set();

  const append = (key) => {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      return;
    }

    const value = source[key];
    if (value === undefined || value === null || value === '') {
      return;
    }

    entries.push([key, value]);
    appended.add(key);
  };

  append('UserName');
  append('Password');
  append('type');
  append('numGroups');

  const groupIndexes = Object.keys(source)
    .map((key) => {
      const match = String(key).match(/^group(?:Type|Argument)(\d+)$/);
      return match ? Number(match[1]) : null;
    })
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  for (const index of new Set(groupIndexes)) {
    append(`groupType${index}`);
    append(`groupArgument${index}`);
  }

  [
    'start',
    'end',
    'metrics',
    'topMetric',
    'topCount',
    'granularity',
    'showOnlyValidData',
    'json',
    'csv'
  ].forEach(append);

  Object.keys(source)
    .filter((key) => !appended.has(key))
    .sort()
    .forEach(append);

  return entries;
}

/**
 * 构建有序参数对象
 * 
 * @param {object} params - 参数对象
 * @returns {object} - 有序参数对象
 */
function buildOrderedParams(params = {}) {
  const ordered = {};
  for (const [key, value] of buildOrderedParamEntries(params)) {
    ordered[key] = value;
  }
  return ordered;
}

/**
 * 构建安全的 URL
 * 
 * 自动脱敏敏感参数并构建有序的查询字符串
 * 
 * @param {string} baseUrl - 基础 URL
 * @param {object} params - 参数对象
 * @returns {string} - 安全的 URL
 */
function buildSafeUrl(baseUrl, params = {}) {
  const url = new URL(baseUrl);
  buildOrderedParamEntries(maskSensitiveParams(params)).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

module.exports = {
  logAudit,
  sanitize,
  maskSensitiveParams,
  buildSafeUrl,
  buildOrderedParams,
  buildOrderedParamEntries
};
