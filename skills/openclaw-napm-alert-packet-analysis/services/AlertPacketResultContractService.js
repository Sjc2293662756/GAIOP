'use strict';

class AlertPacketResultContractService {
  buildSuccess({ input, alertResult, packetAnalyses, detailAttempts, selectedCandidateId = null }) {
    const failedCount = packetAnalyses.filter((item) => !item.ok).length;
    const confirmationCount = packetAnalyses.filter(isDownloadConfirmationRequired).length;
    const workflowState = failedCount === 0
      ? 'COMPLETED'
      : (confirmationCount === packetAnalyses.length
        ? 'DOWNLOAD_CONFIRMATION_REQUIRED'
        : (failedCount < packetAnalyses.length ? 'PARTIAL_PACKET_ANALYSIS' : 'PACKET_ANALYSIS_FAILED'));
    const ok = workflowState === 'COMPLETED';
    const result = {
      ok,
      workflowType: 'alert_packet_analysis',
      workflowState,
      eventId: input.eventId,
      timeRange: { start: input.start, end: input.end },
      triggerMetrics: input.triggerMetrics,
      referenceId: input.referenceId || null,
      candidateId: selectedCandidateId || input.candidateId || null,
      analyzeAllCandidates: Boolean(input.analyzeAllCandidates),
      detailAttempts,
      alert: alertResult,
      packetAnalyses,
      error: ok ? null : {
        code: workflowState,
        message: workflowState === 'DOWNLOAD_CONFIRMATION_REQUIRED'
          ? '数据包预览完成，下载前需要用户确认。'
          : workflowState === 'PARTIAL_PACKET_ANALYSIS'
            ? '部分数据包候选分析失败，已保留成功结果。'
            : '数据包候选分析均未成功。'
      }
    };
    if (workflowState === 'DOWNLOAD_CONFIRMATION_REQUIRED') {
      result.decision = {
        next_action: 'CONFIRM_DOWNLOAD',
        message: '请回复“开始分析”或“确认下载”继续数据包分析。'
      };
    }
    result.narrationInput = this.buildNarrationInput(result);
    return result;
  }

  buildCandidateSelection({ input, alertResult, detailAttempts, candidates = [] }) {
    const result = {
      ok: true,
      workflowType: 'alert_packet_analysis',
      workflowState: 'CANDIDATE_SELECTION_REQUIRED',
      eventId: input.eventId,
      referenceId: input.referenceId || null,
      timeRange: { start: input.start, end: input.end },
      triggerMetrics: input.triggerMetrics,
      analyzeAllCandidates: Boolean(input.analyzeAllCandidates),
      detailAttempts,
      alert: alertResult,
      candidateOptions: candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        rank: candidate.rank || null,
        ip: candidate.ip || null,
        ips: candidate.ips || [],
        ipPair: candidate.ipPair || null,
        metricValue: candidate.metricValue || null,
      })),
      packetAnalyses: [],
      error: {
        code: 'CANDIDATE_SELECTION_REQUIRED',
        message: '该告警关联多个数据包候选，请先选择一个候选分件号。',
      },
    };
    result.narrationInput = this.buildNarrationInput(result);
    return result;
  }

  buildFailure({ input = {}, workflowState, message, detailAttempts = 0, alertResult = null, error = null, errorCode = null }) {
    const result = {
      ok: false,
      workflowType: 'alert_packet_analysis',
      workflowState,
      eventId: input.eventId || null,
      timeRange: input.start && input.end ? { start: input.start, end: input.end } : null,
      triggerMetrics: input.triggerMetrics || null,
      referenceId: input.referenceId || null,
      candidateId: input.candidateId || null,
      analyzeAllCandidates: Boolean(input.analyzeAllCandidates),
      detailAttempts,
      alert: alertResult,
      packetAnalyses: [],
      error: {
        code: errorCode || workflowState,
        message: String(message || '告警数据包分析工作流执行失败。'),
        causeCode: error?.code || null
      }
    };
    result.narrationInput = this.buildNarrationInput(result);
    return result;
  }

  buildNarrationInput(result) {
    return {
      schema: 'openclaw_napm_alert_packet_analysis.v1',
      language: 'zh-CN',
      workflowState: result.workflowState,
      ok: result.ok,
      eventId: result.eventId,
      timeRange: result.timeRange,
      triggerMetrics: result.triggerMetrics,
      referenceId: result.referenceId || null,
      candidateId: result.candidateId || null,
      analyzeAllCandidates: Boolean(result.analyzeAllCandidates),
      candidateOptions: result.candidateOptions || [],
      detailAttempts: result.detailAttempts,
      alert: result.alert,
      packetAnalyses: result.packetAnalyses,
      error: result.error,
      decision: result.decision || null,
      renderPolicy: {
        target: 'final_user_reply',
        requirePacketEvidence: true,
        includeInternalWorkflow: false
      }
    };
  }
}

function isDownloadConfirmationRequired(item = {}) {
  const result = item?.result || {};
  const code = String(item?.error?.code || result?.error?.code || '').trim().toUpperCase();
  const nextAction = String(item?.decision?.next_action || result?.decision?.next_action || '').trim().toUpperCase();
  return code === 'PACKET_PREVIEW_REQUIRES_CONFIRMATION'
    || code === 'DOWNLOAD_CONFIRMATION_REQUIRED'
    || nextAction === 'CONFIRM_DOWNLOAD';
}

AlertPacketResultContractService.isDownloadConfirmationRequired = isDownloadConfirmationRequired;

module.exports = AlertPacketResultContractService;
