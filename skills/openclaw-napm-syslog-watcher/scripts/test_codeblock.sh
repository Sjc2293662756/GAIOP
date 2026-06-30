#!/bin/bash
WEBHOOK="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=6ab0fb17-01a5-4c88-815e-46164cf3c392"

echo "=== 测试1: 纯代码块 ==="
cat > /tmp/t1.json << 'ENDOFJSON'
{"msgtype":"markdown","markdown":{"content":"test\n\n```\nhello world\n```"}}
ENDOFJSON
curl -sk -X POST "$WEBHOOK" -H 'Content-Type: application/json' -d @/tmp/t1.json
sleep 2

echo ""
echo "=== 测试2: 引用+代码块（与卡片相同）==="
cat > /tmp/t2.json << 'ENDOFJSON'
{"msgtype":"markdown","markdown":{"content":"> 💬 深入分析\n\n```\n分析这个告警数据包 694918 1782448260 1782455460\n```"}}
ENDOFJSON
curl -sk -X POST "$WEBHOOK" -H 'Content-Type: application/json' -d @/tmp/t2.json
sleep 2

echo ""
echo "=== 测试3: 不用引用 ==="
cat > /tmp/t3.json << 'ENDOFJSON'
{"msgtype":"markdown","markdown":{"content":"💬 深入分析\n\n```\n分析这个告警数据包 694918 1782448260 1782455460\n```"}}
ENDOFJSON
curl -sk -X POST "$WEBHOOK" -H 'Content-Type: application/json' -d @/tmp/t3.json