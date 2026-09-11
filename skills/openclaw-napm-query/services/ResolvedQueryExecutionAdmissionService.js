'use strict';

const ResolvedQueryExecutableValidator = require('./ResolvedQueryExecutableValidator');
const ResolvedQueryContract = require('./ResolvedQueryContract');
const RuntimeMetricCapabilityService = require('./RuntimeMetricCapabilityService');
const AtomicQueryRepairService = require('./AtomicQueryRepairService');

const FINAL_ADMISSION = Object.freeze({
  ALLOW: 'ALLOW',
  DENY_STATIC: 'DENY_STATIC',
  DENY_RUNTIME_UNSUPPORTED: 'DENY_RUNTIME_UNSUPPORTED',
  RUNTIME_CAPABILITY_FAILURE: 'RUNTIME_CAPABILITY_FAILURE'
});

function buildStaticDenial(staticValidation) {
  return {
    ok: false,
    finalAdmission: FINAL_ADMISSION.DENY_STATIC,
    reasonCode: staticValidation?.reasonCode || 'QUERY_VALIDATION_FAILED',
    staticValidation,
    runtimeCapability: null,
    southboundAllowed: false
  };
}

class ResolvedQueryExecutionAdmissionService {
  constructor({
    validator = ResolvedQueryExecutableValidator,
    runtimeService = null,
    repairService = AtomicQueryRepairService
  } = {}) {
    this.validator = validator;
    this.runtimeService = runtimeService || new RuntimeMetricCapabilityService();
    this.repairService = repairService;
  }

  async evaluate(query = {}, options = {}) {
    if (!ResolvedQueryContract.getServiceContract(query?.service)) {
      return {
        ok: true,
        finalAdmission: FINAL_ADMISSION.ALLOW,
        reasonCode: 'NON_QUERY_SERVICE_EXECUTION',
        staticValidation: { ok: true, status: 'VALID', reasonCode: 'NON_QUERY_SERVICE_EXECUTION' },
        runtimeCapability: null,
        southboundAllowed: true
      };
    }
    const initialContractValidation = ResolvedQueryContract.validateShape(query, {
      phase: options.phase
    });
    if (!initialContractValidation.ok) {
      const staticValidation = this.validator.validate(query, {
        productBaseline: options.productBaseline || '',
        phase: options.phase
      });
      return {
        ok: false,
        finalAdmission: FINAL_ADMISSION.DENY_STATIC,
        reasonCode: initialContractValidation.reasonCode,
        message: initialContractValidation.message,
        query: initialContractValidation.query || query,
        repair: null,
        postRepairValidation: null,
        staticValidation,
        runtimeCapability: null,
        southboundAllowed: false
      };
    }
    const repair = options.repairResult || this.repairService.repair(query, options.repairContext || {});
    if (repair.status === 'REPAIR_REJECTED') {
      return {
        ok: false,
        finalAdmission: FINAL_ADMISSION.DENY_STATIC,
        reasonCode: repair.reasonCode || 'REPAIR_REJECTED',
        message: 'Query repair was rejected because it would change query semantics.',
        query,
        repair,
        staticValidation: null,
        runtimeCapability: null,
        southboundAllowed: false
      };
    }
    const repairCandidate = repair.query || query;
    const postRepairValidation = ResolvedQueryContract.validateShape(repairCandidate, {
      phase: options.phase
    });
    if (!postRepairValidation.ok) {
      return {
        ok: false,
        finalAdmission: FINAL_ADMISSION.DENY_STATIC,
        reasonCode: repair.repairApplied
          ? 'POST_REPAIR_VALIDATION_FAILED'
          : postRepairValidation.reasonCode,
        message: postRepairValidation.message || 'Canonical query contract validation failed after repair.',
        query: repairCandidate,
        repair,
        postRepairValidation,
        staticValidation: null,
        runtimeCapability: null,
        southboundAllowed: false
      };
    }
    const candidate = postRepairValidation.query || repairCandidate;
    const staticValidation = this.validator.validate(candidate, {
      productBaseline: options.productBaseline || '',
      phase: options.phase
    });
    if (staticValidation.status !== 'UNKNOWN') {
      return staticValidation.ok
        ? {
            ok: true,
            finalAdmission: FINAL_ADMISSION.ALLOW,
            reasonCode: 'EXECUTABLE_QUERY_VALID',
            query: candidate,
            repair,
            postRepairValidation,
            staticValidation,
            runtimeCapability: null,
            southboundAllowed: true
          }
        : {
            ...buildStaticDenial(staticValidation),
            query: candidate,
            repair,
            postRepairValidation
          };
    }

    const runtimeService = options.runtimeService || this.runtimeService;
    if (!runtimeService || typeof runtimeService.confirm !== 'function') {
      return {
        ok: false,
        finalAdmission: FINAL_ADMISSION.RUNTIME_CAPABILITY_FAILURE,
        reasonCode: 'RUNTIME_CAPABILITY_PROVIDER_UNAVAILABLE',
        query: candidate,
        repair,
        postRepairValidation,
        staticValidation,
        runtimeCapability: {
          status: 'INDETERMINATE',
          reasonCode: 'RUNTIME_CAPABILITY_PROVIDER_UNAVAILABLE',
          metadataCalls: 0,
          evidence: []
        },
        southboundAllowed: false
      };
    }

    const runtimeCapability = await runtimeService.confirm({
      query: candidate,
      staticValidation,
      metadataService: options.metadataService
    });
    if (runtimeCapability.status === 'SUPPORTED') {
      return {
        ok: true,
        finalAdmission: FINAL_ADMISSION.ALLOW,
        reasonCode: 'RUNTIME_CAPABILITY_SUPPORTED',
        query: candidate,
        repair,
        message: 'Runtime metric capability confirmed for the exact group path.',
        postRepairValidation,
        staticValidation,
        runtimeCapability,
        southboundAllowed: true
      };
    }
    if (runtimeCapability.status === 'UNSUPPORTED') {
      return {
        ok: false,
        finalAdmission: FINAL_ADMISSION.DENY_RUNTIME_UNSUPPORTED,
        reasonCode: 'RUNTIME_METRIC_UNSUPPORTED',
        query: candidate,
        repair,
        message: 'The current device or exact group path does not support the requested metric.',
        postRepairValidation,
        staticValidation,
        runtimeCapability,
        southboundAllowed: false
      };
    }
    return {
      ok: false,
      finalAdmission: FINAL_ADMISSION.RUNTIME_CAPABILITY_FAILURE,
      reasonCode: 'RUNTIME_CAPABILITY_FAILURE',
      query: candidate,
      repair,
      message: 'Runtime metric capability could not be confirmed; data execution was not attempted.',
      postRepairValidation,
      staticValidation,
      runtimeCapability,
      southboundAllowed: false
    };
  }
}

module.exports = ResolvedQueryExecutionAdmissionService;
module.exports.FINAL_ADMISSION = FINAL_ADMISSION;
