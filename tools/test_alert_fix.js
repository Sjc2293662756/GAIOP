#!/usr/bin/env node
'use strict';

const { handleSkillCall } = require('/home/netinside/.openclaw/workspace/skills/openclaw-napm-alert-query/scripts/run_alert_query');

(async () => {
  // 用 Base64 编码的中文 prompt，完全避开 SSH 编码问题
  const prompt = Buffer.from('5YiG5p6Q5pyA6L+R5LiJ5bCP5pe25ZGK6K2m5oOF5Ya177yM5YiX5Ye65a+55bqU5ZGK6K2m5a+56LGh', 'base64').toString('utf8');
  console.log('prompt:', prompt);
  console.log('');

  // Test 1: 无 criteria.start/end（修复前返回380字符"0条告警"模板的场景）
  console.log('=== Test 1: criteria without start/end ===');
  const r1 = await handleSkillCall({
    mode: 'summary',
    prompt: prompt,
    criteria: {}
  });
  console.log('ok:', r1.ok);
  if (r1.ok) {
    console.log('events:', r1.events?.length);
    console.log('total:', r1.summary?.total);
    console.log('displayText preview:', r1.narrationInput?.displayText?.substring(0, 200));
  } else {
    console.log('error:', JSON.stringify(r1.error));
    console.log('displayText:', r1.narrationInput?.displayText ? 'EXISTS (BAD!)' : 'NULL (correct - error not swallowed)');
  }
  console.log('');

  // Test 2: 正常有 criteria.start/end
  console.log('=== Test 2: criteria with start/end (control) ===');
  const now = Math.floor(Date.now() / 1000);
  const floor = (v) => Math.floor(v / 60) * 60;
  const r2 = await handleSkillCall({
    mode: 'summary',
    prompt: prompt,
    criteria: { start: floor(now - 3600), end: floor(now) }
  });
  console.log('ok:', r2.ok);
  console.log('events:', r2.events?.length);
  console.log('total:', r2.summary?.total);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
