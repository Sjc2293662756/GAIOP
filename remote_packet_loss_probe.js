const plugin = require('/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.js');

const testApi = plugin.__test__ || {};
const prompt = '现在丢包最大的地址是谁？';
const query = testApi.buildPacketLossClientTopResolvedQuery
  ? testApi.buildPacketLossClientTopResolvedQuery(prompt)
  : null;

console.log(JSON.stringify({
  hasPromptGuard: Boolean(testApi.isPacketLossClientTopPrompt && testApi.isPacketLossClientTopPrompt(prompt)),
  query
}, null, 2));
