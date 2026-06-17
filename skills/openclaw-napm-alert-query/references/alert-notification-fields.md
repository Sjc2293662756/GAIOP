# Alert Notification Fields

This skill explains notification fields but does not modify alert configuration.

## Advanced Action Switch

- `taskActionSelected`: enables advanced actions.

## Email

- `emailtag`: enable Email notification.
- `emailtextarea`: recipients, comma-separated.
- `emailtrigger`: `0` interval send, `1` continuous send.
- `emailverbosity`: include detailed alert content.

Email requires:

1. Email action enabled on the alert task.
2. Recipients configured.
3. Global mail server configuration.
4. Mail service started.

## SNMP

- `SNMPtag`: enable SNMP notification.
- `snmptrigger`: `0` interval send, `1` continuous send.

SNMP requires global SNMP/SysLog configuration and backend alert service health.

## SysLog

- `SysLog`: enable SysLog notification.
- `syslogtrigger`: `0` interval send, `1` continuous send.
- `syslogverbosity`: include detailed alert content.

## Snapshot

- `snapshotmark`: enable snapshot action.
- `snapshotstatus`: raw packet retention minutes.
- `snapshot`: extra IP list, comma-separated.

Snapshot is an alert-triggered action, not a notification channel.

