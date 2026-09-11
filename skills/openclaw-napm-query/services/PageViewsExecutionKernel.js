'use strict';

const logger = require('../src/utils/logger');
const { logAudit, buildSafeUrl, maskSensitiveParams } = require('../src/utils/auditLogger');
const {
  buildPageViewsParams,
  normalizePageViewRows
} = require('../../shared/NapmPageViewsContract');

class PageViewsExecutionKernel {
  constructor(context = {}) {
    this.context = context;
  }

  async execute(queryRequest = {}, helpers = {}, requestContext = null) {
    const { response, buildGatewayRequestSummary } = helpers;
    const { napmClient, queryValidator } = this.context;

    queryValidator.validateGatewayRequest(queryRequest);
    const params = buildPageViewsParams(queryRequest);
    const fullParams = {
      UserName: napmClient.username,
      Password: napmClient.password,
      ...params
    };
    response.requestParams = { ...params };
    response.requestParamsMasked = maskSensitiveParams(fullParams);
    response.requestUrl = buildSafeUrl(napmClient.baseUrl, fullParams);

    logAudit('napm_page_views_api_request_built', {
      gatewayRequest: buildGatewayRequestSummary(queryRequest),
      params: maskSensitiveParams(fullParams),
      url: response.requestUrl
    }, requestContext);

    logger.info('Requesting pageViews detail data.');
    const rawPayload = await napmClient.get(params);
    const data = normalizePageViewRows(rawPayload);
    const statusCounts = data.reduce((counts, row) => {
      const status = row.httpStatus == null ? 'unknown' : String(row.httpStatus);
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {});

    response.ok = true;
    response.service = 'pageViews';
    response.data = data;
    response.metadata = {
      detailType: 'page_view',
      pageFamilyId: queryRequest.pageFamilyId,
      maxLimit: params.maxLimit,
      rowCount: data.length
    };

    logAudit('napm_page_views_execution_completed', {
      gatewayRequest: buildGatewayRequestSummary(queryRequest),
      execution: { rowCount: data.length, statusCounts }
    }, requestContext);

    return response;
  }
}

module.exports = PageViewsExecutionKernel;
