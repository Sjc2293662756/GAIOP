'use strict';

class AlertPacketResultContractService {
  buildSuccess({ input, alertResult, packetAnalyses, detailAttempts, selectedCandidateId = null }) {
    const failedCount = packetAnalyses.filter((item) => !item.ok).length;
    const workflowState = failedCount === 0
      ? 'COMPLETED'
      : (failedCount < packetAnalyses.length ? 'PARTIAL_PACKET_ANALYSIS' : 'PACKET_ANALYSIS_FAILED');
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
      detailAttempts,
      alert: alertResult,
      packetAnalyses,
      error: ok ? null : {
        code: workflowState,
        message: workflowState === 'PARTIAL_PACKET_ANALYSIS'
          ? '部分数据包候选分析失败，已保留成功结果。'
          : '数据包候选分析均未成功。'
      }
    };
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
      candidateOptions: result.candidateOptions || [],
      detailAttempts: result.detailAttempts,
      alert: result.alert,
      packetAnalyses: result.packetAnalyses,
      error: result.error,
      renderPolicy: {
        target: 'final_user_reply',
        requirePacketEvidence: true,
        includeInternalWorkflow: false
      }
    };
  }
}

module.exports = AlertPacketResultContractService;
