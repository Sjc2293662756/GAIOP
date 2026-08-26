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

Supported rolling keys include `last7days`, `last30days`, `last90days`, and `last365days`. Calendar keys include `currentQuarter`, `previousQuarter`, `currentYear`, and `previousYear`. All ranges are generated from the server clock, minute-aligned, and explicitly recorded with `timezone=Asia/Shanghai`. The traffic resolver selects from the confirmed backend values `60/300/3600/86400` seconds using a 120-point budget; a valid API response granularity is authoritative for the source time axis. If a long window still exceeds the point budget at daily resolution (for example, a year), the report layer aggregates the daily response by Shanghai calendar week and records `aggregation.method=calendar_week_average` plus `effectiveGranularity=604800`; it does not claim that the backend returned a weekly bucket.

Business `topValues` queries use the selected primary range when one was requested. With no user-selected report range, they retain the default rolling seven-day aggregation. `topValues` remains an aggregation and does not imply a time-series bucket granularity.

All user-facing URLs and audit summaries must redact `Password`.

The report skill must not run these requests. It only renders the `inspection` object and its evidence-backed findings.
