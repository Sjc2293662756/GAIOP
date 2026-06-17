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

All user-facing URLs and audit summaries must redact `Password`.

The report skill must not run these requests. It only renders the `inspection` object and its evidence-backed findings.
