#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './server.js';

/**
 * Entry point for an MCP client that speaks stdio.
 *
 * Nothing is written to stdout but protocol frames — a stray log line there
 * corrupts the stream, so status goes to stderr.
 */
const baseUrl = process.env['BLACKBOX_API_URL'] ?? 'http://localhost:4000';
/**
 * Optional, because reading needs no account. Without it the tools that act —
 * watching an address, requesting a remediation — can only be refused, and say
 * so rather than failing obscurely.
 */
const token = process.env['BLACKBOX_TOKEN'];
const server = buildMcpServer({ baseUrl, ...(token ? { token } : {}) });

await server.connect(new StdioServerTransport());
console.error(
  `blackbox mcp server ready, talking to ${baseUrl}` +
    (token ? ' (signed in)' : ' (read-only: set BLACKBOX_TOKEN to act)'),
);
