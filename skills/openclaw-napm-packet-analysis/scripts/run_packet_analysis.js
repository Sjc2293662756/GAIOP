#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { URL } = require('url');
const https = require('https');
const http = require('http');

const DEFAULT_MODE = 'build_url_only';
const DOWNLOAD_MODES = new Set(['download_only', 'preview_download', 'download_analyze', 'preview_download_analyze']);
const PREVIEW_MODES = new Set(['preview_only', 'preview_download', 'preview_download_analyze']);
const ANALYZE_MODES = new Set(['analyze_file', 'download_analyze', 'preview_download_analyze']);

main().catch((error) => {
  const result = failureResult('PACKET_RUNTIME_ERROR', error.message || String(error), { stack: error.stack });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 1;
});

async function main() {
  loadDotEnv(path.resolve(process.cwd(), '.env'));
  const args = parseArgs(process.argv.slice(2));
  const query = loadQuery(args);
  const startedAt = new Date().toISOString();

  const resolved = resolveQuery(query);
  if (!resolved.ok) {
    writeJson({
      ok: false,
      mode: query.mode || DEFAULT_MODE,
      error: resolved.error,
      decision: { next_action: 'CLARIFICATION_REQUIRED' },
      summary: {
        title: '数据包任务缺少必要条件',
        highlights: [resolved.error.message],
      },
    });
    return;
  }

  const task = resolved.task;
  const result = {
    ok: true,
    mode: task.mode,
    downloadType: task.downloadType,
    startedAt,
    criteria: task.criteria,
    urls: publicUrls(task.urls),
    explanation: null,
    preview: null,
    download: null,
    analysis: null,
    error: null,
    decision: null,
  };

  if (task.mode === 'explain_url') {
    result.explanation = explainUrl(task.url);
    result.summary = buildSummary(result);
    result.narrationInput = buildNarrationInput(result);
    writeJson(result);
    return;
  }

  if (task.mode === 'build_url_only') {
    result.summary = buildSummary(result);
    result.narrationInput = buildNarrationInput(result);
    writeJson(result);
    return;
  }

  if (PREVIEW_MODES.has(task.mode)) {
    result.preview = await requestPreview(task);
    if (!result.preview.ok || result.preview.empty) {
      result.ok = false;
      result.error = result.preview.error || {
        code: 'PACKET_PREVIEW_EMPTY',
        message: 'packetsPreview 未返回可下载数据。',
      };
      result.decision = {
        next_action: 'NO_DOWNLOAD',
        reason: result.error.code,
        message: '预览接口没有发现可下载数据包，因此没有发起下载请求。',
      };
      result.summary = buildSummary(result);
      result.narrationInput = buildNarrationInput(result);
      writeJson(result);
      return;
    }
  }

  if (DOWNLOAD_MODES.has(task.mode)) {
    if (shouldPreviewBeforeDownload(task) && !result.preview) {
      result.preview = await requestPreview(task);
      if (!result.preview.ok || result.preview.empty) {
        result.ok = false;
        result.error = result.preview.error || {
          code: 'PACKET_PREVIEW_EMPTY',
          message: 'packetsPreview 未返回可下载数据。',
        };
        result.decision = {
          next_action: 'NO_DOWNLOAD',
          reason: result.error.code,
          message: '预览接口没有发现可下载数据包，因此没有发起下载请求。',
        };
        result.summary = buildSummary(result);
        result.narrationInput = buildNarrationInput(result);
        writeJson(result);
        return;
      }
    }

    result.download = await downloadPacket(task);
    if (!result.download.ok) {
      result.ok = false;
      result.error = result.download.error;
      result.summary = buildSummary(result);
      result.narrationInput = buildNarrationInput(result);
      writeJson(result);
      return;
    }
  }

  if (ANALYZE_MODES.has(task.mode)) {
    const filePath = task.mode === 'analyze_file' ? task.file : result.download && result.download.filePath;
    if (!filePath) {
      result.ok = false;
      result.error = {
        code: 'PACKET_FILE_REQUIRED',
        message: '分析模式需要本地 packet 文件路径，或先完成下载。',
      };
    } else {
      result.analysis = await analyzePacketFile(filePath, task.analysis);
      if (!result.analysis.ok) {
        result.ok = false;
        result.error = result.analysis.error;
      }
      if (result.download && result.download.artifactDir) {
        await writeArtifactJson(result.download.artifactDir, 'analysis.json', result.analysis);
      }
      await removeDownloadedFileAfterAnalysisIfNeeded(result, task);
    }
  }

  result.summary = buildSummary(result);
  result.narrationInput = buildNarrationInput(result);
  writeJson(result);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--queryFile') args.queryFile = argv[++index];
    else if (arg === '--queryJson') args.queryJson = argv[++index];
    else if (arg === '--url') args.url = argv[++index];
    else if (arg === '--file') args.file = argv[++index];
    else if (arg === '--mode') args.mode = argv[++index];
    else if (arg === '--showFullUrls') args.showFullUrls = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'Usage:',
        '  node scripts/run_packet_analysis.js --queryFile ./query.json',
        '  node scripts/run_packet_analysis.js --queryJson "{...}"',
        '  node scripts/run_packet_analysis.js --mode explain_url --url "https://..."',
        '  node scripts/run_packet_analysis.js --mode analyze_file --file ./capture.pcap',
      ].join('\n') + '\n');
      process.exit(0);
    }
  }
  return args;
}

function loadQuery(args) {
  let query = {};
  if (args.queryFile) {
    query = JSON.parse(stripBom(fs.readFileSync(args.queryFile, 'utf8')));
  } else if (args.queryJson) {
    query = JSON.parse(stripBom(args.queryJson));
  }

  if (args.mode) query.mode = args.mode;
  if (args.url) query.url = args.url;
  if (args.file) query.file = args.file;
  if (args.showFullUrls) query.showFullUrls = true;

  return query;
}

function resolveQuery(query) {
  const mode = query.mode || DEFAULT_MODE;
  if (![
    'build_url_only',
    'explain_url',
    'preview_only',
    'download_only',
    'preview_download',
    'analyze_file',
    'download_analyze',
    'preview_download_analyze',
  ].includes(mode)) {
    return failResolve('PACKET_MODE_UNSUPPORTED', `不支持的数据包任务模式：${mode}`);
  }

  const showFullUrls = Boolean(query.showFullUrls || envBool('SHOW_PACKET_FULL_URLS', false));

  if (mode === 'explain_url') {
    if (!query.url) return failResolve('PACKET_URL_REQUIRED', 'explain_url 模式需要 url。');
    return {
      ok: true,
      task: {
        mode,
        url: query.url,
        downloadType: detectDownloadTypeFromUrl(query.url),
        criteria: {},
        urls: { input: showFullUrls ? query.url : maskUrl(query.url) },
      },
    };
  }

  if (mode === 'analyze_file') {
    if (!query.file) return failResolve('PACKET_FILE_REQUIRED', 'analyze_file 模式需要 file。');
    return {
      ok: true,
      task: {
        mode,
        file: path.resolve(query.file),
        downloadType: 'localFile',
        criteria: {},
        urls: {},
        analysis: normalizeAnalysisOptions(query.analysis),
      },
    };
  }

  const criteria = normalizeCriteria(query.criteria || query);
  const validation = validateCriteria(criteria, mode);
  if (!validation.ok) return validation;

  const downloadType = query.downloadType || criteria.downloadType || 'packetsDown';
  const host = normalizeHost(query.host || criteria.host || process.env.NETINSIDE_HOST);
  if (!host) {
    return failResolve('NETINSIDE_HOST_REQUIRED', '需要 NETINSIDE_HOST，或在 query.host / criteria.host 中提供 NetInside 地址。');
  }

  const urls = buildUrls({ host, criteria, downloadType, showFullUrls });
  return {
    ok: true,
    task: {
      mode,
      downloadType,
      criteria,
      host,
      urls,
      showFullUrls,
      analysis: normalizeAnalysisOptions(query.analysis),
      filePolicy: normalizeFilePolicy(query.filePolicy),
      forceDownload: Boolean(query.forceDownload || criteria.forceDownload),
    },
  };
}

function normalizeCriteria(input) {
  const criteria = { ...input };
  delete criteria.UserName;
  delete criteria.userName;
  delete criteria.username;
  delete criteria.Password;
  delete criteria.password;
  delete criteria.passwd;
  if (criteria.iprangs && !criteria.ipRanges) criteria.ipRanges = criteria.iprangs;
  criteria.ips = toArray(criteria.ips).filter(Boolean);
  criteria.ipRanges = toArray(criteria.ipRanges).filter(Boolean);
  if (criteria.id != null) criteria.id = String(criteria.id);
  if (criteria.top != null) criteria.top = Number(criteria.top);
  if (criteria.start != null) criteria.start = normalizeTimestamp(criteria.start);
  if (criteria.end != null) criteria.end = normalizeTimestamp(criteria.end);

  if (criteria.instanceId && !String(criteria.instanceId).startsWith('PATH1/')) {
    criteria.instanceId = normalizeInstanceId(criteria.instanceId);
  }
  if (!criteria.instanceId && criteria.resultName) criteria.instanceId = normalizeInstanceId(criteria.resultName);
  return criteria;
}

function validateCriteria(criteria, mode) {
  if (mode === 'build_url_only' || PREVIEW_MODES.has(mode) || DOWNLOAD_MODES.has(mode)) {
    if (!criteria.start || !criteria.end) {
      return failResolve('PACKET_TIME_RANGE_REQUIRED', '需要 start 和 end 秒级时间戳。');
    }
    if (criteria.end <= criteria.start) {
      return failResolve('PACKET_TIME_RANGE_INVALID', 'end 必须大于 start。');
    }
    const maxRange = Number(process.env.PACKET_MAX_TIME_RANGE_SECONDS || 3600);
    if (maxRange > 0 && criteria.end - criteria.start > maxRange) {
      return failResolve('PACKET_TIME_RANGE_TOO_LARGE', `时间范围超过限制：${maxRange} 秒。`);
    }
    const hasPacketCondition = criteria.ips.length || criteria.ipRanges.length || criteria.id || Number.isFinite(criteria.top);
    const hasDownServletCondition = criteria.instanceId;
    if (!hasPacketCondition && !hasDownServletCondition) {
      return failResolve('PACKET_QUERY_REQUIRED', '需要 ips、ipRanges、id、top 或 instanceId 之一。');
    }
  }
  return { ok: true };
}

function buildUrls({ host, criteria, downloadType, showFullUrls }) {
  if (downloadType === 'DownServlet' || criteria.instanceId) {
    const url = new URL('/webservice/DownServlet', host);
    appendRuntimeAuthQueryParams(url);
    url.searchParams.set('moduleKey', criteria.moduleKey || 'Ipv');
    url.searchParams.set('groupId', String(criteria.groupId || 45));
    if (criteria.rtClickId) url.searchParams.set('rtClickId', String(criteria.rtClickId));
    else if (criteria.downloadId) url.searchParams.set('rtClickId', String(criteria.downloadId));
    url.searchParams.set('start', String(criteria.start));
    url.searchParams.set('end', String(criteria.end));
    url.searchParams.set('instanceId', normalizeInstanceId(criteria.instanceId || criteria.resultName));
    return {
      download: publicPacketUrl(url.toString(), showFullUrls),
      downloadRaw: url.toString(),
    };
  }

  const preview = buildNetInsideUrl(host, 'packetsPreview', criteria);
  const download = buildNetInsideUrl(host, 'packetsDown', criteria);
  return {
    preview: publicPacketUrl(preview, showFullUrls),
    download: publicPacketUrl(download, showFullUrls),
    previewRaw: preview,
    downloadRaw: download,
  };
}

function publicUrls(urls) {
  const publicCopy = {};
  for (const [key, value] of Object.entries(urls || {})) {
    if (key.endsWith('Raw')) continue;
    publicCopy[key] = value;
  }
  return publicCopy;
}

function buildNetInsideUrl(host, type, criteria) {
  const url = new URL('/webservice/NetInside', host);
  appendRuntimeAuthQueryParams(url);
  url.searchParams.set('type', type);
  for (const ip of criteria.ips || []) url.searchParams.append('ips', ip);
  for (const range of criteria.ipRanges || []) url.searchParams.append('ipRanges', range);
  if (criteria.id) url.searchParams.set('id', criteria.id);
  if (Number.isFinite(criteria.top)) url.searchParams.set('top', String(criteria.top));
  url.searchParams.set('start', String(criteria.start));
  url.searchParams.set('end', String(criteria.end));
  url.searchParams.set('json', 'true');
  return url.toString();
}

function appendRuntimeAuthQueryParams(url) {
  if (!envBool('PACKET_AUTH_QUERY_PARAMS', true)) return;
  if (process.env.NETINSIDE_USERNAME && !url.searchParams.has('UserName')) {
    url.searchParams.set('UserName', process.env.NETINSIDE_USERNAME);
  }
  if (process.env.NETINSIDE_PASSWORD && !url.searchParams.has('Password')) {
    url.searchParams.set('Password', process.env.NETINSIDE_PASSWORD);
  }
}

function publicPacketUrl(inputUrl, showFullUrls) {
  const url = new URL(inputUrl);
  if (url.searchParams.has('Password')) {
    url.searchParams.set('Password', '***');
  }
  for (const key of Array.from(url.searchParams.keys())) {
    if (isSensitiveParam(key) && key !== 'Password') {
      url.searchParams.set(key, '***');
    }
  }
  if (!showFullUrls && url.searchParams.has('UserName')) {
    const username = url.searchParams.get('UserName');
    url.searchParams.set('UserName', username || '***');
  }
  return url.toString();
}

async function requestPreview(task) {
  if (!task.urls.previewRaw) {
    return {
      ok: false,
      error: {
        code: 'PACKET_PREVIEW_UNSUPPORTED',
        message: 'DownServlet 当前不支持 packetsPreview。',
      },
    };
  }

  try {
    const response = await httpRequest(task.urls.previewRaw, { responseType: 'text' });
    const text = response.body.toString('utf8').trim();
    const parsed = parseMaybeJson(text);
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      statusCode: response.statusCode,
      empty: isEmptyPreview(parsed, text),
      contentType: response.headers['content-type'] || null,
      bytes: Buffer.byteLength(response.body),
      data: parsed,
      textSample: typeof parsed === 'string' ? parsed.slice(0, 500) : undefined,
      urlMasked: task.urls.preview,
      error: response.statusCode >= 200 && response.statusCode < 300 ? null : {
        code: 'PACKET_PREVIEW_FAILED',
        message: `packetsPreview HTTP 状态码 ${response.statusCode}。`,
      },
    };
  } catch (error) {
    return {
      ok: false,
      empty: true,
      error: {
        code: 'PACKET_PREVIEW_FAILED',
        message: error.message,
      },
      urlMasked: task.urls.preview,
    };
  }
}

async function downloadPacket(task) {
  const downloadUrl = task.urls.downloadRaw;
  await cleanupExpiredArtifacts(task.filePolicy.downloadDir, task.filePolicy.retentionHours);
  const artifactDir = await createArtifactDir(task.filePolicy.downloadDir);
  const maxBytes = task.filePolicy.maxBytes;
  const metaPath = path.join(artifactDir, 'download.meta.json');

  try {
    const response = await httpRequest(downloadUrl, { responseType: 'stream', maxBytes });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        ok: false,
        error: {
          code: 'PACKET_DOWNLOAD_FAILED',
          message: `下载接口 HTTP 状态码 ${response.statusCode}。`,
        },
        statusCode: response.statusCode,
        urlMasked: task.urls.download,
      };
    }

    const fileName = chooseFileName(response.headers, downloadUrl);
    const filePath = path.join(artifactDir, fileName);
    await fsp.writeFile(filePath, response.body);
    const meta = {
      urlMasked: task.urls.download,
      statusCode: response.statusCode,
      contentType: response.headers['content-type'] || null,
      contentDisposition: response.headers['content-disposition'] || null,
      fileName,
      filePath,
      bytes: response.body.length,
      downloadedAt: new Date().toISOString(),
      retentionHours: task.filePolicy.retentionHours,
      expiresAt: retentionExpiry(task.filePolicy.retentionHours),
    };
    await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));
    return { ok: true, ...meta, artifactDir };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error.code === 'PACKET_FILE_TOO_LARGE' ? error.code : 'PACKET_DOWNLOAD_FAILED',
        message: error.message,
      },
      urlMasked: task.urls.download,
      artifactDir,
    };
  }
}

function shouldPreviewBeforeDownload(task) {
  if (task.forceDownload) return false;
  if (!task.filePolicy.requirePreviewBeforeDownload) return false;
  if (!task.urls.previewRaw) return false;
  return true;
}

async function analyzePacketFile(filePath, analysisOptions) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    return {
      ok: false,
      error: {
        code: 'PACKET_FILE_NOT_FOUND',
        message: `文件不存在：${resolvedPath}`,
      },
    };
  }

  const timeoutMs = analysisOptions.timeoutMs;
  const result = {
    ok: true,
    filePath: resolvedPath,
    fileName: path.basename(resolvedPath),
    capinfos: null,
    protocolHierarchy: null,
    endpoints: null,
    conversations: null,
    dnsQueries: [],
    httpRows: [],
    tlsSni: [],
    error: null,
  };

  const capinfosBin = process.env.PACKET_CAPINFOS_BIN || 'capinfos';
  const tsharkBin = process.env.PACKET_TSHARK_BIN || 'tshark';

  const capinfos = await runCommand(capinfosBin, [resolvedPath], { timeoutMs });
  if (capinfos.ok) {
    result.capinfos = parseCapinfos(capinfos.stdout);
  } else {
    result.capinfos = { raw: capinfos.stderr || capinfos.stdout || '', error: capinfos.error };
  }

  const protocol = await runCommand(tsharkBin, ['-r', resolvedPath, '-q', '-z', 'io,phs'], { timeoutMs });
  if (protocol.ok) result.protocolHierarchy = parseSectionLines(protocol.stdout);
  else return analysisFailure('PACKET_TSHARK_FAILED', protocol.error || protocol.stderr || 'tshark 协议分布分析失败。', result);

  const endpoints = await runCommand(tsharkBin, ['-r', resolvedPath, '-q', '-z', 'endpoints,ip'], { timeoutMs });
  if (endpoints.ok) result.endpoints = parseSectionLines(endpoints.stdout);

  const conversations = await runCommand(tsharkBin, ['-r', resolvedPath, '-q', '-z', 'conv,ip'], { timeoutMs });
  if (conversations.ok) result.conversations = parseSectionLines(conversations.stdout);

  if (analysisOptions.includeDns) {
    const dns = await runCommand(tsharkBin, ['-r', resolvedPath, '-Y', 'dns.qry.name', '-T', 'fields', '-e', 'dns.qry.name'], { timeoutMs });
    if (dns.ok) result.dnsQueries = topValues(dns.stdout.split(/\r?\n/).filter(Boolean), 20);
  }

  if (analysisOptions.includeHttp) {
    const httpRows = await runCommand(tsharkBin, ['-r', resolvedPath, '-Y', 'http', '-T', 'fields', '-E', 'separator=|', '-e', 'http.host', '-e', 'http.request.uri', '-e', 'http.response.code'], { timeoutMs });
    if (httpRows.ok) result.httpRows = httpRows.stdout.split(/\r?\n/).filter(Boolean).slice(0, 50);
  }

  if (analysisOptions.includeTls) {
    const tls = await runCommand(tsharkBin, ['-r', resolvedPath, '-Y', 'tls.handshake.extensions_server_name', '-T', 'fields', '-e', 'tls.handshake.extensions_server_name'], { timeoutMs });
    if (tls.ok) result.tlsSni = topValues(tls.stdout.split(/\r?\n/).filter(Boolean), 20);
  }

  return result;
}

function analysisFailure(code, message, partial) {
  return {
    ...partial,
    ok: false,
    error: { code, message },
  };
}

function runCommand(command, args, { timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr,
        error: `${command} 执行超时。`,
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr,
        error: error.code === 'ENOENT' ? `${command} 未找到。` : error.message,
      });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
        error: code === 0 ? null : `${command} 退出码 ${code}。`,
      });
    });
  });
}

function explainUrl(inputUrl) {
  const url = new URL(inputUrl);
  const params = sanitizeParams(Object.fromEntries(url.searchParams.entries()));
  const type = detectDownloadTypeFromUrl(inputUrl);
  const explanation = {
    type,
    host: url.host,
    path: url.pathname,
    params,
    meaning: '',
    warnings: [],
  };

  if (type === 'packetsDown' || type === 'packetsPreview') {
    explanation.meaning = type === 'packetsDown'
      ? '通过 NetInside packetsDown 按 IP、IP 段、事件 ID 或 Top 条件下载数据包。'
      : '通过 NetInside packetsPreview 查询指定条件下是否存在可下载数据包。';
    if (params.iprangs && !params.ipRanges) explanation.warnings.push('URL 使用页面参数 iprangs；直接调接口时应使用 ipRanges。');
    if (hasAuthQueryParams(url.searchParams)) explanation.warnings.push('URL 中包含认证参数；运行时应改用 .env 中的 NETINSIDE_USERNAME/NETINSIDE_PASSWORD 或 NETINSIDE_COOKIE，不要在最终答复中展示账号密码。');
    if (!params.start || !params.end) explanation.warnings.push('缺少 start/end 时间范围。');
    if (!params.ips && !params.ipRanges && !params.id && !params.top) explanation.warnings.push('缺少 ips/ipRanges/id/top 下载条件。');
  } else if (type === 'DownServlet') {
    explanation.meaning = '通过 DownServlet 下载右键菜单或表格对象上下文中的数据包。';
    if (!params.instanceId) explanation.warnings.push('缺少 instanceId，无法定位具体下载对象。');
    if (!params.rtClickId) explanation.warnings.push('缺少 rtClickId，可能需要先调用 downloadId 接口。');
    if (hasAuthQueryParams(url.searchParams)) explanation.warnings.push('URL 中包含认证参数；运行时应改用 .env 中的 NETINSIDE_USERNAME/NETINSIDE_PASSWORD 或 NETINSIDE_COOKIE，不要在最终答复中展示账号密码。');
  } else {
    explanation.meaning = '无法识别为已知 NAPM 数据包下载 URL。';
  }

  return explanation;
}

function sanitizeParams(params) {
  const sanitized = {};
  for (const [key, value] of Object.entries(params || {})) {
    sanitized[key] = isSensitiveParam(key) || isUsernameParam(key) ? '***' : value;
  }
  return sanitized;
}

function hasAuthQueryParams(searchParams) {
  for (const key of searchParams.keys()) {
    if (isSensitiveParam(key) || isUsernameParam(key)) return true;
  }
  return false;
}

function isSensitiveParam(key) {
  return /password|passwd|pwd|token|cookie|session|credential|secret|key/i.test(key);
}

function isUsernameParam(key) {
  return /^user(name)?$/i.test(key) || /^login(name)?$/i.test(key);
}

function httpRequest(inputUrl, options = {}) {
  const url = new URL(inputUrl);
  const client = url.protocol === 'http:' ? http : https;
  const timeoutMs = Number(process.env.PACKET_HTTP_TIMEOUT_MS || 60000);
  const maxBytes = Number(options.maxBytes || process.env.PACKET_MAX_BYTES || 524288000);
  const headers = {};
  if (process.env.NETINSIDE_USERNAME && process.env.NETINSIDE_PASSWORD) {
    headers.Authorization = `Basic ${Buffer.from(`${process.env.NETINSIDE_USERNAME}:${process.env.NETINSIDE_PASSWORD}`).toString('base64')}`;
  }
  if (process.env.NETINSIDE_COOKIE) headers.Cookie = process.env.NETINSIDE_COOKIE;

  const requestOptions = {
    method: 'GET',
    headers,
    timeout: timeoutMs,
  };
  if (url.protocol === 'https:' && envBool('NETINSIDE_TLS_REJECT_UNAUTHORIZED', true) === false) {
    requestOptions.agent = new https.Agent({ rejectUnauthorized: false });
  }

  return new Promise((resolve, reject) => {
    const req = client.request(url, requestOptions, (res) => {
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy(Object.assign(new Error(`下载内容超过大小限制：${maxBytes} bytes。`), { code: 'PACKET_FILE_TOO_LARGE' }));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('HTTP 请求超时。')));
    req.on('error', reject);
    req.end();
  });
}

function parseCapinfos(output) {
  const info = { raw: output };
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    info[key] = match[2].trim();
  }
  return info;
}

function parseSectionLines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(0, 200);
}

function topValues(values, limit) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

async function createArtifactDir(downloadDir) {
  const baseDir = path.resolve(downloadDir || defaultDownloadDir());
  const runId = `${compactTimestamp(new Date())}-${Math.random().toString(16).slice(2, 8)}`;
  const dir = path.join(baseDir, runId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, '.packet-artifact'), JSON.stringify({
    schema: 'openclaw_napm_packet_artifact.v1',
    createdAt: new Date().toISOString(),
  }, null, 2));
  return dir;
}

async function cleanupExpiredArtifacts(downloadDir, retentionHours) {
  if (!Number.isFinite(retentionHours) || retentionHours <= 0) return;
  const baseDir = path.resolve(downloadDir || defaultDownloadDir());
  if (!fs.existsSync(baseDir)) return;
  const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
  const entries = await fsp.readdir(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(baseDir, entry.name);
    const marker = path.join(candidate, '.packet-artifact');
    if (!fs.existsSync(marker)) continue;
    const stat = await fsp.stat(candidate);
    if (stat.mtimeMs < cutoff) {
      await fsp.rm(candidate, { recursive: true, force: true });
    }
  }
}

async function writeArtifactJson(artifactDir, fileName, value) {
  try {
    await fsp.writeFile(path.join(artifactDir, fileName), JSON.stringify(value, null, 2));
  } catch {
    // Best-effort artifact write; do not fail the user-facing packet task.
  }
}

async function removeDownloadedFileAfterAnalysisIfNeeded(result, task) {
  if (!result.download || !result.download.filePath) return;
  if (task.filePolicy.keepFiles) return;
  if (!['download_analyze', 'preview_download_analyze'].includes(task.mode)) return;
  try {
    await fsp.rm(result.download.filePath, { force: true });
    result.download.fileRemovedAfterAnalysis = true;
    result.download.filePathBeforeRemoval = result.download.filePath;
    result.download.filePath = null;
    if (result.analysis) {
      result.analysis.fileRemovedAfterAnalysis = true;
      result.analysis.filePathBeforeRemoval = result.analysis.filePath;
      result.analysis.filePath = null;
    }
  } catch (error) {
    result.download.fileRemovalError = error.message;
  }
}

function chooseFileName(headers, downloadUrl) {
  const disposition = headers['content-disposition'];
  if (disposition) {
    const encodedMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (encodedMatch) return sanitizeFileName(decodeURIComponent(encodedMatch[1]));
    const match = disposition.match(/filename="?([^";]+)"?/i);
    if (match) return sanitizeFileName(match[1]);
  }
  const url = new URL(downloadUrl);
  const type = url.pathname.includes('DownServlet') ? 'downservlet' : url.searchParams.get('type') || 'packets';
  return `${type}-${compactTimestamp(new Date())}.pcap`;
}

function sanitizeFileName(fileName) {
  return path.basename(fileName).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') || `capture-${compactTimestamp(new Date())}.pcap`;
}

function buildSummary(result) {
  const highlights = [];
  if (result.urls && result.urls.preview) highlights.push(`预览 URL 已生成：${result.urls.preview}`);
  if (result.urls && result.urls.download) highlights.push(`下载 URL 已生成：${result.urls.download}`);
  if (result.explanation) highlights.push(result.explanation.meaning);
  if (result.preview) highlights.push(result.preview.empty ? '预览结果为空。' : '预览接口返回了数据。');
  if (result.download && result.download.ok) highlights.push(`下载完成：${result.download.fileName}，${result.download.bytes} bytes。`);
  if (result.analysis && result.analysis.ok) {
    const packetCount = result.analysis.capinfos && (result.analysis.capinfos.number_of_packets || result.analysis.capinfos.packet_count);
    highlights.push(packetCount ? `tshark/capinfos 分析完成，包数：${packetCount}。` : 'tshark/capinfos 分析完成。');
  }
  if (result.error) highlights.push(result.error.message);
  return {
    title: result.ok ? '数据包任务完成' : '数据包任务失败',
    highlights,
  };
}

function buildNarrationInput(result) {
  return {
    schema: 'openclaw_napm_packet_analysis.v1',
    language: 'zh-CN',
    mode: result.mode,
    ok: result.ok,
    criteria: result.criteria,
    urls: result.urls,
    preview: summarizePreview(result.preview),
    download: result.download ? {
      ok: result.download.ok,
      fileName: result.download.fileName,
      filePath: result.download.filePath,
      bytes: result.download.bytes,
      contentType: result.download.contentType,
      urlMasked: result.download.urlMasked,
    } : null,
    analysis: result.analysis ? summarizeAnalysis(result.analysis) : null,
    error: result.error,
    decision: result.decision,
    summary: result.summary,
    renderPolicy: {
      target: 'final_user_reply',
      language: 'zh-CN',
      includeRawPackets: false,
      includeSensitiveUrls: false,
    },
  };
}

function summarizePreview(preview) {
  if (!preview) return null;
  return {
    ok: preview.ok,
    empty: preview.empty,
    statusCode: preview.statusCode,
    contentType: preview.contentType,
    bytes: preview.bytes,
    urlMasked: preview.urlMasked,
    error: preview.error,
  };
}

function summarizeAnalysis(analysis) {
  if (!analysis) return null;
  return {
    ok: analysis.ok,
    fileName: analysis.fileName,
    capinfos: analysis.capinfos,
    protocolHierarchy: analysis.protocolHierarchy,
    endpoints: analysis.endpoints,
    conversations: analysis.conversations,
    dnsQueries: analysis.dnsQueries,
    httpRows: analysis.httpRows,
    tlsSni: analysis.tlsSni,
    error: analysis.error,
  };
}

function parseMaybeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isEmptyPreview(parsed, text) {
  if (parsed == null) return true;
  if (typeof parsed === 'string') return parsed.trim() === '';
  if (Array.isArray(parsed)) return parsed.length === 0;
  if (typeof parsed === 'object') {
    if (Array.isArray(parsed.data)) return parsed.data.length === 0;
    if (Array.isArray(parsed.rows)) return parsed.rows.length === 0;
    if (parsed.empty === true) return true;
    return Object.keys(parsed).length === 0;
  }
  return !text;
}

function normalizeAnalysisOptions(options = {}) {
  return {
    level: options.level || 'summary',
    includeDns: options.includeDns !== false,
    includeHttp: options.includeHttp !== false,
    includeTls: options.includeTls !== false,
    includePorts: options.includePorts !== false,
    timeoutMs: Number(options.timeoutMs || process.env.PACKET_ANALYSIS_TIMEOUT_MS || 60000),
  };
}

function normalizeFilePolicy(policy = {}) {
  return {
    downloadDir: policy.downloadDir || process.env.PACKET_DOWNLOAD_DIR || defaultDownloadDir(),
    maxBytes: Number(policy.maxBytes || process.env.PACKET_MAX_BYTES || 524288000),
    keepFiles: policy.keepFiles != null ? Boolean(policy.keepFiles) : envBool('PACKET_KEEP_FILES', false),
    retentionHours: Number(policy.retentionHours || process.env.PACKET_RETENTION_HOURS || 24),
    requirePreviewBeforeDownload: policy.requirePreviewBeforeDownload != null
      ? Boolean(policy.requirePreviewBeforeDownload)
      : envBool('PACKET_REQUIRE_PREVIEW_BEFORE_DOWNLOAD', true),
  };
}

function defaultDownloadDir() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) return path.join(home, '.openclaw', 'artifacts', 'openclaw-napm-packet-analysis');
  return path.resolve('./artifacts');
}

function retentionExpiry(retentionHours) {
  if (!Number.isFinite(retentionHours) || retentionHours <= 0) return null;
  return new Date(Date.now() + retentionHours * 60 * 60 * 1000).toISOString();
}

function normalizeTimestamp(value) {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'now') {
    return Math.floor(Date.now() / 1000);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  if (number > 9999999999) return Math.floor(number / 1000);
  return Math.floor(number);
}

function normalizeHost(host) {
  if (!host) return null;
  const trimmed = String(host).trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return withProtocol;
  }
}

function normalizeInstanceId(value) {
  if (!value) return value;
  const raw = String(value);
  const rightSide = raw.includes('##') ? raw.split('##').pop() : raw;
  return rightSide.startsWith('PATH1/') ? rightSide : `PATH1/${rightSide}`;
}

function detectDownloadTypeFromUrl(inputUrl) {
  try {
    const url = new URL(inputUrl);
    if (url.pathname.endsWith('/DownServlet')) return 'DownServlet';
    const type = url.searchParams.get('type');
    if (type === 'packetsDown') return 'packetsDown';
    if (type === 'packetsPreview') return 'packetsPreview';
    if (type === 'packetsInfo') return 'packetsInfo';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function maskUrl(inputUrl) {
  try {
    const url = new URL(inputUrl);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveParam(key) || isUsernameParam(key)) url.searchParams.set(key, '***');
    }
    return url.toString();
  } catch {
    return inputUrl;
  }
}

function toArray(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

function stripBom(text) {
  return text.replace(/^\uFEFF/, '');
}

function compactTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

function envBool(name, defaultValue) {
  const value = process.env[name];
  if (value == null || value === '') return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function failResolve(code, message) {
  return {
    ok: false,
    error: { code, message },
  };
}

function failureResult(code, message, extra = {}) {
  return {
    ok: false,
    error: { code, message, ...extra },
  };
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] == null) process.env[key] = value;
  }
}
