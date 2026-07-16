const logger = require('../src/utils/logger');
const { logAudit, buildSafeUrl, maskSensitiveParams } = require('../src/utils/auditLogger');

class MetadataExecutionKernel {
  constructor(context = {}) {
    this.context = context;
  }

  async execute(queryRequest = {}, helpers = {}, requestContext = null) {
    const {
      response,
      attachDebugRequestInfo,
      buildGatewayRequestSummary,
      buildExecutionDataSummary
    } = helpers;
    const {
      groupBuilder,
      napmMetadataService,
      filterMetricInventoryForOwnership,
      assertMetadataInventoryArgumentContract,
      napmClient,
      queryValidator,
      parseNapmPayload
    } = this.context;

    const metadataGroups = (Array.isArray(queryRequest.groups) ? queryRequest.groups : []).map((group) => ({
      ...group,
      type: groupBuilder.parseGroupType(group?.type) || group?.type || null
    }));

    if (queryRequest.service === 'metrics' && metadataGroups.length > 0) {
      const metadataParams = {
        type: 'metricsForGroup',
        start: queryRequest.start,
        end: queryRequest.end,
        json: 'true',
        ...groupBuilder.buildGroupParams(metadataGroups)
      };
      attachDebugRequestInfo(metadataParams);
      const metadataMetrics = await napmMetadataService.getMetricsForGroupPath(metadataGroups);
      const ownedMetrics = filterMetricInventoryForOwnership(metadataGroups, metadataMetrics);
      response.ok = true;
      response.service = queryRequest.service;
      response.data = ownedMetrics;
      logAudit('napm_metadata_metrics_for_group_completed', {
        gatewayRequest: buildGatewayRequestSummary({ ...queryRequest, groups: metadataGroups }),
        execution: buildExecutionDataSummary(ownedMetrics),
        params: response.requestParamsMasked,
        url: response.requestUrl
      }, requestContext);
      return response;
    }

    if (queryRequest.service === 'groups' && metadataGroups.length === 1) {
      const firstGroup = metadataGroups[0] || {};
      const firstType = String(firstGroup.type || '').trim();
      const firstArgument = String(firstGroup.argument || '').trim();
      let namedList = null;
      let metadataTypeForDebug = 'groups';
      let metadataParams = null;
      let instanceProviderMetadata = null;

      instanceProviderMetadata = await napmMetadataService.resolveObjectInstanceProviderMetadata(firstType);
      if (instanceProviderMetadata) {
        assertMetadataInventoryArgumentContract(firstType, firstArgument, instanceProviderMetadata);
        namedList = await napmMetadataService.listObjectInstances(firstType, firstArgument);
        metadataTypeForDebug = instanceProviderMetadata.apiType;
      }

      if (Array.isArray(namedList)) {
        if (metadataTypeForDebug === 'groups') {
          metadataParams = {
            type: 'groups',
            start: queryRequest.start,
            end: queryRequest.end,
            json: 'true',
            ...groupBuilder.buildGroupParams(metadataGroups)
          };
        } else if (metadataTypeForDebug === 'groupArguments') {
          metadataParams = {
            type: 'groupArguments',
            argumentType: instanceProviderMetadata.argumentType,
            json: 'true'
          };
        } else {
          metadataParams = {
            type: metadataTypeForDebug,
            json: 'true'
          };
        }
        attachDebugRequestInfo(metadataParams);
        response.ok = true;
        response.service = queryRequest.service;
        response.data = namedList;
        response.metadata = instanceProviderMetadata;
        logAudit('napm_metadata_named_groups_completed', {
          gatewayRequest: buildGatewayRequestSummary({ ...queryRequest, groups: metadataGroups }),
          execution: buildExecutionDataSummary(namedList),
          metadata: instanceProviderMetadata,
          params: response.requestParamsMasked,
          url: response.requestUrl
        }, requestContext);
        return response;
      }
    }

    const params = {
      type: queryRequest.service,
      json: 'true'
    };
    if (queryRequest.start) {
      params.start = queryRequest.start;
    }
    if (queryRequest.end) {
      params.end = queryRequest.end;
    }
    if (metadataGroups.length > 0) {
      Object.assign(params, groupBuilder.buildGroupParams(metadataGroups));
    }

    if (queryRequest.service === 'groups' || queryRequest.service === 'metrics') {
      queryValidator.validateGatewayRequest(queryRequest);
    }

    logger.info('正在构建 metadata kernel URL...');
    const fullParams = {
      UserName: napmClient.username,
      Password: napmClient.password,
      ...params
    };
    response.requestParams = { ...params };
    response.requestParamsMasked = maskSensitiveParams(fullParams);
    const url = buildSafeUrl(napmClient.baseUrl, fullParams);
    response.requestUrl = url;

    logAudit('napm_metadata_api_request_built', {
      gatewayRequest: buildGatewayRequestSummary({ ...queryRequest, groups: metadataGroups }),
      params: maskSensitiveParams(fullParams),
      url
    }, requestContext);

    const rawPayload = await napmClient.get(params);
    const data = parseNapmPayload(rawPayload);
    response.ok = true;
    response.service = queryRequest.service;
    response.data = data;

    logAudit('napm_metadata_execution_completed', {
      gatewayRequest: buildGatewayRequestSummary({ ...queryRequest, groups: metadataGroups }),
      execution: buildExecutionDataSummary(data)
    }, requestContext);

    return response;
  }
}

module.exports = MetadataExecutionKernel;
