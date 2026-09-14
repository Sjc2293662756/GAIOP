const logger = require('../src/utils/logger');
const { logAudit, buildSafeUrl, maskSensitiveParams } = require('../src/utils/auditLogger');
const NapmQuerySerializer = require('./NapmQuerySerializer');

class MetricExecutionKernel {
  constructor(context = {}) {
    this.context = context;
  }

  async execute(queryRequest = {}, helpers = {}, requestContext = null) {
    const {
      response,
      buildGatewayRequestSummary,
      buildExecutionDataSummary
    } = helpers;
    const {
      napmClient,
      queryValidator,
      parseNapmPayload,
      serializer = NapmQuerySerializer
    } = this.context;

    logger.info('正在验证 metric kernel 请求参数...');
    queryValidator.validateGatewayRequest(queryRequest);
    const serialized = serializer.serialize(queryRequest);
    const params = serialized.params;

    logger.info('正在构建 metric kernel URL...');
    const fullParams = {
      UserName: napmClient.username,
      Password: napmClient.password,
      ...params
    };
    response.requestParams = { ...params };
    response.requestParamsMasked = maskSensitiveParams(fullParams);
    const url = buildSafeUrl(napmClient.baseUrl, fullParams);
    response.requestUrl = url;

    logAudit('napm_metric_api_request_built', {
      gatewayRequest: buildGatewayRequestSummary(queryRequest),
      params: maskSensitiveParams(fullParams),
      url
    }, requestContext);

    logger.info('正在请求 metric kernel URL...');
      response.dataRequestAttempted = true;
      const rawPayload = await napmClient.get(params);
      response.dataRequestSucceeded = true;
      const csvText = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);
      logger.info('NAPM metric payload received', { dataLength: csvText.length });

    let data;
    try {
      data = parseNapmPayload(rawPayload);
      response.responseParseSucceeded = true;
    } catch (error) {
      response.responseParseSucceeded = false;
      throw error;
    }
    response.ok = true;
    response.service = queryRequest.service;
    response.data = data;

    logAudit('napm_metric_execution_completed', {
      gatewayRequest: buildGatewayRequestSummary(queryRequest),
      execution: buildExecutionDataSummary(data)
    }, requestContext);

    return response;
  }
}

module.exports = MetricExecutionKernel;
