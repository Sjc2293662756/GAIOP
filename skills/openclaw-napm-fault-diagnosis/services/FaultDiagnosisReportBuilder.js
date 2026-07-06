'use strict';

/**
 * Fault diagnosis report builder.
 *
 * Converts a diagnostic session (completedSteps + context) into
 * the structured reportData consumable by openclaw-napm-report.
 *
 * Report structure follows company §8:
 *  封面 → 1.基本信息 → 2.分析过程 → 3.证据项 → 4.根因判断 → 5.处置建议 → 6.验证方式
 */

// ── helpers ─────────────────────────────────────────────────────────

function isPlainObject(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function valueOrDash(v) {
  const t = String(v ?? '').trim();
  return t || '-';
}

// ── Step description templates ──────────────────────────────────────

const STEP_LABELS = {
  // Network slow
  step1_traffic_trend: '第一步：查看总流量趋势',
  step2_top_objects: '第二步：定位 Top 对象',
  step3_network_quality: '第三步：查看网络质量指标',
  step4_connection_failure: '第四步：检查连接失败和异常主机',
  // B/S App slow
  step1_4xx_5xx_overview: '第一步：查询业务 4xx/5xx 报错情况',
  step2_page_error_analysis: '第二步：页面错误分析（按访问数排序 Top 20）',
  step3_page_status_detail: '第三步：页面状态码详情分析',
  // C/S App slow
  step1_app_overview: '第一步：查看应用运行状况',
  step2_time_breakdown: '第二步：拆分用户体验耗时'
};

const FLOW_LABELS = {
  network_slow: '网络慢/网络运行异常',
  bs_app_slow: 'B/S 架构业务慢',
  cs_app_slow: 'C/S 架构应用慢'
};

// ── Builder ─────────────────────────────────────────────────────────

class FaultDiagnosisReportBuilder {

  /**
   * Build reportData from a completed diagnostic session.
   *
   * @param {object} session — FaultDiagnosisService session with completedSteps
   * @param {object} options — overrides: title, format, systemName
   */
  build(session = {}, options = {}) {
    const flowType = session.flowType || 'network_slow';
    const flowLabel = FLOW_LABELS[flowType] || flowType;
    const steps = asArray(session.completedSteps);
    const faultInput = isPlainObject(session.faultInput) ? session.faultInput : {};

    const faultName = faultInput.description
      || session.description
      || options.faultName
      || '未命名故障';

    const title = options.title || `${faultName}_故障分析报告`;

    // Build sections
    const sections = [];

    // Section 1: 基本信息
    sections.push({
      type: 'summary',
      title: '1 基本信息',
      content: this._buildBasicInfo(session, flowLabel)
    });

    // Section 2: 分析过程 (dynamic — one sub-section per step)
    sections.push({
      type: 'summary',
      title: '2 分析过程',
      content: `分析类型：${flowLabel}\n共执行 ${steps.length} 个分析步骤。`
    });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepLabel = STEP_LABELS[step.stepId] || step.stepId;
      sections.push({
        type: 'summary',
        title: `2.${i + 1} ${stepLabel}`,
        content: this._buildStepContent(step, i + 1)
      });

      // Add hints as a sub-section
      const hints = asArray(step.hints);
      if (hints.length > 0) {
        const judgmentHints = hints.filter((h) => h.type === 'judgment').map((h) => h.text);
        const packetTriggers = hints.filter((h) => h.type === 'packet_trigger').map((h) => h.text);

        if (judgmentHints.length > 0) {
          sections.push({
            type: 'items',
            title: `判断提示`,
            items: judgmentHints
          });
        }
        if (packetTriggers.length > 0) {
          sections.push({
            type: 'items',
            title: '数据包触发条件',
            items: ['⚠ 以下条件已触发，建议下载数据包进行深入验证：', ...packetTriggers]
          });
        }
      }

      // Add user judgment if present
      if (step.userJudgment) {
        sections.push({
          type: 'summary',
          title: '用户判断',
          content: step.userJudgment
        });
      }

      // Add data tables if rawData contains presentable data
      const dataSections = this._buildDataSection(step);
      sections.push(...dataSections);
    }

    // Section 3: 证据项 (conditional)
    const evidenceSections = this._buildEvidence(steps);
    if (evidenceSections.length > 0) {
      sections.push({
        type: 'summary',
        title: '3 证据项',
        content: '以下为本次故障分析过程中产生的关键证据。'
      });
      sections.push(...evidenceSections);
    }

    // Section 4: 根因判断
    sections.push({
      type: 'summary',
      title: '4 根因判断',
      content: this._buildRootCause(steps, faultInput)
    });

    // Section 5: 处置建议
    const recommendations = asArray(faultInput.recommendations);
    sections.push({
      type: 'items',
      title: '5 处置建议',
      items: recommendations.length > 0
        ? recommendations
        : ['建议结合以上各维度数据进行综合分析', '必要时进行抓包复现']
    });

    // Section 6: 验证方式
    const prevention = asArray(faultInput.prevention);
    sections.push({
      type: 'items',
      title: '6 验证方式',
      items: prevention.length > 0
        ? prevention
        : ['处置后在相同路径/对象/端口下重新验证', '确认异常指标是否恢复正常']
    });

    return {
      schema: 'openclaw_napm_report_data.v1',
      reportType: 'diagnostic_report',
      templateId: 'napm_fault_diagnosis_v2',
      format: options.format || 'docx',
      title,
      systemName: options.systemName || 'Netlnside基于AI的全流量性能分析平台',
      faultName,
      sourceQuestion: options.sourceQuestion || undefined,
      timeRange: {
        start: session.context?.faultStart,
        end: session.context?.faultEnd,
        displayText: session.timeRange?.displayText || '',
        baselineStart: session.context?.baselineStart,
        baselineEnd: session.context?.baselineEnd
      },
      dataSource: {
        system: options.systemName || 'Netlnside基于AI的全流量性能分析平台',
        sourceSkill: 'openclaw-napm-fault-diagnosis',
        queryService: `faultDiagnosis:${flowType}`
      },
      fault: faultInput,
      diagnosisReport: {
        flowType,
        flowLabel,
        stepCount: steps.length
      },
      sections,
      audit: {
        sourceSkill: 'openclaw-napm-fault-diagnosis',
        flowType,
        totalSteps: steps.length,
        stepIds: steps.map((s) => s.stepId)
      }
    };
  }

  // ── Private builders ──────────────────────────────────────────

  _buildBasicInfo(session, flowLabel) {
    const ctx = session.context || {};
    const target = ctx.target || {};

    const lines = [];
    lines.push(`故障名称：${session.description || '未命名故障'}`);
    lines.push(`分析类型：${flowLabel}`);
    lines.push(`分析时间范围：${session.timeRange?.displayText || '-'}`);

    if (target.groupType && target.groupArgument) {
      lines.push(`分析对象：${target.groupLabel || target.groupArgument}（${target.groupType}）`);
    }

    const faultInput = session.faultInput || {};
    if (faultInput.severity) {
      const severityMap = { critical: '紧急', major: '重大', minor: '轻微' };
      lines.push(`故障级别：${severityMap[faultInput.severity] || faultInput.severity}`);
    }
    if (faultInput.affectedObjects && asArray(faultInput.affectedObjects).length > 0) {
      lines.push(`受影响对象：${asArray(faultInput.affectedObjects).join('、')}`);
    }

    lines.push(`执行步骤数：${asArray(session.completedSteps).length}`);

    return lines.join('\n');
  }

  _buildStepContent(step, index) {
    const lines = [];
    const stepLabel = STEP_LABELS[step.stepId] || step.stepId;
    lines.push(`步骤 ${index}：${stepLabel}`);
    lines.push(`查询时间：${new Date().toISOString()}`);

    // List query labels
    const rawData = isPlainObject(step.rawData) ? step.rawData : {};
    const queryLabels = Object.keys(rawData).filter((k) => rawData[k] !== null);
    if (queryLabels.length > 0) {
      lines.push(`已执行查询：${queryLabels.join('、')}`);
    } else {
      lines.push('已执行查询：无');
    }

    return lines.join('\n');
  }

  _buildDataSection(step) {
    const sections = [];
    const rawData = isPlainObject(step.rawData) ? step.rawData : {};

    // For each query result, try to build a table if it looks like tabular data
    for (const [label, data] of Object.entries(rawData)) {
      if (!data) continue;

      const tableSection = this._tryBuildTable(label, data);
      if (tableSection) {
        sections.push(tableSection);
      } else {
        // Fallback: render as summary text
        sections.push({
          type: 'summary',
          title: `查询结果: ${label}`,
          content: JSON.stringify(data, null, 2).slice(0, 2000)
        });
      }
    }

    return sections;
  }

  _tryBuildTable(label, data) {
    // NAPM topValues: { topValues: [...] }
    if (isPlainObject(data) && Array.isArray(data.topValues) && data.topValues.length > 0) {
      const items = data.topValues.slice(0, 20).map((item) => {
        const metricValues = asArray(item.metricValues);
        const row = { key: item.key || item.keyLabel || '-' };
        for (const mv of metricValues) {
          row[mv.metric?.id || 'value'] = mv.value ?? '-';
        }
        return row;
      });

      const allKeys = new Set();
      for (const item of items) {
        Object.keys(item).forEach((k) => allKeys.add(k));
      }
      const columns = ['key', ...Array.from(allKeys).filter((k) => k !== 'key')];

      return {
        type: 'table',
        title: `查询结果: ${label}`,
        columns: columns.map((c) => c === 'key' ? '对象' : c),
        rows: items.map((item) => columns.map((c) => item[c] ?? '-'))
      };
    }

    // NAPM timeValues: { metricValues: [...] }
    if (isPlainObject(data) && Array.isArray(data.metricValues) && data.metricValues.length > 0) {
      const firstMV = data.metricValues[0];
      const valCount = Array.isArray(firstMV.values) ? firstMV.values.length : 0;
      if (valCount === 0) return null;

      // Try multiple possible time sources
      const start = Number(data.interval?.start) || Number(data.start) || 0;
      const granularity = Number(data.granularity) || 60;
      const columns = ['时间', ...data.metricValues.map((mv) => mv.metric?.id || 'value')];
      const rows = [];

      for (let i = 0; i < Math.min(valCount, 50); i++) {
        const ts = start > 1000000000
          ? new Date((start + i * granularity) * 1000).toISOString().slice(11, 19)
          : String(i + 1);
        const row = [ts];
        for (const mv of data.metricValues) {
          row.push(Array.isArray(mv.values) ? (mv.values[i] ?? '-') : '-');
        }
        rows.push(row);
      }

      return {
        type: 'table',
        title: `查询结果: ${label}`,
        columns,
        rows
      };
    }

    // NAPM format 3: array of objects with metricValues (no topValues wrapper)
    // e.g. [{ group: {...}, groupPath: "...", metricValues: [...] }]
    if (Array.isArray(data) && data.length > 0 && isPlainObject(data[0])) {
      const firstItem = data[0];
      // Check if this is the metricValues format (not simple key-value objects)
      if (Array.isArray(firstItem.metricValues) && firstItem.metricValues.length > 0) {
        // Flatten each item: extract object label + metric values
        const items = data.slice(0, 50).map((item) => {
          const mvList = asArray(item.metricValues);
          // Resolve label: try keyLabel, key, parse from groupPath, or use group.argument
          let label = item.keyLabel || item.key || '';
          if (!label && item.groupPath) {
            // Extract page name from groupPath: "page 8573230/http://.../geoip/" → "geoip"
            const parts = String(item.groupPath).split('/').filter((s) => s && s !== 'http:' && s !== 'https:');
            const lastSegment = parts[parts.length - 1] || '';
            label = lastSegment || item.group?.argument || '-';
          }
          if (!label) label = item.group?.argument || '-';
          const row = { _label: label };
          for (const mv of mvList) {
            row[mv.metric?.id || 'value'] = mv.value ?? '-';
          }
          return row;
        });

        const allKeys = new Set();
        for (const item of items) {
          Object.keys(item).forEach((k) => allKeys.add(k));
        }
        const sortedKeys = ['_label', ...Array.from(allKeys).filter((k) => k !== '_label').sort()];

        return {
          type: 'table',
          title: `查询结果: ${label}`,
          columns: sortedKeys.map((c) => c === '_label' ? '对象' : c),
          rows: items.map((item) => sortedKeys.map((c) => item[c] ?? '-'))
        };
      }

      // Fallback: simple array of objects without metricValues
      // Exclude the metricValues format we just handled above
      const keys = Object.keys(firstItem);
      return {
        type: 'table',
        title: `查询结果: ${label}`,
        columns: keys,
        rows: data.slice(0, 50).map((item) => keys.map((k) => valueOrDash(item[k])))
      };
    }

    return null;
  }

  _buildEvidence(steps) {
    const evidence = [];

    for (const step of steps) {
      const rawData = isPlainObject(step.rawData) ? step.rawData : {};
      const dataLabels = Object.keys(rawData).filter((k) => rawData[k] !== null);

      if (dataLabels.length > 0) {
        evidence.push({
          stepId: step.stepId,
          stepLabel: STEP_LABELS[step.stepId] || step.stepId,
          queries: dataLabels.join('、')
        });
      }
    }

    if (evidence.length === 0) return [];

    // Build a summary evidence table
    return [{
      type: 'table',
      title: '分析步骤与查询汇总',
      columns: ['步骤', '步骤名称', '执行查询'],
      rows: evidence.map((e, i) => [String(i + 1), e.stepLabel, e.queries])
    }];
  }

  _buildRootCause(steps, faultInput) {
    const lines = [];

    // Count hint types across all steps
    let totalJudgmentHints = 0;
    let totalPacketTriggers = 0;
    const hintTexts = [];

    for (const step of steps) {
      const hints = asArray(step.hints);
      for (const h of hints) {
        if (h.type === 'judgment') {
          totalJudgmentHints++;
          hintTexts.push(h.text);
        } else if (h.type === 'packet_trigger') {
          totalPacketTriggers++;
        }
      }
    }

    lines.push(`基于 ${steps.length} 个分析步骤的证据：`);

    if (hintTexts.length > 0) {
      lines.push('');
      lines.push('系统指标分析发现：');
      for (const h of hintTexts) {
        lines.push(`- ${h}`);
      }
    }

    if (totalPacketTriggers > 0) {
      lines.push('');
      lines.push(`⚠ 共触发 ${totalPacketTriggers} 个数据包分析条件，建议下载数据包进行深入验证。`);
    }

    if (faultInput.severity === 'critical') {
      lines.push('');
      lines.push('综合判断：故障级别为严重，建议立即组织排查。');
    } else if (faultInput.severity === 'major') {
      lines.push('');
      lines.push('综合判断：故障级别为重大，需尽快排查。');
    }

    if (hintTexts.length === 0) {
      lines.push('');
      lines.push('建议结合以上各维度数据进一步分析，必要时进行抓包复现。');
    }

    return lines.join('\n');
  }
}

module.exports = FaultDiagnosisReportBuilder;
module.exports.__test__ = { STEP_LABELS, FLOW_LABELS };
