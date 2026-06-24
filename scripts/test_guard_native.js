// Native test of isSummaryPrompt — runs on the server, no PLINK encoding issues
const plugin = require('/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.js');
const t = plugin.__test__;
const fn = t.isSummaryPrompt;

const tests = [
  '给我系统最近一天的综述报告',
  '综述报告',
  '给我系统最近一天的综述报告；',
  '生成全局综述报告',
  '239web的业务综述',
  '查询流量',
  'hello world'
];

console.log('Testing isSummaryPrompt:');
for (const input of tests) {
  console.log(`  "${input}" => ${fn(input)}`);
}

// Also test regex directly
const re = /(?:综述报告|全局综述|业务综述|应用综述|业务组综述|网络综述|告警综述|summary\s*report|overview\s*report)/i;
console.log('\nDirect regex tests:');
for (const input of tests) {
  console.log(`  "${input}" => ${re.test(input)}`);
}
