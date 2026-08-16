const logger = require('../src/utils/logger');
const { logAudit, buildSafeUrl, maskSensitiveParams } = require('../src/utils/auditLogger');

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
      groupBuilder,
      queryValidator,
      buildMetricCsv,
      parseNapmPayload
    } = this.context;

    logger.info('正在验证 metric kernel 请求参数...');
    queryValidator.validateGatewayRequest(queryRequest);

    const params = {
      type: queryRequest.service,
      start: queryRequest.start,
      end: queryRequest.end,
      json: 'true'
    };

    if (queryRequest.service === 'topValues') {
      params.topMetric = queryRequest.topMetric || queryRequest.metric;
      params.metrics = buildMetricCsv(queryRequest, queryRequest.service);
      params.topCount = queryRequest.topCount || 20;
    } else if (queryRequest.service === 'averageValues') {
      params.metrics = buildMetricCsv(queryRequest, queryRequest.service);
    } else if (queryRequest.service === 'timeValues') {
      params.metrics = buildMetricCsv(queryRequest, queryRequest.service);
      params.granularity = queryRequest.granularity;
    }

    if (queryRequest.groups && queryRequest.groups.length > 0) {
      Object.assign(params, groupBuilder.buildGroupParams(queryRequest.groups));
    }

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
    const rawPayload = await napmClient.get(params);
    const csvText = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);
    logger.info('请求到的数据:');
    logger.info(typeof rawPayload === 'string' ? rawPayload.substring(0, 200) + (rawPayload.length > 200 ? '...' : '') : JSON.stringify(rawPayload).substring(0, 200));
    logger.info('数据长度:', csvText.length);

    const data = parseNapmPayload(rawPayload);
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
