import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BlackboxClient } from './client.js';
import { callTool, toolDescriptions, toolSchemas, type ToolName } from './tools.js';

/**
 * Blackbox as an MCP server.
 *
 * Any agent — on KeeperHub or not — can ask why its transaction failed, in its
 * own reasoning loop, without a human reading a dashboard. `diagnose_execution`
 * takes a bare transaction hash, so the asking agent needs to have integrated
 * nothing at all.
 *
 * `request_remediation` is the only tool that spends money. It requires an
 * explicit `authorized: true` from the caller and is still subject to every
 * guard on the server, so an agent cannot spend gas by exploring.
 */

export type ServerOptions = {
  baseUrl?: string;
  /**
   * A Blackbox session token. Reading needs none; watching an address or
   * requesting a remediation needs the account that owns the agent.
   */
  token?: string;
  fetchImpl?: typeof fetch;
};

export function buildMcpServer(options: ServerOptions = {}): McpServer {
  const client = new BlackboxClient({
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.token ? { token: options.token } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  const server = new McpServer({
    name: 'blackbox',
    version: '0.1.0',
  });

  for (const name of Object.keys(toolSchemas) as ToolName[]) {
    // Registered dynamically from one table, so a tool cannot exist with a
    // schema the handler does not honour. The SDK's per-tool generics cannot
    // follow that, hence the cast at the boundary only.
    (server.registerTool as (n: string, c: unknown, h: unknown) => void)(
      name,
      {
        description: toolDescriptions[name],
        inputSchema: toolSchemas[name].shape,
      },
      async (args: unknown) => {
        try {
          const result = await callTool(client, name, args);
          return {
            content: [{ type: 'text' as const, text: result.text }],
            structuredContent: { result: result.data } as Record<string, unknown>,
            ...(result.isError ? { isError: true } : {}),
          };
        } catch (error) {
          // Reported as a tool result rather than thrown: an agent can read a
          // failure and decide what to do, where a transport error just ends
          // its turn with nothing to reason about.
          return {
            content: [
              {
                type: 'text' as const,
                text: `Blackbox could not answer: ${(error as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}
