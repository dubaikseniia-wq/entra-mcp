#!/bin/bash
# Smithery-вариант бандла: тот же .mcpb, но в manifest.tools добавлены inputSchema (Smithery валидирует tools по MCP Tool-схеме; mcpb validate их не пропускает).
# Использование: npm run bundle && bash scripts/bundle-smithery.sh && npx -y smithery@latest mcp publish dist-bundle/entra-mcp-smithery.mcpb -n dubai-kseniia/entra-mcp
set -e
cd "$(dirname "$0")/.."
W="$(mktemp -d)"; unzip -q dist-bundle/entra-mcp.mcpb -d "$W"
node scripts/smithery-manifest.mjs "$W"
( cd "$W" && zip -qr "$OLDPWD/dist-bundle/entra-mcp-smithery.mcpb" . -x ".DS_Store" )
rm -rf "$W"; ls -la dist-bundle/entra-mcp-smithery.mcpb
