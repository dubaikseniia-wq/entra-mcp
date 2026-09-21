#!/usr/bin/env sh
# Build the MCPB bundle (dist-bundle/entra-mcp.mcpb) for Claude Desktop / Smithery.
# Stages dist/ + production-only node_modules in dist-bundle/stage, validates manifest.json, packs.
# Usage: npm run bundle   (needs Node >= 18 and network for npx @anthropic-ai/mcpb)
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist-bundle"
STAGE="$OUT/stage"

cd "$ROOT"
npm run build
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp manifest.json package.json package-lock.json LICENSE README.md icon.png "$STAGE/"
cp -R dist "$STAGE/dist"
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
npx -y @anthropic-ai/mcpb validate "$STAGE/manifest.json"
npx -y @anthropic-ai/mcpb pack "$STAGE" "$OUT/entra-mcp.mcpb"
rm -rf "$STAGE"
ls -la "$OUT/entra-mcp.mcpb"
