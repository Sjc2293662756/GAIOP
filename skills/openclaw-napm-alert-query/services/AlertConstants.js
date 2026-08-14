'use strict';

const ALERT_CATEGORY_LABELS = {
  networkAlerts: '网络性能告警',
  networkIssueAlerts: '网络异常告警',
  appAlerts: '应用性能告警',
  busAlerts: '业务故障告警',
  userAlerts: '用户体验告警',
  securityAlerts: '安全事件告警',
  AIAlerts: '智能分析告警',
};

const ALERT_SEVERITY_LABELS = {
  2: '轻微',
  3: '重大',
  4: '紧急',
};

const CATEGORY_TYPE_TO_GROUP_TYPE = {
  0: 'TotalTraffic',
  3: 'IPAddress',
  14: 'BusinessGroup',
  25: 'DefinedApp',
  27: 'ConnectedBusinessGroup',
  29: 'BusinessGroupLink',
  51: 'DefinedApp',
  53: 'IPConversation',
  56: 'OtherApp',
  58: 'Interface',
  63: 'PageFamily',
  67: 'User',
  68: 'WebApplication',
  72: 'MonInterfaceGroup',
};

// categoryType → alertCategory：detail 接口不返 category，从对象类型推导告警大类
const CATEGORY_TYPE_TO_ALERT_CATEGORY = {
  // 应用类 → appAlerts
  25: 'appAlerts',  // DefinedApp
  51: 'appAlerts',  // DefinedApp (OtherApp)
  56: 'appAlerts',  // OtherApp
  63: 'appAlerts',  // PageFamily
  68: 'appAlerts',  // WebApplication
  // 业务类 → busAlerts
  14: 'busAlerts',  // BusinessGroup
  27: 'busAlerts',  // ConnectedBusinessGroup
  29: 'busAlerts',  // BusinessGroupLink
  // 网络类 → networkAlerts
  0:  'networkAlerts',  // TotalTraffic
  3:  'networkAlerts',  // IPAddress
  53: 'networkAlerts',  // IPConversation
  58: 'networkAlerts',  // Interface
  72: 'networkAlerts',  // MonInterfaceGroup
  // 用户体验类 → userAlerts
  67: 'userAlerts',     // User
};

const ALERT_TASK_TYPE_LABELS = {
  0: '静态/普通告警',
  1: '智能告警',
  3: '动态告警',
};

const ALERT_LINK_TYPE_LABELS = {
  1: '按对象/IP 关联数据包',
  2: '按事件 ID 关联数据包',
};

const TIMELINE_ORDER_WARNING = 'alertsSummaryTimeLine severity array order follows current frontend reading: [minor, critical, major]. Confirm with backend if exact order matters.';

module.exports = {
  ALERT_CATEGORY_LABELS,
  ALERT_SEVERITY_LABELS,
  CATEGORY_TYPE_TO_GROUP_TYPE,
  CATEGORY_TYPE_TO_ALERT_CATEGORY,
  ALERT_TASK_TYPE_LABELS,
  ALERT_LINK_TYPE_LABELS,
  TIMELINE_ORDER_WARNING,
};

