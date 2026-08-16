# GAIOP Syslog Receiver

This deployment component tails the rsyslog-managed NAPM Syslog file, normalizes alert records, persists a bounded local event history, and exposes a loopback-only health/config/query API for the Admin BFF.

It deliberately does not contain enterprise WeCom/Webhook delivery configuration. Notification channels remain a separate Channel Management responsibility.

For an existing host using `10-netinside.conf`, set `GAIOP_SYSLOG_PATH=/var/log/netinside/syslog.log` and reuse the current UDP/514 receiver. A fresh ISO installation should provision rsyslog and its dedicated file through deployment automation before enabling this service.
