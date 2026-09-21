#!/usr/bin/env node
/**
 * ENTRA MCP — stdio entry (`npx entra-mcp`, Claude Desktop, Cursor, Windsurf…).
 * Tools live in server.ts (createServer); the hosted Streamable HTTP entry is http.ts.
 *
 * Flags: --selftest (calls the live API directly, no MCP client) · --employer (hint only — the key itself comes from ENTRA_API_KEY).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { API_KEYS_URL, VERSION, createServer, normalizeApiKey, selftest } from './server.js';

// Employer mode: the key comes from the environment only (never from argv — argv leaks into process lists).
// MCPB hosts may hand over an unresolved "${user_config.…}" placeholder when the optional key is left blank — normalizeApiKey treats it as unset.
const API_KEY = normalizeApiKey(process.env.ENTRA_API_KEY);
const EMPLOYER_FLAG = process.argv.includes('--employer');
const EMPLOYER_MODE = API_KEY.length > 0;

if (process.argv.includes('--selftest')) {
  void selftest();
} else {
  // stderr only — stdout is the MCP transport
  if (EMPLOYER_FLAG && !EMPLOYER_MODE) {
    console.error(`entra-mcp: --employer given but ENTRA_API_KEY is not set — employer tools not loaded. Create a key at ${API_KEYS_URL} and export ENTRA_API_KEY.`);
  } else if (EMPLOYER_MODE) {
    console.error(`entra-mcp ${VERSION}: employer mode (key ${API_KEY.slice(0, 15)}…) — 8 candidate + 8 employer tools`);
  }
  const server = createServer({ apiKey: API_KEY });
  await server.connect(new StdioServerTransport());
}
