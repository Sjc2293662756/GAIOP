# NAPM Inspection API Contract

The inspection skill queries NetInside/NAPM with runtime query authentication:

```text
GET /webservice/NetInside?UserName={user}&Password={password}&type=applianceInfo&json=true
GET /webservice/NetInside?UserName={user}&Password={password}&type=packetsInfo&json=true&{}
GET /NetInside/About.jsp?UserName={user}&Password={password}
```

Additional evidence-backed report sections use metric APIs:

```text
GET /webservice/NetInside?UserName={user}&Password={password}&type=timeValues&numGroups=1&groupType1=TotalTraffic&metrics=TPIO,TPI,TPO&start={start}&end={end}&granularity={granularity}&json=true
GET /webservice/NetInside?UserName={user}&Password={password}&type=topValues&numGroups=1&groupType1=WebApplication&metrics=PGSLPCT,PGNSLPGE,PGTME&topMetric=PGSLPCT&topCount=20&start={start}&end={end}&json=true
GET /webservice/NetInside?UserName={user}&Password={password}&type=topValues&numGroups=1&groupType1=WebApplication&metrics=PGHTTP400&topMetric=PGHTTP400&topCount=20&start={start}&end={end}&json=true
GET /webservice/NetInside?UserName={user}&Password={password}&type=topValues&numGroups=1&groupType1=WebApplication&metrics=PGHTTP500&topMetric=PGHTTP500&topCount=20&start={start}&end={end}&json=true
```

The traffic `start/end` pair is selected from the inspection window contract:

```text
reportWindow -> primaryWindow -> timeValues (主图)
                         -> contextWindows (最近1天/最近1小时辅助图，可选)
```

Supported rolling keys include `last7days`, `last30days`, `last90days`, and `last365days`. Calendar keys include `currentQuarter`, `previousQuarter`, `currentYear`, and `previousYear`. All ranges are generated from the server clock, minute-aligned, and explicitly recorded with `timezone=Asia/Shanghai`. Automatic traffic granularity uses the shared duration policy: up to 6 hours uses `60`, over 6 hours through 3 days uses `300`, over 3 days but below `3600000` seconds uses `3600`, and `3600000` seconds or more uses `86400`. The `30 days` to `3600000 seconds` interval therefore remains hourly. A valid API response granularity is authoritative for the time axis. The report layer preserves that actual granularity for long windows, including annual daily data; it may reduce visible axis labels but must not aggregate daily values into an additional weekly granularity.

Business `topValues` queries use the selected primary range when one was requested. With no user-selected report range, they retain the default rolling seven-day aggregation. `topValues` remains an aggregation and does not imply a time-series bucket granularity.

All user-facing URLs and audit summaries must redact `Password`.

The report skill must not run these requests. It only renders the `inspection` object and its evidence-backed findings.
