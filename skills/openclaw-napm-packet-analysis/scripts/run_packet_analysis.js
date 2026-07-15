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
const BUSINESS_TOP_METRICS = ['PGNPGE', 'PGTME', 'PGNSLPGE', 'PGSLPCT', 'PGHTTP400', 'PGHTTP500'];
const PAGE_FAMILY_TOP_METRICS = ['PGNPGE', 'PGNOBJE', 'PGHTTP200', 'PGHTTP300', 'PGHTTP400', 'PGHTTP500'];
const PACKET_COUNT_KEYS = [
  'packetCount',
  'packetsCount',
  'totalPacketCount',
  'totalPackets',
  'packetNum',
  'packetNumber',
  'packets',
  'count',
  'num',
];
const PACKET_SIZE_KEYS = [
  'packetBytes',
  'packetSize',
  'packetsSize',
  'totalBytes',
  'totalSize',
  'fileSize',
  'pcapSize',
  'captureSize',
  'bytes',
  'size',
];
const PACKET_PAYLOAD_EXTENSIONS = new Set(['.pcap', '.cap', '.pcapng', '.zip']);

// 推算 workspace 根目录，用于加载 .env（参照 alert-query 的 loadDotEnvCandidates 模式）
const workspaceRoot = path.resolve(__dirname, '..', '..', '..');

if (require.main === module) {
  main().catch((error) => {
    const result = failureResult('PACKET_RUNTIME_ERROR', error.message || String(error), { stack: error.stack });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  loadDotEnvCandidates([
    path.join(workspaceRoot, '.env'),
    path.join(process.cwd(), '.env'),
    process.env.OPENCLAW_HOME ? path.join(process.env.OPENCLAW_HOME, '.env') : null,
    process.env.HOME ? path.join(process.env.HOME, '.openclaw', '.env') : null,
  ]);
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
  if (task.needsBusinessInstanceResolution) {
    const businessResolution = await resolveBusinessPacketInstance(task);
    task.businessResolution = businessResolution;
    if (businessResolution.previewOnly) {
      const result = {
        ok: businessResolution.ok,
        mode: task.mode,
        downloadType: task.downloadType,
        startedAt,
        criteria: task.criteria,
        urls: {},
        explanation: null,
        preview: null,
        download: null,
        analysis: null,
        businessResolution,
        error: businessResolution.ok ? null : businessResolution.error,
        decision: businessResolution.ok
          ? {
            next_action: 'SELECT_PAGE_VIEW',
            reason: 'BUSINESS_PAGE_VIEWS_PREVIEW_READY',
            message: '请选择一个页面访问明细的 clientIp 或 pageViewIndex，再继续构造或下载业务数据包。',
          }
          : {
            next_action: 'CLARIFICATION_REQUIRED',
            reason: businessResolution.error && businessResolution.error.code,
            message: businessResolution.error && businessResolution.error.message,
          },
      };
      result.summary = buildSummary(result);
      result.narrationInput = buildNarrationInput(result);
      writeJson(result);
      return;
    }
    if (!businessResolution.ok) {
      writeJson({
        ok: false,
        mode: task.mode,
        downloadType: task.downloadType,
        criteria: task.criteria,
        businessResolution,
        error: businessResolution.error,
        decision: {
          next_action: 'CLARIFICATION_REQUIRED',
          reason: businessResolution.error && businessResolution.error.code,
          message: businessResolution.error && businessResolution.error.message,
        },
        summary: {
          title: '业务数据包实例解析失败',
          highlights: [businessResolution.error && businessResolution.error.message].filter(Boolean),
        },
      });
      return;
    }
    task.criteria = {
      ...task.criteria,
      ...businessResolution.criteriaPatch,
    };
    task.urls = buildUrls({
      host: task.host,
      criteria: task.criteria,
      downloadType: task.downloadType,
      showFullUrls: task.showFullUrls,
    });
  }
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
    businessResolution: task.businessResolution || null,
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

  if (PREVIEW_MODES.has(task.mode) && task.urls.previewRaw) {
    result.preview = await requestPreview(task);
    task.preview = result.preview;
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
    if (DOWNLOAD_MODES.has(task.mode) && applyPreviewRiskGate(result, task)) {
      result.summary = buildSummary(result);
      result.narrationInput = buildNarrationInput(result);
      writeJson(result);
      return;
    }
  } else if (PREVIEW_MODES.has(task.mode) && task.downloadType !== 'DownServlet') {
    result.ok = false;
    result.error = {
      code: 'PACKET_PREVIEW_UNSUPPORTED',
      message: '当前数据包任务没有可用的 packetsPreview URL。',
    };
    result.summary = buildSummary(result);
    result.narrationInput = buildNarrationInput(result);
    writeJson(result);
    return;
  }

  if (DOWNLOAD_MODES.has(task.mode)) {
    if (shouldPreviewBeforeDownload(task) && !result.preview) {
      result.preview = await requestPreview(task);
      task.preview = result.preview;
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
      if (applyPreviewRiskGate(result, task)) {
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

  const needsBusinessInstanceResolution = shouldResolveBusinessPacketInstance(criteria);
  const downloadType = needsBusinessInstanceResolution
    ? 'DownServlet'
    : (query.downloadType || criteria.downloadType || 'packetsDown');
  const host = normalizeHost(query.host || criteria.host || process.env.NETINSIDE_HOST);
  if (!host) {
    return failResolve('NETINSIDE_HOST_REQUIRED', '需要 NETINSIDE_HOST，或在 query.host / criteria.host 中提供 NetInside 地址。');
  }

  const urls = needsBusinessInstanceResolution
    ? {}
    : buildUrls({ host, criteria, downloadType, showFullUrls });
  return {
    ok: true,
    task: {
      mode,
      downloadType,
      criteria,
      host,
      urls,
      showFullUrls,
      needsBusinessInstanceResolution,
      analysis: normalizeAnalysisOptions(query.analysis),
      filePolicy: normalizeFilePolicy(query.filePolicy),
      forceDownload: Boolean(query.forceDownload || criteria.forceDownload),
      previewRiskAccepted: Boolean(query.previewRiskAccepted || criteria.previewRiskAccepted),
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
  if (!criteria.businessName) {
    criteria.businessName = criteria.webApplication || criteria.applicationName || criteria.appName || criteria.business;
  }
  if (criteria.pageFamilyDetailId && !criteria.resultName) {
    criteria.resultName = criteria.pageFamilyDetailId;
  }
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
    const hasBusinessPacketCondition = criteria.businessName || criteria.pageFamilyId || criteria.pageFamilyDetailId || criteria.resultName;
    if (!hasPacketCondition && !hasDownServletCondition && !hasBusinessPacketCondition) {
      return failResolve('PACKET_QUERY_REQUIRED', '需要 ips、ipRanges、id、top、instanceId、businessName、pageFamilyId 或 pageFamilyDetailId 之一。');
    }
  }
  return { ok: true };
}

function shouldResolveBusinessPacketInstance(criteria = {}) {
  if (!criteria || criteria.instanceId || criteria.resultName) {
    return false;
  }
  return Boolean(criteria.businessName || criteria.pageFamilyId);
}

function buildUrls({ host, criteria, downloadType, showFullUrls }) {
  if (downloadType === 'DownServlet' || criteria.instanceId) {
    const url = new URL('/webservice/DownServlet', host);
    appendRuntimeAuthQueryParams(url);
    url.searchParams.set('moduleKey', criteria.moduleKey || 'Ipv');
    url.searchParams.set('groupId', String(criteria.groupId || 45));
    if (criteria.rtClickId) url.searchParams.set('rtClickId', String(criteria.rtClickId));
    else if (criteria.downloadId) url.searchParams.set('rtClickId', String(criteria.downloadId));
    else url.searchParams.set('rtClickId', '5');
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

async function resolveBusinessPacketInstance(task) {
  const criteria = task.criteria || {};
  const steps = [];
  let businessName = criteria.businessName ? String(criteria.businessName).trim() : '';
  let pageFamilyId = criteria.pageFamilyId ? String(criteria.pageFamilyId).trim() : '';

  if (!businessName && !pageFamilyId) {
    const businessUrl = buildBusinessTopValuesUrl(task.host, criteria);
    const businessResult = await requestNetInsideJson(businessUrl, 'business_top_values');
    steps.push({
      name: 'business_top_values',
      url: publicPacketUrl(businessUrl, task.showFullUrls),
      ok: businessResult.ok,
      rowCount: businessResult.rows.length,
    });
    if (!businessResult.ok) {
      return businessResolveFailure('BUSINESS_PACKET_BUSINESS_QUERY_FAILED', businessResult.message, steps);
    }
    const selectedBusiness = selectBusinessRow(businessResult.rows, criteria);
    if (!selectedBusiness) {
      return businessResolveFailure('BUSINESS_PACKET_BUSINESS_NOT_FOUND', '未从业务 Top 查询中找到可用于数据包分析的业务对象。', steps);
    }
    businessName = extractBusinessName(selectedBusiness);
    steps[steps.length - 1].selectedBusiness = businessName;
  }

  if (!pageFamilyId) {
    if (!businessName) {
      return businessResolveFailure('BUSINESS_PACKET_BUSINESS_REQUIRED', '业务数据包分析需要 businessName，或直接提供 pageFamilyId。', steps);
    }
    const pageFamilyUrl = buildPageFamilyTopValuesUrl(task.host, criteria, businessName);
    const pageFamilyResult = await requestNetInsideJson(pageFamilyUrl, 'page_family_top_values');
    steps.push({
      name: 'page_family_top_values',
      url: publicPacketUrl(pageFamilyUrl, task.showFullUrls),
      ok: pageFamilyResult.ok,
      rowCount: pageFamilyResult.rows.length,
      businessName,
    });
    if (!pageFamilyResult.ok) {
      return businessResolveFailure('BUSINESS_PACKET_PAGE_FAMILY_QUERY_FAILED', pageFamilyResult.message, steps);
    }
    const selectedPageFamily = selectPageFamilyRow(pageFamilyResult.rows, criteria);
    if (!selectedPageFamily) {
      return businessResolveFailure('BUSINESS_PACKET_PAGE_FAMILY_NOT_FOUND', '未从页面错误分析结果中找到可解析 pageFamilyId 的页面行。', steps);
    }
    pageFamilyId = extractPageFamilyId(selectedPageFamily);
    steps[steps.length - 1].selectedPageFamilyId = pageFamilyId;
    steps[steps.length - 1].selectedPageFamilyLabel = extractPageFamilyLabel(selectedPageFamily);
  }

  const pageViewsUrl = buildPageViewsUrl(task.host, criteria, pageFamilyId);
  const pageViewsResult = await requestNetInsideJson(pageViewsUrl, 'page_views');
  const pageViewsPreview = buildPageViewsPreview(pageViewsResult.rows, {
    pageFamilyId,
    businessName,
    url: publicPacketUrl(pageViewsUrl, task.showFullUrls),
  });
  steps.push({
    name: 'page_views',
    url: publicPacketUrl(pageViewsUrl, task.showFullUrls),
    ok: pageViewsResult.ok,
    rowCount: pageViewsResult.rows.length,
    pageFamilyId,
    previewRows: pageViewsPreview.rows,
  });
  if (!pageViewsResult.ok) {
    return businessResolveFailure('BUSINESS_PACKET_PAGE_VIEWS_QUERY_FAILED', pageViewsResult.message, steps);
  }

  if (task.mode === 'preview_only' || criteria.businessPageViewsPreviewOnly) {
    return {
      ok: pageViewsPreview.rows.length > 0,
      previewOnly: true,
      businessName,
      pageFamilyId,
      pageViewsPreview,
      steps,
      error: pageViewsPreview.rows.length > 0 ? null : {
        code: 'BUSINESS_PACKET_PAGE_VIEW_NOT_FOUND',
        message: 'pageViews 未返回页面访问明细，无法预览可选的业务数据包访问实例。',
      },
    };
  }

  const selectedPageView = selectPageViewRow(pageViewsResult.rows, criteria);
  if (!selectedPageView) {
    return businessResolveFailure('BUSINESS_PACKET_PAGE_VIEW_NOT_FOUND', 'pageViews 未返回包含 pageFamilyDetailId 的页面访问明细。', steps);
  }
  const pageFamilyDetailId = extractPageFamilyDetailId(selectedPageView);
  steps[steps.length - 1].selectedPageFamilyDetailId = pageFamilyDetailId;
  steps[steps.length - 1].selectedClientIp = selectedPageView.clientIp || selectedPageView.clientIP || selectedPageView.client;
  steps[steps.length - 1].selectedHttpStatus = selectedPageView.httpStatus || selectedPageView.status || selectedPageView.responseCode;

  return {
    ok: true,
    businessName,
    pageFamilyId,
    pageFamilyDetailId,
    instanceId: normalizeInstanceId(pageFamilyDetailId),
    criteriaPatch: {
      businessName,
      pageFamilyId,
      pageFamilyDetailId,
      resultName: pageFamilyDetailId,
      instanceId: normalizeInstanceId(pageFamilyDetailId),
      moduleKey: criteria.moduleKey || 'Ipv',
      groupId: criteria.groupId || 45,
      rtClickId: criteria.rtClickId || criteria.downloadId || 5,
    },
    steps,
  };
}

function businessResolveFailure(code, message, steps = []) {
  return {
    ok: false,
    error: { code, message },
    steps,
  };
}

function buildPageViewsPreview(rows = [], context = {}) {
  const normalizedRows = rows
    .map((row, index) => normalizePageViewPreviewRow(row, index))
    .filter((row) => row.pageFamilyDetailId);
  const uniqueClientIps = Array.from(new Set(normalizedRows.map((row) => row.clientIp).filter(Boolean)));
  const statusCounts = {};
  for (const row of normalizedRows) {
    const key = row.httpStatus != null ? String(row.httpStatus) : 'unknown';
    statusCounts[key] = (statusCounts[key] || 0) + 1;
  }
  return {
    pageFamilyId: context.pageFamilyId || null,
    businessName: context.businessName || null,
    url: context.url || null,
    rowCount: normalizedRows.length,
    uniqueClientIps,
    statusCounts,
    rows: normalizedRows.slice(0, 50),
    selectionHint: '选择 clientIp 或 pageViewIndex 后，可继续构造 DownServlet 下载链接。',
  };
}

function normalizePageViewPreviewRow(row, index) {
  const detailId = extractPageFamilyDetailId(row);
  return {
    index,
    startTime: row && (row.startTime || row.StartTime || row.time || row.timestamp) || null,
    page: row && (row.page || row.Page || row.url || row.uri) || null,
    clientIp: row && (row.clientIp || row.clientIP || row.ClientIp || row.client || row.originatingIp) || null,
    serverIp: row && (row.serverIp || row.serverIP || row.ServerIp || row.server) || null,
    originatingIp: row && (row.originatingIp || row.OriginatingIp) || null,
    httpStatus: row && (row.httpStatus || row.HttpStatus || row.status || row.responseCode) || null,
    http400S: row && (row.http400S || row.Http400S) || 0,
    http500S: row && (row.http500S || row.Http500S) || 0,
    pageTime: row && (row.pageTime || row.PageTime) || null,
    pageTraffic: row && (row.pageTraffic || row.PageTraffic) || null,
    requestTraffic: row && (row.requestTraffic || row.RequestTraffic) || null,
    userAgent: row && (row.userAgent || row.UserAgent) || null,
    pageFamilyDetailId: detailId,
    instanceId: detailId ? normalizeInstanceId(detailId) : null,
  };
}

function buildBusinessTopValuesUrl(host, criteria = {}) {
  const url = new URL('/webservice/NetInside', host);
  appendRuntimeAuthQueryParams(url);
  url.searchParams.set('type', 'topValues');
  url.searchParams.set('numGroups', '1');
  url.searchParams.set('groupType1', 'WebApplication');
  url.searchParams.set('start', String(criteria.start));
  url.searchParams.set('end', String(criteria.end));
  url.searchParams.set('metrics', normalizeMetricList(criteria.businessMetrics, BUSINESS_TOP_METRICS).join(','));
  url.searchParams.set('topMetric', criteria.businessTopMetric || 'PGNPGE');
  url.searchParams.set('topCount', String(criteria.businessTopCount || 20));
  url.searchParams.set('json', 'true');
  return url.toString();
}

function buildPageFamilyTopValuesUrl(host, criteria = {}, businessName = '') {
  const url = new URL('/webservice/NetInside', host);
  appendRuntimeAuthQueryParams(url);
  url.searchParams.set('type', 'topValues');
  url.searchParams.set('numGroups', '3');
  url.searchParams.set('groupType1', 'WebApplication');
  url.searchParams.set('groupArgument1', businessName);
  url.searchParams.set('groupType2', 'PageFamilies');
  url.searchParams.set('groupType3', 'PageFamily');
  url.searchParams.set('metrics', normalizeMetricList(criteria.pageFamilyMetrics, PAGE_FAMILY_TOP_METRICS).join(','));
  url.searchParams.set('start', String(criteria.start));
  url.searchParams.set('end', String(criteria.end));
  url.searchParams.set('topMetric', criteria.pageFamilyTopMetric || 'PGHTTP500');
  url.searchParams.set('topCount', String(criteria.pageFamilyTopCount || 5));
  url.searchParams.set('json', 'true');
  return url.toString();
}

function buildPageViewsUrl(host, criteria = {}, pageFamilyId = '') {
  const url = new URL('/webservice/NetInside', host);
  appendRuntimeAuthQueryParams(url);
  url.searchParams.set('type', 'pageViews');
  url.searchParams.set('start', String(criteria.start));
  url.searchParams.set('end', String(criteria.end));
  url.searchParams.set('json', 'true');
  url.searchParams.set('pageFamilyId', String(pageFamilyId));
  url.searchParams.set('maxLimit', String(criteria.maxLimit == null ? 'undefined' : criteria.maxLimit));
  return url.toString();
}

async function requestNetInsideJson(url, stepName) {
  try {
    const response = await httpRequest(url, { responseType: 'text' });
    const text = response.body.toString('utf8').trim();
    const parsed = parseMaybeJson(text);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        ok: false,
        rows: [],
        message: `${stepName} HTTP 状态码 ${response.statusCode}。`,
        statusCode: response.statusCode,
        textSample: text.slice(0, 500),
      };
    }
    const rows = normalizeRowsFromPayload(parsed);
    return {
      ok: true,
      rows,
      statusCode: response.statusCode,
      parsed,
      textSample: typeof parsed === 'string' ? parsed.slice(0, 500) : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      rows: [],
      message: error.message,
    };
  }
}

function normalizeRowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['rows', 'data', 'result', 'results', 'items', 'list']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (payload.data && typeof payload.data === 'object') {
    return normalizeRowsFromPayload(payload.data);
  }
  return [payload];
}

function selectBusinessRow(rows = [], criteria = {}) {
  const expected = String(criteria.businessName || '').trim();
  if (expected) {
    return rows.find((row) => extractBusinessName(row) === expected)
      || rows.find((row) => extractBusinessName(row).includes(expected) || expected.includes(extractBusinessName(row)));
  }
  return rows.find((row) => extractBusinessName(row)) || null;
}

function selectPageFamilyRow(rows = [], criteria = {}) {
  const expectedPageFamilyId = String(criteria.pageFamilyId || '').trim();
  if (expectedPageFamilyId) {
    return rows.find((row) => extractPageFamilyId(row) === expectedPageFamilyId) || null;
  }
  const expectedPage = String(criteria.page || criteria.pageUrl || criteria.url || '').trim();
  if (expectedPage) {
    return rows.find((row) => extractPageFamilyLabel(row).includes(expectedPage)) || null;
  }
  return rows.find((row) => extractPageFamilyId(row)) || null;
}

function selectPageViewRow(rows = [], criteria = {}) {
  const expectedDetailId = String(criteria.pageFamilyDetailId || criteria.resultName || '').replace(/^PATH1\//, '').trim();
  if (expectedDetailId) {
    return rows.find((row) => extractPageFamilyDetailId(row) === expectedDetailId) || null;
  }
  const clientIp = String(criteria.clientIp || criteria.clientIP || '').trim();
  const serverIp = String(criteria.serverIp || criteria.serverIP || '').trim();
  const httpStatus = String(criteria.httpStatus || criteria.status || criteria.responseCode || '').trim();
  const page = String(criteria.page || criteria.pageUrl || criteria.url || '').trim();
  let candidates = rows.filter((row) => extractPageFamilyDetailId(row));
  if (clientIp) candidates = candidates.filter((row) => String(row.clientIp || row.clientIP || row.client || '').includes(clientIp));
  if (serverIp) candidates = candidates.filter((row) => String(row.serverIp || row.serverIP || row.server || '').includes(serverIp));
  if (httpStatus) candidates = candidates.filter((row) => String(row.httpStatus || row.status || row.responseCode || '').includes(httpStatus));
  if (page) candidates = candidates.filter((row) => String(row.page || row.url || row.uri || '').includes(page));
  const index = Number(criteria.pageViewIndex || 0);
  return candidates[Number.isFinite(index) && index >= 0 ? index : 0] || null;
}

function extractBusinessName(row) {
  if (!row || typeof row !== 'object') return '';
  if (row.group && typeof row.group === 'object' && row.group.argument) return String(row.group.argument).trim();
  return String(row.argument || row.name || row.label || row.groupArgument || row.application || row.webApplication || '').trim();
}

function extractPageFamilyLabel(row) {
  if (!row || typeof row !== 'object') return '';
  if (row.group && typeof row.group === 'object' && row.group.argument) return String(row.group.argument).trim();
  return String(row.argument || row.name || row.label || row.page || row.url || row.groupPath || '').trim();
}

function extractPageFamilyId(row) {
  if (!row || typeof row !== 'object') return '';
  const direct = row.pageFamilyId || row.pageFamilyID || row.id;
  if (direct && /^\d+$/.test(String(direct))) return String(direct);
  const groupPath = String(row.groupPath || row.path || row.group_path || '').trim();
  const match = groupPath.match(/page\s+(\d+)\//i)
    || groupPath.match(/pageFamilyId[=: ]+(\d+)/i)
    || groupPath.match(/PageFamily[^\d]+(\d+)/i);
  return match ? match[1] : '';
}

function extractPageFamilyDetailId(row) {
  if (!row) return '';
  if (typeof row === 'string') return extractDetailIdFromText(row, false);
  if (Array.isArray(row)) {
    for (let index = row.length - 1; index >= 0; index -= 1) {
      const found = extractDetailIdFromText(row[index], false);
      if (found) return found;
    }
    return '';
  }
  if (typeof row !== 'object') return '';
  const direct = row.pageFamilyDetailId || row.pageFamilyDetailID || row.resultName || row.instanceId;
  if (direct) return extractDetailIdFromText(direct, true);
  for (const value of Object.values(row).reverse()) {
    const found = extractPageFamilyDetailId(value);
    if (found) return found;
  }
  return '';
}

function extractDetailIdFromText(value, loose = false) {
  const text = String(value || '').trim();
  if (!text) return '';
  const withoutPath = text.replace(/^PATH1\//, '');
  const rightSide = withoutPath.includes('##') ? withoutPath.split('##').pop() : withoutPath;
  const match = rightSide.match(/\d+-\d+---\d+(?:\.\d+)?-\d+(?:\.\d+)?-[0-9a-fA-F:.]+/);
  if (match) return match[0];
  if (loose || withoutPath.includes('##')) return rightSide;
  return '';
}

function normalizeMetricList(value, fallback) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return fallback;
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
    const responseBytes = Buffer.byteLength(response.body);
    const empty = isEmptyPreview(parsed, text);
    const overview = normalizePreviewOverview(parsed, task.criteria);
    const risk = assessPacketDownloadRisk(overview, task.criteria, task.filePolicy);
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      statusCode: response.statusCode,
      empty,
      contentType: response.headers['content-type'] || null,
      bytes: responseBytes,
      responseBytes,
      data: parsed,
      overview,
      risk,
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

function normalizePreviewOverview(parsed, criteria = {}) {
  const rows = previewRowsFromPayload(parsed);
  const durationSeconds = Number(criteria.end) > Number(criteria.start)
    ? Number(criteria.end) - Number(criteria.start)
    : null;
  const packetCountMatch = extractNumericByCandidateKeys(parsed, PACKET_COUNT_KEYS, {
    rowFallback: rows,
    integer: true,
  });
  const estimatedBytesMatch = extractNumericByCandidateKeys(parsed, PACKET_SIZE_KEYS, {
    rowFallback: rows,
    bytes: true,
  });
  const packetCount = packetCountMatch.value;
  const estimatedBytes = estimatedBytesMatch.value;
  return {
    packetCount,
    estimatedBytes,
    estimatedSizeText: estimatedBytes != null ? formatBytes(estimatedBytes) : null,
    durationSeconds,
    avgBytesPerSecond: estimatedBytes != null && durationSeconds > 0
      ? estimatedBytes / durationSeconds
      : null,
    avgPacketsPerSecond: packetCount != null && durationSeconds > 0
      ? packetCount / durationSeconds
      : null,
    topEndpoints: summarizePreviewRows(rows, ['ip', 'host', 'endpoint', 'srcIp', 'dstIp', 'clientIp', 'serverIp']),
    topConversations: summarizePreviewRows(rows, ['conversation', 'flow', 'session', 'srcDst', 'pair']),
    timeBuckets: extractPreviewCollection(parsed, ['timeBuckets', 'timeline', 'series', 'chartData']),
    trafficDistribution: extractPreviewCollection(parsed, ['flowDistribution', 'trafficDistribution', 'distribution']),
    rawFieldHints: {
      packetCountField: packetCountMatch.path,
      sizeField: estimatedBytesMatch.path,
    },
  };
}

function assessPacketDownloadRisk(overview = {}, criteria = {}, filePolicy = {}) {
  const warnBytes = envNumber('PACKET_PREVIEW_WARN_BYTES', 209715200);
  const blockBytes = envNumber('PACKET_PREVIEW_BLOCK_BYTES', 1073741824);
  const warnPackets = envNumber('PACKET_PREVIEW_WARN_PACKETS', 200000);
  const blockPackets = envNumber('PACKET_PREVIEW_BLOCK_PACKETS', 1000000);
  const blockUnknown = envBool('PACKET_PREVIEW_BLOCK_UNKNOWN', true);
  const blockMedium = envBool('PACKET_PREVIEW_BLOCK_MEDIUM', false);
  const confirmDownload = envBool('PACKET_PREVIEW_CONFIRM_DOWNLOAD', false);
  const estimatedBytes = asFiniteNumber(overview.estimatedBytes);
  const packetCount = asFiniteNumber(overview.packetCount);
  const reasons = [];
  let level = 'low';

  if (estimatedBytes == null && packetCount == null) {
    level = 'unknown';
    reasons.push('预览接口确认有数据，但未返回可解析的预计下载大小或包数量。');
  } else {
    if (estimatedBytes != null && estimatedBytes >= blockBytes) {
      level = 'high';
      reasons.push(`预计下载大小 ${formatBytes(estimatedBytes)}，达到高风险阈值 ${formatBytes(blockBytes)}。`);
    } else if (estimatedBytes != null && estimatedBytes >= warnBytes && level !== 'high') {
      level = 'medium';
      reasons.push(`预计下载大小 ${formatBytes(estimatedBytes)}，超过提示阈值 ${formatBytes(warnBytes)}。`);
    }
    if (packetCount != null && packetCount >= blockPackets) {
      level = 'high';
      reasons.push(`预计数据包数量 ${formatInteger(packetCount)}，达到高风险阈值 ${formatInteger(blockPackets)}。`);
    } else if (packetCount != null && packetCount >= warnPackets && level !== 'high') {
      level = 'medium';
      reasons.push(`预计数据包数量 ${formatInteger(packetCount)}，超过提示阈值 ${formatInteger(warnPackets)}。`);
    }
  }

  if (!reasons.length) {
    reasons.push('预览结果低于当前自动下载风险阈值。');
  }

  let recommendation = 'CONTINUE_DOWNLOAD';
  if (level === 'high') recommendation = 'SUGGEST_NARROW_TIME_RANGE';
  else if (level === 'unknown' && blockUnknown) recommendation = 'CONFIRM_DOWNLOAD';
  else if (level === 'medium' && (blockMedium || confirmDownload)) recommendation = 'CONFIRM_DOWNLOAD';
  else if (level === 'low' && confirmDownload) recommendation = 'CONFIRM_DOWNLOAD';

  const message = buildPreviewRiskMessage(level, recommendation, overview, reasons);
  return {
    level,
    recommendation,
    message,
    reasons,
    thresholds: {
      warnBytes,
      blockBytes,
      warnPackets,
      blockPackets,
      blockUnknown,
      blockMedium,
      confirmDownload,
    },
    suggestedActions: previewRiskSuggestedActions(recommendation, criteria),
  };
}

function buildPreviewRiskMessage(level, recommendation, overview, reasons) {
  const packetText = overview.packetCount != null ? `${formatInteger(overview.packetCount)} 个包` : '包数未知';
  const sizeText = overview.estimatedBytes != null ? overview.estimatedSizeText || formatBytes(overview.estimatedBytes) : '大小未知';
  if (recommendation === 'CONTINUE_DOWNLOAD') {
    return `预览结果：${packetText}，预计 ${sizeText}，风险等级 ${level}，可继续下载。`;
  }
  if (recommendation === 'SUGGEST_NARROW_TIME_RANGE') {
    return `预览结果：${packetText}，预计 ${sizeText}，风险等级 ${level}。${reasons[0]}建议先缩小时间范围。`;
  }
  return `预览结果：${packetText}，预计 ${sizeText}，风险等级 ${level}。下载前需要用户确认。`;
}

function previewRiskSuggestedActions(recommendation, criteria = {}) {
  if (recommendation === 'CONTINUE_DOWNLOAD') return [];
  const actions = ['确认继续下载'];
  if (criteria.start && criteria.end) actions.push('缩小时间范围后重新预览');
  actions.push('只查看预览概览，不下载');
  return actions;
}

function extractNumericByCandidateKeys(payload, candidateKeys, options = {}) {
  const matches = collectNumericMatches(payload, candidateKeys, options);
  if (matches.length) {
    matches.sort((a, b) => a.score - b.score);
    return {
      value: options.integer ? Math.floor(matches[0].value) : matches[0].value,
      path: matches[0].path,
    };
  }

  const rows = Array.isArray(options.rowFallback) ? options.rowFallback : [];
  if (rows.length) {
    let total = 0;
    let found = false;
    let path = null;
    for (let index = 0; index < rows.length; index += 1) {
      const rowMatches = collectNumericMatches(rows[index], candidateKeys, options);
      if (!rowMatches.length) continue;
      rowMatches.sort((a, b) => a.score - b.score);
      total += rowMatches[0].value;
      path = path || `rows[].${rowMatches[0].path}`;
      found = true;
    }
    if (found) {
      return {
        value: options.integer ? Math.floor(total) : total,
        path,
      };
    }
  }

  return { value: null, path: null };
}

function collectNumericMatches(value, candidateKeys, options = {}, pathParts = [], matches = []) {
  if (value == null) return matches;
  if (Array.isArray(value)) {
    if (options.includeArrays) {
      value.forEach((item, index) => collectNumericMatches(item, candidateKeys, options, pathParts.concat(`[${index}]`), matches));
    }
    return matches;
  }
  if (typeof value !== 'object') return matches;

  const lowerCandidates = candidateKeys.map((key) => String(key).toLowerCase());
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const candidateIndex = lowerCandidates.findIndex((candidate) => candidate.toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedKey);
    const childPath = pathParts.concat(key);
    if (candidateIndex !== -1) {
      const numeric = options.bytes ? normalizeSizeBytes(child) : asFiniteNumber(child);
      if (numeric != null) {
        const genericPenalty = ['count', 'num', 'bytes', 'size'].includes(normalizedKey) ? 100 : 0;
        matches.push({
          value: numeric,
          path: childPath.join('.'),
          score: candidateIndex + childPath.length * 10 + genericPenalty,
        });
      }
    }
    collectNumericMatches(child, candidateKeys, options, childPath, matches);
  }
  return matches;
}

function normalizeSizeBytes(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value || '').trim();
  if (!text) return null;
  const normalized = text.replace(/,/g, '');
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)\s*(b|bytes?|kb|kib|mb|mib|gb|gib|tb|tib)?$/i);
  if (!match) return asFiniteNumber(normalized);
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number < 0) return null;
  const unit = String(match[2] || 'b').toLowerCase();
  const multipliers = {
    b: 1,
    byte: 1,
    bytes: 1,
    kb: 1024,
    kib: 1024,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    tb: 1024 ** 4,
    tib: 1024 ** 4,
  };
  return Math.floor(number * (multipliers[unit] || 1));
}

function previewRowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['rows', 'data', 'result', 'results', 'items', 'list']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (payload.data && typeof payload.data === 'object') return previewRowsFromPayload(payload.data);
  return [];
}

function summarizePreviewRows(rows = [], labelKeys = []) {
  const summary = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const label = firstStringByKeys(row, labelKeys);
    if (!label) continue;
    const bytes = extractNumericByCandidateKeys(row, PACKET_SIZE_KEYS, { bytes: true }).value;
    const packets = extractNumericByCandidateKeys(row, PACKET_COUNT_KEYS, { integer: true }).value;
    summary.push({ label, bytes, packets });
    if (summary.length >= 10) break;
  }
  return summary;
}

function firstStringByKeys(row, keys) {
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim()) return String(row[key]).trim();
  }
  return '';
}

function extractPreviewCollection(payload, keys = []) {
  if (!payload || typeof payload !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key].slice(0, 20);
  }
  if (payload.data && typeof payload.data === 'object') return extractPreviewCollection(payload.data, keys);
  return [];
}

function formatBytes(bytes) {
  const number = asFiniteNumber(bytes);
  if (number == null) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = number;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatInteger(value) {
  const number = asFiniteNumber(value);
  return number == null ? '' : Math.floor(number).toLocaleString('en-US');
}

function asFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const number = Number(value.replace(/,/g, ''));
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function applyPreviewRiskGate(result, task) {
  if (!result.preview || !result.preview.risk) return false;
  if (isPreviewRiskAccepted(task)) return false;
  const recommendation = result.preview.risk.recommendation;
  if (!recommendation || recommendation === 'CONTINUE_DOWNLOAD') return false;
  const level = result.preview.risk.level || 'unknown';
  const reason = `PACKET_PREVIEW_RISK_${String(level).toUpperCase()}`;
  result.ok = false;
  result.error = {
    code: recommendation === 'SUGGEST_NARROW_TIME_RANGE'
      ? 'PACKET_PREVIEW_RISK_TOO_HIGH'
      : 'PACKET_PREVIEW_REQUIRES_CONFIRMATION',
    message: result.preview.risk.message || '数据包预览结果需要用户确认后才能下载。',
  };
  result.decision = {
    next_action: recommendation,
    reason,
    message: result.error.message,
    suggestedActions: result.preview.risk.suggestedActions || [],
  };
  return true;
}

function isPreviewRiskAccepted(task) {
  return Boolean(task && (task.forceDownload || task.previewRiskAccepted));
}

async function downloadPacket(task) {
  const downloadUrl = task.urls.downloadRaw;
  await cleanupExpiredArtifacts(task.filePolicy.downloadDir, task.filePolicy.retentionHours);
  const storage = await preflightStorageForDownload(task, task.preview);
  if (!storage.decision.allowed) {
    return {
      ok: false,
      error: {
        code: 'PACKET_STORAGE_NOT_ENOUGH_SPACE',
        message: storage.decision.message,
      },
      urlMasked: task.urls.download,
      storage,
    };
  }
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
      storage,
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
      storage,
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
  const alertContext = analysisOptions.alertContext || null;
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
    // 告警触发指标上下文（从 alert-query 透传），
    // 使 AI 层能围绕告警根因展开叙述，而非只输出泛化的协议分布。
    alertContext,
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
  return /^(password|passwd|pwd|token|cookie|session|sessionid|credential|secret|apikey|api_key|access_token|refresh_token)$/i.test(String(key || ''));
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

async function preflightStorageForDownload(task, preview = null) {
  const downloadDir = task.filePolicy.downloadDir || defaultDownloadDir();
  await fsp.mkdir(downloadDir, { recursive: true });
  const policy = normalizeStoragePolicy(task.filePolicy.storagePolicy);
  const before = await getDiskUsage(downloadDir);
  const cleanup = {
    triggered: false,
    deletedFiles: 0,
    deletedDirs: 0,
    deletedBytes: 0,
    errors: [],
  };
  let afterCleanup = before;

  if (before && before.usedPercent >= policy.cleanPercent) {
    const cleanupResult = await cleanupArtifactsByWatermark(downloadDir, {
      targetPercent: policy.targetPercent,
      dryRun: policy.dryRun,
      getDiskUsageFn: getDiskUsage,
    });
    Object.assign(cleanup, cleanupResult, { triggered: true });
    afterCleanup = await getDiskUsage(downloadDir);
  }

  const estimatedDownloadBytes = getEstimatedDownloadBytes(preview, task.filePolicy);
  const requiredFreeBytes = Math.ceil(estimatedDownloadBytes * policy.reserveMultiplier + policy.minFreeBytes);
  const decision = buildStorageDecision(afterCleanup, {
    estimatedDownloadBytes,
    requiredFreeBytes,
    policy,
  });

  return {
    downloadDir: path.resolve(downloadDir),
    before,
    afterCleanup,
    cleanup,
    estimatedDownloadBytes,
    requiredFreeBytes,
    decision,
  };
}

function buildStorageDecision(usage, { estimatedDownloadBytes, requiredFreeBytes, policy }) {
  if (!usage) {
    return {
      allowed: true,
      reason: 'DISK_USAGE_UNKNOWN',
      message: '未能获取下载目录磁盘水位，按保守下载限制继续执行。',
    };
  }
  if (usage.usedPercent >= policy.blockPercent) {
    return {
      allowed: false,
      reason: 'DISK_USAGE_BLOCKED',
      message: `当前磁盘使用率 ${usage.usedPercent.toFixed(1)}%，已达到阻断阈值 ${policy.blockPercent}%。`,
    };
  }
  if (usage.freeBytes < requiredFreeBytes) {
    return {
      allowed: false,
      reason: 'FREE_SPACE_NOT_ENOUGH',
      message: `当前可用空间 ${formatBytes(usage.freeBytes)}，低于安全预留 ${formatBytes(requiredFreeBytes)}。`,
    };
  }
  const reason = usage.usedPercent >= policy.warnPercent ? 'DISK_USAGE_WARN' : 'ENOUGH_SPACE';
  return {
    allowed: true,
    reason,
    message: reason === 'DISK_USAGE_WARN'
      ? `当前磁盘使用率 ${usage.usedPercent.toFixed(1)}%，已超过提示阈值 ${policy.warnPercent}%，但仍允许下载。`
      : '下载目录磁盘空间满足要求。',
    estimatedDownloadBytes,
  };
}

function getEstimatedDownloadBytes(preview, filePolicy = {}) {
  const estimated = preview && preview.overview && asFiniteNumber(preview.overview.estimatedBytes);
  if (estimated != null) return estimated;
  const maxBytes = asFiniteNumber(filePolicy.maxBytes);
  return maxBytes != null ? maxBytes : envNumber('PACKET_MAX_BYTES', 524288000);
}

function normalizeStoragePolicy(policy = {}) {
  return {
    warnPercent: Number(policy.warnPercent ?? envNumber('PACKET_STORAGE_WARN_PERCENT', 75)),
    cleanPercent: Number(policy.cleanPercent ?? envNumber('PACKET_STORAGE_CLEAN_PERCENT', 80)),
    targetPercent: Number(policy.targetPercent ?? envNumber('PACKET_STORAGE_TARGET_PERCENT', 70)),
    blockPercent: Number(policy.blockPercent ?? envNumber('PACKET_STORAGE_BLOCK_PERCENT', 90)),
    minFreeBytes: Number(policy.minFreeBytes ?? envNumber('PACKET_STORAGE_MIN_FREE_BYTES', 2147483648)),
    reserveMultiplier: Number(policy.reserveMultiplier ?? envNumber('PACKET_STORAGE_RESERVE_MULTIPLIER', 1.5)),
    dryRun: policy.dryRun != null ? Boolean(policy.dryRun) : envBool('PACKET_STORAGE_CLEANUP_DRY_RUN', false),
  };
}

async function getDiskUsage(targetDir) {
  const resolvedDir = path.resolve(targetDir || defaultDownloadDir());
  if (process.platform === 'win32') return getDiskUsageWindows(resolvedDir);
  const result = await runCommand('df', ['-Pk', resolvedDir], { timeoutMs: 10000 });
  if (!result.ok) return null;
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const parts = lines[lines.length - 1].trim().split(/\s+/);
  if (parts.length < 6) return null;
  const totalBytes = Number(parts[1]) * 1024;
  const usedBytes = Number(parts[2]) * 1024;
  const freeBytes = Number(parts[3]) * 1024;
  const usedPercent = Number(String(parts[4]).replace('%', ''));
  if (![totalBytes, usedBytes, freeBytes, usedPercent].every(Number.isFinite)) return null;
  return {
    path: resolvedDir,
    totalBytes,
    usedBytes,
    freeBytes,
    usedPercent,
    source: 'df',
  };
}

function getDiskUsageWindows(targetDir) {
  try {
    const root = path.parse(path.resolve(targetDir)).root;
    const output = require('child_process').execFileSync('wmic', ['logicaldisk', 'get', 'size,freespace,caption'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const drive = root.replace(/\\$/, '').toUpperCase();
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines.slice(1)) {
      const parts = line.split(/\s+/);
      if (parts[0].toUpperCase() !== drive) continue;
      const freeBytes = Number(parts[1]);
      const totalBytes = Number(parts[2]);
      if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
      const usedBytes = totalBytes - freeBytes;
      return {
        path: path.resolve(targetDir),
        totalBytes,
        usedBytes,
        freeBytes,
        usedPercent: (usedBytes / totalBytes) * 100,
        source: 'wmic',
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function cleanupArtifactsByWatermark(downloadDir, options = {}) {
  const baseDir = path.resolve(downloadDir || defaultDownloadDir());
  const targetPercent = Number(options.targetPercent ?? envNumber('PACKET_STORAGE_TARGET_PERCENT', 70));
  const dryRun = Boolean(options.dryRun);
  const getDiskUsageFn = options.getDiskUsageFn || getDiskUsage;
  const result = {
    triggered: true,
    deletedFiles: 0,
    deletedDirs: 0,
    deletedBytes: 0,
    errors: [],
  };
  const artifacts = await listManagedPacketArtifacts(baseDir);

  for (const artifact of artifacts) {
    const usage = await getDiskUsageFn(baseDir);
    if (usage && usage.usedPercent <= targetPercent) break;
    const payloadResult = await deletePacketPayloadFiles(artifact.dir, { dryRun });
    result.deletedFiles += payloadResult.deletedFiles;
    result.deletedBytes += payloadResult.deletedBytes;
    result.errors.push(...payloadResult.errors);
  }

  for (const artifact of artifacts) {
    const usage = await getDiskUsageFn(baseDir);
    if (usage && usage.usedPercent <= targetPercent) break;
    const dirSize = await safePathSize(artifact.dir);
    try {
      if (!dryRun) await fsp.rm(artifact.dir, { recursive: true, force: true });
      result.deletedDirs += 1;
      result.deletedBytes += dirSize;
    } catch (error) {
      result.errors.push({ path: artifact.dir, message: error.message });
    }
  }

  return result;
}

async function listManagedPacketArtifacts(downloadDir) {
  const baseDir = path.resolve(downloadDir || defaultDownloadDir());
  if (!fs.existsSync(baseDir)) return [];
  const entries = await fsp.readdir(baseDir, { withFileTypes: true });
  const artifacts = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(baseDir, entry.name);
    const marker = path.join(dir, '.packet-artifact');
    if (!fs.existsSync(marker)) continue;
    const stat = await fsp.stat(dir);
    const metadata = await readArtifactMetadata(dir);
    artifacts.push({
      dir,
      marker,
      createdAtMs: metadata.createdAtMs || stat.mtimeMs,
      downloadedAtMs: metadata.downloadedAtMs,
      mtimeMs: stat.mtimeMs,
    });
  }
  return artifacts.sort((a, b) => (a.downloadedAtMs || a.createdAtMs || a.mtimeMs) - (b.downloadedAtMs || b.createdAtMs || b.mtimeMs));
}

async function readArtifactMetadata(artifactDir) {
  const metadata = {};
  try {
    const marker = JSON.parse(await fsp.readFile(path.join(artifactDir, '.packet-artifact'), 'utf8'));
    const createdAt = Date.parse(marker.createdAt);
    if (Number.isFinite(createdAt)) metadata.createdAtMs = createdAt;
  } catch {
    // Ignore malformed marker metadata; mtime fallback keeps cleanup deterministic.
  }
  try {
    const downloadMeta = JSON.parse(await fsp.readFile(path.join(artifactDir, 'download.meta.json'), 'utf8'));
    const downloadedAt = Date.parse(downloadMeta.downloadedAt);
    if (Number.isFinite(downloadedAt)) metadata.downloadedAtMs = downloadedAt;
  } catch {
    // download.meta.json may not exist for failed or partial tasks.
  }
  return metadata;
}

async function deletePacketPayloadFiles(artifactDir, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const result = {
    deletedFiles: 0,
    deletedBytes: 0,
    errors: [],
  };
  if (!fs.existsSync(path.join(artifactDir, '.packet-artifact'))) return result;
  const files = await listFilesRecursive(artifactDir);
  for (const filePath of files) {
    if (!PACKET_PAYLOAD_EXTENSIONS.has(path.extname(filePath).toLowerCase())) continue;
    try {
      const stat = await fsp.stat(filePath);
      if (!dryRun) await fsp.rm(filePath, { force: true });
      result.deletedFiles += 1;
      result.deletedBytes += stat.size;
    } catch (error) {
      result.errors.push({ path: filePath, message: error.message });
    }
  }
  return result;
}

async function listFilesRecursive(dir) {
  const output = [];
  if (!fs.existsSync(dir)) return output;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await listFilesRecursive(fullPath));
    else if (entry.isFile()) output.push(fullPath);
  }
  return output;
}

async function safePathSize(targetPath) {
  if (!fs.existsSync(targetPath)) return 0;
  const stat = await fsp.stat(targetPath);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  const entries = await fsp.readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    total += await safePathSize(path.join(targetPath, entry.name));
  }
  return total;
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
  if (result.businessResolution && result.businessResolution.ok && !result.businessResolution.previewOnly) {
    highlights.push(`业务数据包实例已解析：pageFamilyId=${result.businessResolution.pageFamilyId}，pageFamilyDetailId=${result.businessResolution.pageFamilyDetailId}`);
  }
  if (result.businessResolution && result.businessResolution.previewOnly && result.businessResolution.pageViewsPreview) {
    const preview = result.businessResolution.pageViewsPreview;
    const ips = (preview.uniqueClientIps || []).slice(0, 5).join('、') || '无';
    highlights.push(`业务页面访问明细预览：${preview.rowCount} 条，可选对端 IP：${ips}。`);
  }
  if (result.explanation) highlights.push(result.explanation.meaning);
  if (result.preview) highlights.push(formatPreviewSummary(result.preview));
  if (result.download && result.download.ok) highlights.push(`下载完成：${result.download.fileName}，${result.download.bytes} bytes。`);
  if (result.download && result.download.storage && result.download.storage.decision && !result.download.storage.decision.allowed) {
    highlights.push(`存储预检未通过：${result.download.storage.decision.message}`);
  }
  if (result.analysis && result.analysis.ok) {
    const packetCount = result.analysis.capinfos && (result.analysis.capinfos.number_of_packets || result.analysis.capinfos.packet_count);
    highlights.push(packetCount ? `tshark/capinfos 分析完成，包数：${packetCount}。` : 'tshark/capinfos 分析完成。');
  }
  if (result.error) highlights.push(result.error.message);
  const waitingDecision = result.decision && ['CONFIRM_DOWNLOAD', 'SUGGEST_NARROW_TIME_RANGE'].includes(result.decision.next_action);
  return {
    title: result.ok ? '数据包任务完成' : waitingDecision ? '数据包任务等待确认' : '数据包任务失败',
    highlights,
  };
}

function buildNarrationInput(result) {
  // 从 analysis.alertContext 提取告警叙述指令，注入 renderPolicy
  const alertContext = result.analysis && result.analysis.alertContext;
  const alertRenderHint = alertContext && alertContext.hasTriggerMetrics
    ? buildAlertRenderHint(alertContext)
    : null;

  return {
    schema: 'openclaw_napm_packet_analysis.v1',
    language: 'zh-CN',
    mode: result.mode,
    ok: result.ok,
    criteria: result.criteria,
    businessResolution: result.businessResolution ? summarizeBusinessResolution(result.businessResolution) : null,
    urls: result.urls,
    preview: summarizePreview(result.preview),
    download: result.download ? {
      ok: result.download.ok,
      fileName: result.download.fileName,
      filePath: result.download.filePath,
      bytes: result.download.bytes,
      contentType: result.download.contentType,
      urlMasked: result.download.urlMasked,
      storage: result.download.storage,
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
      // 告警聚焦叙述指令：当 analysis.alertContext 存在时，
      // AI 必须围绕告警触发指标展开数据包分析报告，而非只输出泛化协议分布。
      alertRenderHint,
    },
  };
}

/**
 * 根据告警上下文构建 AI 层的叙述聚焦指令。
 *
 * 当 packet-analysis 被 alert-query 通过 suggestedPacketQuery 调用时，
 * alertContext 中包含了告警触发指标（metrics / values / condition 等）。
 * 此函数生成一条明确的指令，告诉 AI：数据包报告必须聚焦于解释
 * "为什么这些告警指标异常"，要把 tshark 分析结果（重传、延迟、会话）
 * 与告警触发条件关联起来。
 */
function buildAlertRenderHint(alertContext = {}) {
  const metricText = (alertContext.metricLabels || []).join('、')
    || (alertContext.metrics || []).join('、')
    || '未知指标';
  const valueText = (alertContext.values || []).join('、') || '?';
  const unitText = (alertContext.units || [])[0] || '';

  let hint = '⚠️ 本次数据包分析由告警事件触发，报告必须聚焦于告警根因：\n';
  hint += `触发指标: ${metricText} = ${valueText}${unitText}\n`;
  if (alertContext.condition) {
    hint += `触发条件: ${alertContext.condition}\n`;
  }
  if (alertContext.severity) {
    hint += `告警级别: ${alertContext.severity}\n`;
  }
  hint += '\n';
  hint += 'AI 叙述要求（必须遵循）：\n';
  hint += `1. 结合 tshark 分析结果（TCP 重传率、RTT 延迟、连接失败、HTTP 状态码等），解释为什么 ${metricText} 达到 ${valueText}${unitText}\n`;
  hint += '2. 找出数据包中导致指标异常的具体 IP 会话和时间点\n';
  hint += '3. 将数据包时间线与告警触发时刻关联，给出根因结论\n';
  hint += '4. 不要只输出泛化的协议分布统计——每一个发现都要与告警指标关联\n';

  if (alertContext.instruction) {
    hint += `\n补充指令: ${alertContext.instruction}`;
  }

  return hint;
}

function summarizeBusinessResolution(businessResolution) {
  if (!businessResolution) return null;
  return {
    ok: businessResolution.ok,
    previewOnly: businessResolution.previewOnly || false,
    businessName: businessResolution.businessName,
    pageFamilyId: businessResolution.pageFamilyId,
    pageFamilyDetailId: businessResolution.pageFamilyDetailId,
    instanceId: businessResolution.instanceId,
    pageViewsPreview: businessResolution.pageViewsPreview || null,
    steps: Array.isArray(businessResolution.steps)
      ? businessResolution.steps.map((step) => ({
        name: step.name,
        ok: step.ok,
        rowCount: step.rowCount,
        url: step.url,
        selectedBusiness: step.selectedBusiness,
        selectedPageFamilyId: step.selectedPageFamilyId,
        selectedPageFamilyLabel: step.selectedPageFamilyLabel,
        selectedPageFamilyDetailId: step.selectedPageFamilyDetailId,
        selectedClientIp: step.selectedClientIp,
        selectedHttpStatus: step.selectedHttpStatus,
        previewRows: step.previewRows,
      }))
      : [],
    error: businessResolution.error,
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
    responseBytes: preview.responseBytes,
    overview: preview.overview,
    risk: preview.risk,
    urlMasked: preview.urlMasked,
    error: preview.error,
  };
}

function formatPreviewSummary(preview) {
  if (preview.empty) return '预览结果为空。';
  const overview = preview.overview || {};
  const risk = preview.risk || {};
  const packetText = overview.packetCount != null ? `${formatInteger(overview.packetCount)} 个包` : '包数未知';
  const sizeText = overview.estimatedBytes != null ? overview.estimatedSizeText || formatBytes(overview.estimatedBytes) : '大小未知';
  if (risk.level) {
    return `预览结果：${packetText}，预计 ${sizeText}，风险等级 ${risk.level}。`;
  }
  return '预览接口返回了数据。';
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
    // 告警触发指标上下文：透传给 AI 层的 narrationInput，
    // 确保数据包分析报告围绕告警根因展开，而非只做泛化的协议描述。
    alertContext: analysis.alertContext || null,
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
  const alertContext = buildAlertAnalysisContext(options);
  return {
    level: options.level || 'summary',
    includeDns: options.includeDns !== false,
    includeHttp: options.includeHttp !== false,
    includeTls: options.includeTls !== false,
    includePorts: options.includePorts !== false,
    timeoutMs: Number(options.timeoutMs || process.env.PACKET_ANALYSIS_TIMEOUT_MS || 60000),
    // 告警上下文：从 alert-query 的 suggestedPacketQuery.analysis 透传过来，
    // 用于在数据包分析报告中聚焦解释告警触发指标的根因。
    alertContext,
  };
}

/**
 * 从 analysis options 中提取告警触发指标上下文。
 *
 * 当调用方是 openclaw-napm-alert-query（通过 suggestedPacketQuery.analysis），
 * 会传入 hasTriggerMetrics / metrics / metricLabels / values / units /
 * condition / severity / summary / instruction 等字段。
 * 这些字段不控制 tshark 行为，但必须在 narrationInput 中透传给 AI 层，
 * 确保 AI 生成的数据包分析报告围绕告警触发指标展开，而非泛泛描述协议分布。
 */
function buildAlertAnalysisContext(options = {}) {
  if (!options.hasTriggerMetrics) {
    return {
      hasTriggerMetrics: false,
      note: options.note || '该查询未携带告警触发指标上下文。',
    };
  }

  return {
    hasTriggerMetrics: true,
    metrics: Array.isArray(options.metrics) ? options.metrics : [],
    metricLabels: Array.isArray(options.metricLabels) ? options.metricLabels : [],
    values: Array.isArray(options.values) ? options.values : [],
    units: Array.isArray(options.units) ? options.units : [],
    condition: options.condition || null,
    severity: options.severity || null,
    summary: options.summary || null,
    instruction: options.instruction || null,
  };
}

function normalizeFilePolicy(policy = {}) {
  return {
    downloadDir: policy.downloadDir || process.env.PACKET_DOWNLOAD_DIR || defaultDownloadDir(),
    maxBytes: Number(policy.maxBytes || process.env.PACKET_MAX_BYTES || 524288000),
    keepFiles: policy.keepFiles != null ? Boolean(policy.keepFiles) : envBool('PACKET_KEEP_FILES', true),
    retentionHours: Number(policy.retentionHours || process.env.PACKET_RETENTION_HOURS || 24),
    requirePreviewBeforeDownload: policy.requirePreviewBeforeDownload != null
      ? Boolean(policy.requirePreviewBeforeDownload)
      : envBool('PACKET_REQUIRE_PREVIEW_BEFORE_DOWNLOAD', true),
    storagePolicy: normalizeStoragePolicy(policy.storagePolicy || {}),
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

function envNumber(name, defaultValue) {
  const value = process.env[name];
  if (value == null || value === '') return defaultValue;
  const number = Number(value);
  return Number.isFinite(number) ? number : defaultValue;
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

/**
 * 加载 .env 文件，按优先级依次尝试多个路径。
 * 参照 alert-query 的 loadDotEnvCandidates 模式，
 * 确保无论 gateway 以什么 cwd 启动都能找到 workspace 根目录的 .env。
 */
function loadDotEnvCandidates(filePaths = []) {
  for (const filePath of filePaths.filter(Boolean)) {
    loadDotEnv(filePath);
  }
}

/**
 * Plugin 通过 require() 同进程调用的入口。
 * params 已经是 JavaScript 对象（buildPacketExecutorPayload 的产出），
 * 无需 CLI 参数解析。
 */
async function handleSkillCall(params = {}) {
  try {
    loadDotEnvCandidates([
      path.join(workspaceRoot, '.env'),
      path.join(process.cwd(), '.env'),
      process.env.OPENCLAW_HOME ? path.join(process.env.OPENCLAW_HOME, '.env') : null,
      process.env.HOME ? path.join(process.env.HOME, '.openclaw', '.env') : null,
    ]);

    const query = params;
    const startedAt = new Date().toISOString();

    const resolved = resolveQuery(query);
    if (!resolved.ok) {
      return {
        ok: false,
        mode: query.mode || DEFAULT_MODE,
        startedAt,
        criteria: query.criteria || null,
        urls: {},
        explanation: null,
        preview: null,
        download: null,
        analysis: null,
        businessResolution: null,
        error: resolved.error,
        decision: { next_action: 'CLARIFICATION_REQUIRED' },
        summary: {
          title: '数据包任务缺少必要条件',
          highlights: [resolved.error.message],
        },
      };
    }

    const task = resolved.task;

    // Business packet instance resolution
    if (task.needsBusinessInstanceResolution) {
      const businessResolution = await resolveBusinessPacketInstance(task);
      task.businessResolution = businessResolution;
      if (businessResolution.previewOnly) {
        const result = buildPacketResult(task, startedAt, {
          businessResolution,
          ok: businessResolution.ok,
          error: businessResolution.ok ? null : businessResolution.error,
          decision: businessResolution.ok
            ? { next_action: 'SELECT_PAGE_VIEW', reason: 'BUSINESS_PAGE_VIEWS_PREVIEW_READY',
                message: '请选择一个页面访问明细的 clientIp 或 pageViewIndex，再继续构造或下载业务数据包。' }
            : { next_action: 'CLARIFICATION_REQUIRED',
                reason: businessResolution.error?.code,
                message: businessResolution.error?.message },
        });
        result.summary = buildSummary(result);
        result.narrationInput = buildNarrationInput(result);
        return result;
      }
      if (!businessResolution.ok) {
        const result = buildPacketResult(task, startedAt, {
          businessResolution,
          ok: false,
          error: businessResolution.error,
          decision: { next_action: 'CLARIFICATION_REQUIRED',
            reason: businessResolution.error?.code,
            message: businessResolution.error?.message },
        });
        result.summary = { title: '业务数据包实例解析失败',
          highlights: [businessResolution.error?.message].filter(Boolean) };
        return result;
      }
      task.criteria = { ...task.criteria, ...businessResolution.criteriaPatch };
      task.urls = buildUrls({ host: task.host, criteria: task.criteria,
        downloadType: task.downloadType, showFullUrls: task.showFullUrls });
    }

    // Execute the task (same branching as main())
    return await executePacketTask(task, startedAt);
  } catch (error) {
    return failureResult('PACKET_RUNTIME_ERROR', error.message || String(error), { stack: error.stack });
  }
}

function buildPacketResult(task, startedAt, overrides = {}) {
  return {
    ok: true,
    mode: task.mode,
    downloadType: task.downloadType,
    startedAt,
    criteria: task.criteria,
    urls: publicUrls(task.urls || {}),
    explanation: null,
    preview: null,
    download: null,
    analysis: null,
    businessResolution: task.businessResolution || null,
    error: null,
    decision: null,
    ...overrides,
  };
}

async function executePacketTask(task, startedAt) {
  const result = buildPacketResult(task, startedAt);

  if (task.mode === 'explain_url') {
    result.explanation = explainUrl(task.url);
    result.summary = buildSummary(result);
    result.narrationInput = buildNarrationInput(result);
    return result;
  }

  if (task.mode === 'build_url_only') {
    result.summary = buildSummary(result);
    result.narrationInput = buildNarrationInput(result);
    return result;
  }

  if (PREVIEW_MODES.has(task.mode) && task.urls.previewRaw) {
    result.preview = await requestPreview(task);
    task.preview = result.preview;
    if (!result.preview.ok || result.preview.empty) {
      result.ok = false;
      result.error = result.preview.error || { code: 'PACKET_PREVIEW_EMPTY', message: 'packetsPreview 未返回可下载数据。' };
      result.decision = { next_action: 'NO_DOWNLOAD', reason: result.error.code,
        message: '预览接口没有发现可下载数据包，因此没有发起下载请求。' };
      result.summary = buildSummary(result);
      result.narrationInput = buildNarrationInput(result);
      return result;
    }
    if (DOWNLOAD_MODES.has(task.mode) && applyPreviewRiskGate(result, task)) {
      result.summary = buildSummary(result);
      result.narrationInput = buildNarrationInput(result);
      return result;
    }
  } else if (PREVIEW_MODES.has(task.mode) && task.downloadType !== 'DownServlet') {
    result.ok = false;
    result.error = { code: 'PACKET_PREVIEW_UNSUPPORTED', message: '当前数据包任务没有可用的 packetsPreview URL。' };
    result.summary = buildSummary(result);
    result.narrationInput = buildNarrationInput(result);
    return result;
  }

  if (DOWNLOAD_MODES.has(task.mode)) {
    if (shouldPreviewBeforeDownload(task) && !result.preview) {
      result.preview = await requestPreview(task);
      task.preview = result.preview;
      if (!result.preview.ok || result.preview.empty) {
        result.ok = false;
        result.error = result.preview.error || { code: 'PACKET_PREVIEW_EMPTY', message: 'packetsPreview 未返回可下载数据。' };
        result.decision = { next_action: 'NO_DOWNLOAD', reason: result.error.code,
          message: '预览接口没有发现可下载数据包，因此没有发起下载请求。' };
        result.summary = buildSummary(result);
        result.narrationInput = buildNarrationInput(result);
        return result;
      }
      if (applyPreviewRiskGate(result, task)) {
        result.summary = buildSummary(result);
        result.narrationInput = buildNarrationInput(result);
        return result;
      }
    }

    result.download = await downloadPacket(task);
    if (!result.download.ok) {
      result.ok = false;
      result.error = result.download.error;
      result.summary = buildSummary(result);
      result.narrationInput = buildNarrationInput(result);
      return result;
    }
  }

  if (ANALYZE_MODES.has(task.mode)) {
    const filePath = task.mode === 'analyze_file' ? task.file : result.download?.filePath;
    if (!filePath) {
      result.ok = false;
      result.error = { code: 'PACKET_FILE_REQUIRED', message: '分析模式需要本地 packet 文件路径，或先完成下载。' };
    } else {
      result.analysis = await analyzePacketFile(filePath, task.analysis);
      if (!result.analysis.ok) {
        result.ok = false;
        result.error = result.analysis.error;
      }
      if (result.download?.artifactDir) {
        await writeArtifactJson(result.download.artifactDir, 'analysis.json', result.analysis);
      }
      await removeDownloadedFileAfterAnalysisIfNeeded(result, task);
    }
  }

  result.summary = buildSummary(result);
  result.narrationInput = buildNarrationInput(result);
  return result;
}

module.exports = {
  handleSkillCall,
  resolveQuery,
  normalizeCriteria,
  validateCriteria,
  buildUrls,
  buildBusinessTopValuesUrl,
  buildPageFamilyTopValuesUrl,
  buildPageViewsUrl,
  buildPageViewsPreview,
  shouldResolveBusinessPacketInstance,
  extractBusinessName,
  extractPageFamilyId,
  extractPageFamilyLabel,
  extractPageFamilyDetailId,
  extractDetailIdFromText,
  normalizeInstanceId,
  normalizeRowsFromPayload,
  normalizePreviewOverview,
  assessPacketDownloadRisk,
  extractNumericByCandidateKeys,
  normalizeSizeBytes,
  formatBytes,
  normalizeStoragePolicy,
  preflightStorageForDownload,
  buildStorageDecision,
  cleanupArtifactsByWatermark,
  listManagedPacketArtifacts,
  deletePacketPayloadFiles,
  safePathSize,
  selectBusinessRow,
  selectPageFamilyRow,
  selectPageViewRow,
  normalizeMetricList,
};
