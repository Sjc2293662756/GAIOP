/**
 * logger.js
 * 
 * 日志工具模块
 * 
 * 使用 winston 库创建日志记录器，支持文件和控制台输出。
 * 在非生产环境下，日志会同时输出到控制台。
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

/**
 * 创建 winston 日志记录器
 * 
 * 配置包括：
 * - 日志级别：默认 info，可通过环境变量 LOG_LEVEL 覆盖
 * - 格式：时间戳 + 错误堆栈 + JSON 格式
 * - 传输：错误日志单独记录到 error.log，所有日志记录到 combined.log
 */
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'intelligence-reports' },
  transports: [
    new winston.transports.File({ 
      filename: path.join(logsDir, 'error.log'), 
      level: 'error' 
    }),
    new winston.transports.File({ 
      filename: path.join(logsDir, 'combined.log') 
    })
  ]
});

// 非生产环境下添加控制台输出
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        let msg = `${timestamp} [${level}]: ${message}`;
        if (Object.keys(meta).length > 0) {
          const metaStr = JSON.stringify(meta, null, 2);
          msg += `\n${metaStr}`;
        }
        return msg;
      })
    )
  }));
}

module.exports = logger;
