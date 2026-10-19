Output demo.gif
Set Theme "Dracula"
Set FontSize 12
Set Width 1280
Set Height 620
Set Shell bash
Set TypingSpeed 25ms

Type "bash docs/demo/setup-demo.sh"
Enter
Sleep 2s

Type "cd /tmp/aiwrangler-demo"
Enter
Sleep 500ms

Type "cat s1-config.ndjson | npx -y --package @kodr/aiwrangler aiwrangler-mcp demo-repo | jq -r 'select(.id==2).result.content[0].text'"
Enter
Sleep 6s

Type "cat s2-plan.ndjson | npx -y --package @kodr/aiwrangler aiwrangler-mcp demo-repo | jq -r 'select(.id==2).result.content[0].text' | head -28"
Enter
Sleep 12s

Type "cat s3-check.ndjson | npx -y --package @kodr/aiwrangler aiwrangler-mcp demo-repo | jq -r 'select(.id==2).result.content[0].text' | head -36"
Enter
Sleep 12s
