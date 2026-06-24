#!/usr/bin/env node
'use strict';

/**
 * run_syslog_watcher.js — NAPM Syslog 告警监听守护进程入口。
 *
 * 用法：
 *   node scripts/run_syslog_watcher.js [config.json 路径]
 *
 * 如果不提供配置文件路径，默认使用 ../config/watcher.config.json。
 *
 * 信号处理：
 *   SIGINT / SIGTERM → 优雅停止（清理 tail 子进程、输出统计信息）
 */

const path = require('path');
const fs = require('fs');
const SyslogWatcherService = require('../services/SyslogWatcherService');

// ---- 加载配置 ----

const configPathArg = process.argv[2];
const configPath = configPathArg
  ? path.resolve(configPathArg)
  : path.join(__dirname, '..', 'config', 'watcher.config.json');

if (!fs.existsSync(configPath)) {
  console.error(`[run_syslog_watcher] 配置文件不存在: ${configPath}`);
  console.error('[run_syslog_watcher] 用法: node scripts/run_syslog_watcher.js [config.json]');
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (err) {
  console.error(`[run_syslog_watcher] 配置文件解析失败: ${err.message}`);
  process.exit(1);
}

// ---- 校验必要配置 ----

// syslog 日志路径
if (!config.syslog?.path) {
  console.error('[run_syslog_watcher] 配置缺少 syslog.path');
  process.exit(1);
}

if (!fs.existsSync(config.syslog.path)) {
  console.log(`[run_syslog_watcher] Syslog 日志文件尚不存在: ${config.syslog.path}`);
  console.log('[run_syslog_watcher] 将继续运行等待 rsyslog 创建文件...（tail -F 会自动等待）');
}

// 企业微信 Webhook
if (!config.wecom?.webhookUrl || config.wecom.webhookUrl.includes('YOUR_KEY_HERE')) {
  console.error('[run_syslog_watcher] ============================================');
  console.error('[run_syslog_watcher] 请先在 watcher.config.json 中配置企业微信 Webhook URL');
  console.error('[run_syslog_watcher] 在目标企业微信群中添加机器人，获取 Webhook 地址');
  console.error('[run_syslog_watcher] 格式: https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=XXXX');
  console.error('[run_syslog_watcher] ============================================');
  process.exit(1);
}

// ---- 启动 ----

const watcher = new SyslogWatcherService(config);

// 优雅退出
let stopping = false;
const gracefulShutdown = async (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(`\n[SyslogWatcher] 收到 ${signal}，正在优雅退出...`);
  await watcher.stop();
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// 未捕获异常兜底
process.on('uncaughtException', (err) => {
  console.error('[SyslogWatcher] 未捕获异常:', err);
  // 不退出，尝试继续运行
});

process.on('unhandledRejection', (reason) => {
  console.error('[SyslogWatcher] 未处理的 Promise 拒绝:', reason);
});

watcher.start();
