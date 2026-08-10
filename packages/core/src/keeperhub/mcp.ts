/**
 * KeeperHub's own MCP server, as a client.
 *
 * Blackbox drives KeeperHub over REST for everything that executes, because
 * that path is proven onchain. This is for the things REST does not offer:
 * `validate_workflow` checks a workflow's structure and its web3 config
 * *before* anything is executed, and `list_action_schemas` reports the exact
 * config fields an action expects.
 *
 * Both would have saved us. We shipped a workflow that used the legacy
 * `args` field where the runtime reads `functionArgs`, which saves without
 * complaint and then executes with no arguments at all. A validation call
 * catches that before a remediation is attempted rather than after.
 *
 * The session handshake is strict and its own error message documents it:
 * `initialize`, then `notifications/initialized`, then calls — sequential, not
 * parallel, all carrying the session id the server hands back. An organisation
 * key authenticates it, so no browser and no OAuth.
 */

export type McpToolResult = {
  ok: boolean;
  /** The tool's text content, joined. */
  text: string;
  /** Parsed structured content when the tool returned any. */
  data: unknown;
};

export type KeeperHubMcpOptions = {
  orgKey: string;
  url?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class KeeperHubMcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'KeeperHubMcpError';
  }
}

export class KeeperHubMcp {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private sessionId: string | undefined;
  private nextId = 1;

  constructor(private readonly options: KeeperHubMcpOptions) {
    this.url = options.url ?? 'https://app.keeperhub.com/mcp';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.orgKey}`,
      'Content-Type': 'application/json',
      // The server may answer either way; it picks.
      Accept: 'application/json, text/event-stream',
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    };
  }

  private async rpc(body: Record<string, unknown>): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', ...body }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    const text = await res.text();
    if (!text) return {};

    // A streamable-HTTP server may answer as SSE even for a single response.
    const payload = text.startsWith('event:') || text.startsWith('data:')
      ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
      : text;

    try {
      return JSON.parse(payload) as { result?: unknown; error?: { code: number; message: string } };
    } catch {
      throw new KeeperHubMcpError(`Unparseable MCP response: ${text.slice(0, 200)}`);
    }
  }

  /**
   * Establish a session, once.
   *
   * Skipping the `notifications/initialized` step answers `-32003 Session not
   * initialized` on the next call, which is a good error and worth not
   * provoking.
   */
  private async connect(): Promise<void> {
    if (this.sessionId) return;

    const init = await this.rpc({
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'blackbox', version: '0.1.0' },
      },
    });
    if (init.error) {
      throw new KeeperHubMcpError(`MCP initialize failed: ${init.error.message}`, init.error.code);
    }
    await this.rpc({ method: 'notifications/initialized' });
  }

  async listTools(): Promise<{ name: string; description: string }[]> {
    await this.connect();
    const res = await this.rpc({ id: this.nextId++, method: 'tools/list' });
    if (res.error) throw new KeeperHubMcpError(res.error.message, res.error.code);
    return ((res.result as { tools?: { name: string; description: string }[] })?.tools ?? []).map(
      (t) => ({ name: t.name, description: t.description }),
    );
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    await this.connect();
    const res = await this.rpc({
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (res.error) throw new KeeperHubMcpError(res.error.message, res.error.code);

    const result = res.result as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
      structuredContent?: unknown;
    };
    const text = (result?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');

    return {
      ok: result?.isError !== true,
      text,
      data: result?.structuredContent ?? tryParse(text),
    };
  }

  /**
   * Check a workflow before executing it.
   *
   * Returns what the validator said rather than throwing on an invalid
   * workflow: "this would not have worked, and here is why" is a result the
   * remediator should record, not an exception.
   */
  async validateWorkflow(
    workflowId: string,
  ): Promise<{ valid: boolean; errors: { code?: string; message?: string }[]; detail: string }> {
    const result = await this.callTool('validate_workflow', { workflowId });
    // The verdict is nested: the tool answers `{ ok, result: { valid, errors } }`.
    // Reading `valid` off the top level finds nothing and quietly reports every
    // workflow as fine, which is worse than not checking at all.
    const body = result.data as { result?: { valid?: boolean; errors?: unknown[] } } | null;
    const inner = body?.result;
    if (!inner || typeof inner.valid !== 'boolean') {
      throw new KeeperHubMcpError(
        `validate_workflow returned no verdict for ${workflowId}: ${result.text.slice(0, 200)}`,
      );
    }
    const errors = (inner.errors ?? []) as { code?: string; message?: string }[];
    return {
      valid: inner.valid,
      errors,
      detail: errors.map((e) => `${e.code ?? 'error'}: ${e.message ?? ''}`).join('; ') || result.text,
    };
  }
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
