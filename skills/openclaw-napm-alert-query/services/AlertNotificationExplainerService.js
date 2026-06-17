'use strict';

function explainNotification() {
  return {
    title: '告警通知机制说明',
    sections: [
      {
        type: 'summary',
        title: '高级动作开关',
        content: '`taskActionSelected` 用于启用高级动作。只有启用后，Email、SNMP、SysLog、快照等动作才有意义。',
      },
      {
        type: 'fields',
        title: 'Email 通知',
        rows: [
          { field: 'emailtag', meaning: '是否启用 Email 告警通知。' },
          { field: 'emailtextarea', meaning: '告警接收邮箱，多个邮箱用英文逗号分隔。' },
          { field: 'emailtrigger', meaning: 'Email 触发方式，0=间隔发送，1=持续发送。' },
          { field: 'emailverbosity', meaning: '邮件内容是否包含详细告警信息。' },
        ],
      },
      {
        type: 'fields',
        title: 'SNMP 通知',
        rows: [
          { field: 'SNMPtag', meaning: '是否启用 SNMP 告警通知。' },
          { field: 'snmptrigger', meaning: 'SNMP 触发方式，0=间隔发送，1=持续发送。' },
        ],
      },
      {
        type: 'fields',
        title: 'SysLog 通知',
        rows: [
          { field: 'SysLog', meaning: '是否启用 SysLog 告警通知。' },
          { field: 'syslogtrigger', meaning: 'SysLog 触发方式，0=间隔发送，1=持续发送。' },
          { field: 'syslogverbosity', meaning: 'SysLog 内容是否包含更多告警详情。' },
        ],
      },
      {
        type: 'fields',
        title: '快照动作',
        rows: [
          { field: 'snapshotmark', meaning: '是否启用快照动作。' },
          { field: 'snapshotstatus', meaning: '快照保存的原始报文分钟数。' },
          { field: 'snapshot', meaning: '附加抓取的 IP 原始报文列表，多个 IP 用英文逗号分隔。' },
        ],
      },
    ],
    guardrail: '当前告警 skill 只解释通知字段，不提交 /admin/alerts.asp?m=add 或 /admin/alerts.asp?m=update。'
  };
}

function explainEventFields() {
  return {
    title: '告警事件字段说明',
    rows: [
      { field: 'id', meaning: '告警事件 ID，alertsDetail 通过它查询明细。' },
      { field: 'severity', meaning: '告警级别，2=轻微，3=重大，4=紧急。' },
      { field: 'period', meaning: '告警持续时间。' },
      { field: 'start/end', meaning: '告警开始和结束时间，Unix 秒。' },
      { field: 'name', meaning: '告警名称，通常来自告警任务/规则名称。' },
      { field: 'metrics', meaning: '触发告警的指标。' },
      { field: 'value', meaning: '触发时的实际指标值。' },
      { field: 'baseline', meaning: '基线值，动态/智能告警常用。' },
      { field: 'unit', meaning: '指标单位。' },
      { field: 'categoryType', meaning: '告警对象类型编码，用于映射 timeValues 的 groupType1。' },
      { field: 'condition', meaning: '告警条件表达式。' },
      { field: 'tasktype', meaning: '告警任务类型。' },
      { field: 'linkType', meaning: '数据包关联方式，1=按对象/IP，2=按事件 ID。' },
    ],
  };
}

module.exports = {
  explainNotification,
  explainEventFields,
};

