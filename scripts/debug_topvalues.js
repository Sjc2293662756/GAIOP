// Debug: check raw NAPM topValues response format
const SummaryClient = require('../skills/openclaw-napm-summary/services/SummaryClient');
const c = new SummaryClient();
const now = Math.floor(Date.now()/1000);
const start = now - 86400;

(async () => {
  const raw = await c.getTopValues(start, now, 'TPIO,TPI,TPO', 'TPIO', 3, [{type:'IPAddress'}]);
  console.log('raw type:', typeof raw);
  console.log('isArray:', Array.isArray(raw));

  if (!Array.isArray(raw) && typeof raw === 'object') {
    console.log('object keys:', Object.keys(raw).join(','));
    if (raw.topValues) {
      const first = raw.topValues[0];
      console.log('topValues[0] keys:', Object.keys(first||{}).join(','));
      console.log('topValues[0].key:', first?.key);
      console.log('topValues[0].keyLabel:', first?.keyLabel);
      if (first?.metricValues) {
        console.log('metricValues[0].metric.id:', first.metricValues[0]?.metric?.id);
        console.log('metricValues[0].value:', first.metricValues[0]?.value);
      }
    }
  }

  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0];
    console.log('array[0] keys:', Object.keys(first||{}).join(','));
    console.log('array[0].key:', first?.key);
    console.log('array[0].keyLabel:', first?.keyLabel);
    if (first?.metricValues) {
      console.log('metricValues[0] sample:', JSON.stringify(first.metricValues[0]).slice(0,150));
    }
  }

  // Also check the request URL
  console.log('\nRequest URL:', c.requestHistory[0]?.url?.slice(0,200));
})().catch(e => console.error(e));
