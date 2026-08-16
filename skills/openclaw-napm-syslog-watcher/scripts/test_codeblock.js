#!/usr/bin/env node
'use strict';

const axios = require('axios');

const webhookUrl = String(process.env.WECOM_WEBHOOK_URL || '').trim();
if (!webhookUrl) {
  process.stderr.write('WECOM_WEBHOOK_URL is required.\n');
  process.exit(2);
}

async function sendCase(name, content) {
  process.stdout.write(`\n=== ${name} ===\n`);
  try {
    const response = await axios.post(webhookUrl, {
      msgtype: 'markdown',
      markdown: { content }
    });
    process.stdout.write(`RESULT: ${JSON.stringify(response.data)}\n`);
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
  }
}

(async () => {
  await sendCase('plain code block', 'test\n\n```\nhello world\n```');
  await sendCase('quote and code block', '> packet analysis\n\n```\neventId=example\n```');
  await sendCase('info font', '<font color="info">eventId=example</font>');
})();
