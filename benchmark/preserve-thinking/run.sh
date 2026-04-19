#!/bin/bash
# Preserve-thinking validation: ask for two 20-digit numbers, remember both,
# then on the next turn ask for the second. With preserve_thinking ON the
# model recalls; with it OFF the model says it has no second number.
#
# Usage:
#   ./run.sh                     # uses server on localhost:3001
#   HOST=http://x:3001 ./run.sh  # or another host
#
# The server's preserve_thinking flag is set at boot via
# RLM_PRESERVE_THINKING=true/false (default true). This script just talks
# OpenAI-format, so a single chat session maintains its own history.

set -e
HOST="${HOST:-http://0.0.0.0:3001}"

echo "=== Turn 1: ask for two 20-digit numbers ==="
T1=$(jq -n '{
  model: "local-model",
  messages: [
    {role: "user", content: "can you come up with two random 20 digit numbers and validate that they are 20 digits, do not use any tools, and only give me one of the two and nothing else"}
  ],
  rlm: false
}')
R1=$(curl -s -X POST "$HOST/v1/chat/completions" -H "Content-Type: application/json" -d "$T1")
A1=$(echo "$R1" | jq -r '.choices[0].message.content')
echo "Turn 1 answer: $A1"
echo ""

echo "=== Turn 2: ask for the second number ==="
T2=$(jq -n --arg a1 "$A1" '{
  model: "local-model",
  messages: [
    {role: "user", content: "can you come up with two random 20 digit numbers and validate that they are 20 digits, do not use any tools, and only give me one of the two and nothing else"},
    {role: "assistant", content: $a1},
    {role: "user", content: "now give me the second number that you came up with"}
  ],
  rlm: false
}')
R2=$(curl -s -X POST "$HOST/v1/chat/completions" -H "Content-Type: application/json" -d "$T2")
A2=$(echo "$R2" | jq -r '.choices[0].message.content')
echo "Turn 2 answer: $A2"
echo ""

echo "=== Verdict ==="
if echo "$A2" | grep -qiE "no|cannot|don't have|didn't|only one|only came up with"; then
  echo "❌ preserve_thinking appears OFF — model forgot the second number."
elif echo "$A2" | grep -qE '[0-9]{20}'; then
  echo "✅ preserve_thinking appears ON — model produced a second 20-digit number."
else
  echo "⚠️  ambiguous — inspect the output manually."
fi
