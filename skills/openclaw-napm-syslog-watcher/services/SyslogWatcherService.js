'use strict';

/**
 * SyslogWatcherService — Syslog 告警监听主守护进程。
 *
 * 职责：
 *   1. 使用 tail -F 持续监听 NAPM Syslog 日志文件
 *   2. 将每一行交给 SyslogParserService 解析
 *   3. 对解析出的告警，调用 AlertEnrichmentService 补充详情
 *   4. 通过 WeComPushService 推送到企业微信群
 *   5. 内置去重：同一 alertId 在可配置的时间窗口内不重复推送
 *   6. tail 进程断开自动重连，API 调用失败自动重试
 */

const { spawn } = require('child_process');
const path = require('path');
const iconv = require('iconv-lite');
const SyslogParserService = require('./SyslogParserService');
const AlertEnrichmentService = require('./AlertEnrichmentService');
const WeComPushService = require('./WeComPushService');

class SyslogWatcherService {
  /**
   * @param {object} config - 完整配置对象（来自 watcher.config.json）
   */
  constructor(config) {
    this.config = config;

    // 子系统
    this.parser = new SyslogParserService();
    this.enrichment = new AlertEnrichmentService(config);
    this.wecom = new WeComPushService(config);

    // 去重缓存：dedupKey → 首次发现时间戳 (ms)
    this.seenAlerts = new Map();

    // 去重窗口（秒）
    // 注意：用 ?? 而非 ||，因为 windowSeconds: 0 是合法的"不去重"配置
    this.dedupWindowMs = (config.dedup?.windowSeconds ?? 300) * 1000;
    this.dedupMaxSize = config.dedup?.maxCacheSize || 500;

    // 重试
    this.maxRetries = config.watcher?.maxRetries || 3;
    this.retryDelayMs = config.watcher?.retryDelayMs ?? 5000;

    // 运行状态
    this.isRunning = false;
    this.tailProcess = null;

    // 统计
    this.stats = {
      totalLines: 0,
      parsedAlerts: 0,
      pushedAlerts: 0,
      dedupedAlerts: 0,
      failedAlerts: 0,
      startTime: null,
    };
  }

  // ---- 启动 / 停止 ----

  /**
   * 启动监听循环。
   */
  start() {
    this.isRunning = true;
    this.stats.startTime = new Date().toISOString();
    console.log('[SyslogWatcher] ========================================');
    console.log('[SyslogWatcher] 启动 NAPM Syslog 告警监听');
    console.log(`[SyslogWatcher] 日志文件: ${this.config.syslog.path}`);
    console.log(`[SyslogWatcher] 去重: ${this.dedupWindowMs === 0 ? '已关闭' : this.dedupWindowMs / 1000 + 's'}`);
    console.log('[SyslogWatcher] ========================================');

    this._startTail();

    // 发送启动通知
    this.wecom.pushText('[NAPM Syslog Watcher] 告警监听已启动').catch((err) => {
      console.error('[SyslogWatcher] 启动通知发送失败:', err.message);
    });
  }

  /**
   * 停止监听，清理资源。
   */
  async stop() {
    this.isRunning = false;

    if (this.tailProcess) {
      this.tailProcess.kill('SIGTERM');
      this.tailProcess = null;
    }

    console.log('[SyslogWatcher] ========================================');
    console.log(`[SyslogWatcher] 已停止。统计：总行=${this.stats.totalLines}, 解析=${this.stats.parsedAlerts}, 推送=${this.stats.pushedAlerts}, 去重=${this.stats.dedupedAlerts}, 失败=${this.stats.failedAlerts}`);
    console.log('[SyslogWatcher] ========================================');
  }

  // ---- 内部方法 ----

  /**
   * 启动 tail -F 子进程。
   * -F（而非 -f）：文件被 rotate/truncate 后自动重新打开。
   * -n 0：只读取新行，不输出历史存量。
   */
  _startTail() {
    const logPath = this.config.syslog.path;

    this.tailProcess = spawn('tail', ['-F', '-n', '0', logPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    console.log(`[SyslogWatcher] tail 进程已启动, pid=${this.tailProcess.pid}`);

    // ---- stdout：逐行解析（带编码自适应） ----
    // NAPM 发出的 Syslog 可能是 GBK 编码（中国厂商常见），
    // 也可能是 UTF-8。这里用 iconv-lite 做智能检测：
    //   1. 先尝试 UTF-8 解码
    //   2. 如果含 Unicode 替换字符 (U+FFFD)，则回退到 GBK
    let buffer = Buffer.alloc(0);
    this.tailProcess.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // 找最后一个换行符，切割完整行 + 保留不完整尾部
      let newlineIdx = -1;
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i] === 0x0a) { newlineIdx = i; break; }
      }

      if (newlineIdx === -1) return; // 还没有完整行

      const complete = buffer.subarray(0, newlineIdx);
      buffer = buffer.subarray(newlineIdx + 1);

      const text = this._decodeBuffer(complete);
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          this.stats.totalLines++;
          this._handleLine(line.trim());
        }
      }
    });

    // ---- stderr：仅记录 ----
    this.tailProcess.stderr.on('data', (data) => {
      console.error('[SyslogWatcher] tail stderr:', data.toString().trim());
    });

    // ---- 进程退出处理 ----
    this.tailProcess.on('close', (code, signal) => {
      console.log(`[SyslogWatcher] tail 进程退出 code=${code} signal=${signal}`);
      if (this.isRunning) {
        const reconnectDelay = 5000;
        console.log(`[SyslogWatcher] ${reconnectDelay / 1000}s 后自动重连...`);
        setTimeout(() => {
          if (this.isRunning) this._startTail();
        }, reconnectDelay);
      }
    });

    this.tailProcess.on('error', (err) => {
      console.error('[SyslogWatcher] tail 启动失败:', err.message);
      if (this.isRunning) {
        setTimeout(() => {
          if (this.isRunning) this._startTail();
        }, 5000);
      }
    });
  }

  /**
   * 处理一行 Syslog 文本。
   * @param {string} line - 单行原始 Syslog 文本
   */
  async _handleLine(line) {
    // 1. 解析
    const alert = this.parser.parse(line);
    if (!alert) return; // 非 NAPM 告警行，静默跳过

    // 若指标值为 N/D，表示告警已恢复/结束，跳过不推送
    if (alert.metrics && alert.metrics.length > 0 && alert.metrics.every(m => m.value === 'N/D')) {
      console.log(
        `[SyslogWatcher] 跳过已恢复告警: name="${alert.alertName}" id=${alert.alertId} (指标值均为 N/D)`
      );
      return;
    }

    this.stats.parsedAlerts++;
    console.log(
      `[SyslogWatcher] 发现告警: name="${alert.alertName}" id=${alert.alertId} severity=${alert.alertSeverity} category=${alert.category}`
    );

    // 2. 去重
    const dedupKey = `${alert.category}_${alert.alertId}`;
    const now = Date.now();
    const lastSeen = this.seenAlerts.get(dedupKey);
    if (lastSeen && (now - lastSeen) < this.dedupWindowMs) {
      this.stats.dedupedAlerts++;
      console.log(`[SyslogWatcher] 去重跳过: ${dedupKey} (上次 ${Math.round((now - lastSeen) / 1000)}s 前)`);
      return;
    }
    this.seenAlerts.set(dedupKey, now);

    // 清理过期缓存条目
    this._pruneSeenCache(now);

    // 3. 补充详情（带重试）
    let retries = 0;
    while (retries < this.maxRetries) {
      try {
        alert.detail = await this.enrichment.getAlertDetail({
          alertId: alert.alertId,
          elogid: alert.extra?.elogid,
          alertTimestamp: alert.timestamp,
          starttime: alert.extra?.starttime ? parseInt(alert.extra.starttime, 10) : undefined,
          endtime: alert.extra?.endtime ? parseInt(alert.extra.endtime, 10) : undefined,
        });
        break;
      } catch (_err) {
        retries++;
        if (retries < this.maxRetries) {
          console.log(`[SyslogWatcher] 获取详情重试 ${retries}/${this.maxRetries}...`);
          await this._sleep(this.retryDelayMs);
        }
      }
    }

    // 4. 推送到企业微信
    const pushed = await this.wecom.pushAlert(alert);
    if (pushed) {
      this.stats.pushedAlerts++;
      console.log(`[SyslogWatcher] 已推送企业微信: ${alert.alertName}`);
    } else {
      this.stats.failedAlerts++;
      console.error(`[SyslogWatcher] 推送失败: ${alert.alertName}`);
    }
  }

  /**
   * 清理过期的去重缓存条目。
   */
  _pruneSeenCache(now) {
    if (this.seenAlerts.size <= this.dedupMaxSize) return;

    const cutoff = now - this.dedupWindowMs * 2;
    const toDelete = [];
    for (const [key, ts] of this.seenAlerts) {
      if (ts < cutoff) toDelete.push(key);
    }
    for (const key of toDelete) {
      this.seenAlerts.delete(key);
    }
    if (toDelete.length > 0) {
      console.log(`[SyslogWatcher] 清理去重缓存: ${toDelete.length} 条`);
    }
  }

  /**
   * 编码自适应解码：先 UTF-8，含乱码 (U+FFFD) 则回退 GBK。
   * NAPM 是中国厂商产品，Syslog 可能输出 GBK 编码。
   */
  _decodeBuffer(buf) {
    const utf8 = buf.toString('utf-8');
    if (!utf8.includes('�')) return utf8;
    console.log('[SyslogWatcher] UTF-8 解码含乱码，回退 GBK');
    return iconv.decode(buf, 'gbk');
  }

  /**
   * 异步 sleep。
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = SyslogWatcherService;
