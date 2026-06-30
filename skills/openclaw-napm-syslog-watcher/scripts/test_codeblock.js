#!/usr/bin/env node
'use strict';

const axios = require('axios');
const WEBHOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=6ab0fb17-01a5-4c88-815e-46164cf3c392';

async function test(name, content) {
  console.log(`\n=== ${name} ===`);
  console.log('RAW:', JSON.stringify(content));
  try {
    const r = await axios.post(WEBHOOK, {
      msgtype: 'markdown',
      markdown: { content }
    });
    console.log('RESULT:', r.data);
  } catch (e) {
    console.log('ERROR:', e.message);
  }
}

(async () => {
  await test('纯代码块',
    'test\n\n```\nhello world\n```');

  await test('引用+代码块(与卡片相同)',
    '> 💬 深入分析\n\n```\n分析这个告警数据包 694918 1782448260 1782455460\n```');

  await test('不用引用',
    '💬 深入分析\n\n```\n分析这个告警数据包 694918 1782448260 1782455460\n```');

  await test('引用+代码块+结尾',
    '> 💬 深入分析\n\n```\n分析这个告警数据包 694918 1782448260 1782455460\n```\n\n> 📅 测试结尾');

  await test('代码块无空行（紧接引用）',
    '> 💬 深入分析\n```\n分析这个告警数据包 694918 1782448260 1782455460\n```');

  // 用 font 标签做可复制文本
  await test('font info 标签',
    '> 💬 深入分析\n\n<font color=\"info\">分析这个告警数据包 694918 1782448260 1782455460</font>');

  console.log('\n=== DONE ===');
})();
