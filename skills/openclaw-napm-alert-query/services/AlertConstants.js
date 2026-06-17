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
  25: 'Application',
  29: 'BusinessGroupLink',
  53: 'IPConversation',
  58: 'Interface',
  63: 'PageFamily',
  67: 'User',
  68: 'WebApplication',
  72: 'MonInterfaceGroup',
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
  ALERT_TASK_TYPE_LABELS,
  ALERT_LINK_TYPE_LABELS,
  TIMELINE_ORDER_WARNING,
};

