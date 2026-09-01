import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_CATALOG_BACKOFF_MS } from "./mcp-catalog-cache.js";
import { allowlistDrift, McpConnector } from "./mcp-connector.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SERVER = {
  id: "server-1",
  slug: "demo",
  transport: "streamable_http",
  endpoint: "https://mcp.example.test/mcp",
  secretId: null,
  args: [],
  revision: 1,
};

const ASSIGNMENT = {
  botId: "bot-1",
  serverId: "server-1",
  spaceId: "w1",
  userId: "u1",
  allowAllTools: true,
  allowedTools: [],
  server: SERVER,
};

function mcpFetch(
  state: {
    failNext: boolean;
    initializations: number;
    headers?: Record<string, string>[];
    tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
    calls?: string[];
    /** Counts `tools/list` so a test can prove discovery reused a cached catalog. */
    lists?: number;
    /** Fails only `tools/list`, with this status, leaving the session usable. */
    listStatus?: number;
  },
  expectedUrl = "https://mcp.example.test/mcp",
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    state.headers?.push(Object.fromEntries(request.headers.entries()));
    if (new URL(request.url).href !== expectedUrl)
      throw new Error(`Unexpected request: ${request.url}`);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (state.failNext) return new Response("boom", { status: 500 });
    const message = JSON.parse(await request.text()) as {
      id?: number;
      method?: string;
      params?: { name?: string };
    };
    if (message.method === "initialize") {
      state.initializations += 1;
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "test", version: "1" },
        },
      });
    }
    if (message.method === "tools/list") {
      state.lists = (state.lists ?? 0) + 1;
      if (state.listStatus) return new Response("busy", { status: state.listStatus });
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: state.tools ?? [{ name: "echo", inputSchema: { type: "object" } }],
        },
      });
    }
    if (message.method === "tools/call") {
      if (message.params?.name) state.calls?.push(message.params.name);
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    }
    return new Response(null, { status: 202 });
  });
}

describe("MCP connector session cache", () => {
  it("keeps large MCP schemas out of the initial runtime tool catalog", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      tools: Array.from({ length: 30 }, (_, index) => ({
        name: `tool_${String(index).padStart(2, "0")}`,
        description: `Tool ${index}`,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string", description: `schema-marker-${index}` } },
          required: ["value"],
        },
      })),
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
      mcpCatalogStatus: { upsert: vi.fn() },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;

    const tools = await connector.discoverTools(context);

    expect(tools).toHaveLength(3);
    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp_search_tools",
      "mcp_load_tool",
      "mcp_execute_tool",
    ]);
    expect(JSON.stringify(tools)).not.toContain("schema-marker");
    await connector.close();
  });

  it("exposes 20 MCP tools directly and switches at 21", async () => {
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    for (const count of [20, 21]) {
      const state = {
        failNext: false,
        initializations: 0,
        tools: Array.from({ length: count }, (_, index) => ({
          name: `tool_${index}`,
          inputSchema: { type: "object" },
        })),
      };
      vi.stubGlobal("fetch", mcpFetch(state));
      const connector = new McpConnector(
        {
          botMcpServer: {
            findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
            findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
          },
          mcpCatalogStatus: { upsert: vi.fn() },
        } as never,
        {} as never,
        { network: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] } },
      );
      const tools = await connector.discoverTools(context);
      if (count === 20) {
        expect(tools).toHaveLength(20);
        expect(tools[0]?.name).toMatch(/^mcp__demo__/);
      } else {
        expect(tools.map((tool) => tool.name)).toEqual([
          "mcp_search_tools",
          "mcp_load_tool",
          "mcp_execute_tool",
        ]);
      }
      await connector.close();
    }
  });

  it("returns no tools when the MCP catalog is empty", async () => {
    const connector = new McpConnector(
      { botMcpServer: { findMany: vi.fn().mockResolvedValue([]) } } as never,
      {} as never,
    );
    await expect(
      connector.discoverTools({
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: new AbortController().signal,
      } as never),
    ).resolves.toEqual([]);
    await connector.close();
  });

  it("searches, loads, validates, authorizes, and executes one large-catalog tool", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      calls: [] as string[],
      tools: Array.from({ length: 30 }, (_, index) => ({
        name: `tool_${String(index).padStart(2, "0")}`,
        description: index === 29 ? "Find the final report" : `Utility ${index}`,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      })),
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
      mcpCatalogStatus: { upsert: vi.fn() },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    const [search, load, execute] = await connector.discoverTools(context);
    const collect = async (call: Parameters<McpConnector["execute"]>[0]) => {
      const events: unknown[] = [];
      for await (const event of connector.execute(call as never, context)) events.push(event);
      return events;
    };

    const searched = await collect({
      tool: search!.name,
      args: { query: "final report", limit: 2 },
      executionId: "search",
      route: search!.route,
    });
    expect(searched).toEqual([
      {
        type: "result",
        data: {
          tools: [
            {
              id: "server-1:tool_29",
              name: "mcp__demo__tool_29",
              description: "Find the final report",
              readOnly: false,
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(searched)).not.toContain("inputSchema");

    const indexed = await collect({
      tool: search!.name,
      args: {},
      executionId: "index",
      route: search!.route,
    });
    expect(indexed).toEqual([
      {
        type: "result",
        data: {
          index: [
            {
              group: "demo",
              names: Array.from(
                { length: 30 },
                (_, index) => `tool_${String(index).padStart(2, "0")}`,
              ),
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(indexed)).not.toContain("inputSchema");
    expect(search!.description).toContain("demo:");
    expect(search!.description).toContain("tool_00");

    const expanded = await collect({
      tool: search!.name,
      args: { group: "demo" },
      executionId: "group",
      route: search!.route,
    });
    expect(expanded).toEqual([
      {
        type: "result",
        data: {
          group: "demo",
          names: Array.from({ length: 30 }, (_, index) => `tool_${String(index).padStart(2, "0")}`),
        },
      },
    ]);

    const loaded = await collect({
      tool: load!.name,
      args: { id: "server-1:tool_29" },
      executionId: "load",
      route: load!.route,
    });
    expect(loaded).toEqual([
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          id: "server-1:tool_29",
          inputSchema: expect.objectContaining({ required: ["value"] }),
        }),
      }),
    ]);

    await expect(
      connector.resolveCall(
        {
          tool: execute!.name,
          args: { id: "mcp__demo__missing", arguments: { value: "x" } },
          executionId: "unknown",
          route: execute!.route,
        },
        context,
      ),
    ).rejects.toThrow("unknown or not authorized");
    await expect(
      connector.resolveCall(
        {
          tool: execute!.name,
          args: { id: "server-1:tool_29", arguments: {} },
          executionId: "invalid",
          route: execute!.route,
        },
        context,
      ),
    ).rejects.toThrow("arguments are invalid");

    const resolved = await connector.resolveCall(
      {
        tool: execute!.name,
        args: { id: "server-1:tool_29", arguments: { value: "ok" } },
        executionId: "execute",
        route: execute!.route,
      },
      context,
    );
    expect(resolved).toMatchObject({
      tool: { name: "mcp__demo__tool_29" },
      call: {
        tool: "mcp__demo__tool_29",
        args: { value: "ok" },
        route: { connectorId: "mcp", resourceId: "server-1", toolName: "tool_29" },
      },
    });
    expect(await collect(resolved!.call)).toMatchObject([{ type: "result" }]);
    expect(state.calls).toEqual(["tool_29"]);
    await connector.close();
  });

  it("executes authoritative MCP tools whose names match catalog controls", async () => {
    const state = {
      failNext: false,
      initializations: 0,
      calls: [] as string[],
      tools: ["__catalog_search", "__catalog_load", "__catalog_execute"].map((name) => ({
        name,
        inputSchema: { type: "object" },
      })),
    };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
      mcpCatalogStatus: { upsert: vi.fn() },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;

    for (const tool of await connector.discoverTools(context)) {
      const call = { tool: tool.name, args: {}, executionId: tool.name, route: tool.route };
      await expect(connector.resolveCall(call, context)).resolves.toBeUndefined();
      const events = [];
      for await (const event of connector.execute(call, context)) events.push(event);
      expect(events).toMatchObject([{ type: "result" }]);
    }
    expect(state.calls).toEqual(["__catalog_search", "__catalog_load", "__catalog_execute"]);
    await connector.close();
  });

  it("connects to an explicitly configured localhost HTTP server", async () => {
    const state = { failNext: false, initializations: 0 };
    const localAssignment = {
      ...ASSIGNMENT,
      server: { ...SERVER, endpoint: "http://localhost:8123/api/mcp" },
    };
    vi.stubGlobal("fetch", mcpFetch(state, "http://localhost:8123/api/mcp"));
    const prisma = {
      botMcpServer: { findMany: vi.fn().mockResolvedValue([localAssignment]) },
      mcpCatalogStatus: { upsert: vi.fn() },
    };
    const connector = new McpConnector(prisma as never, {} as never);

    const tools = await connector.discoverTools({
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never);

    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    await connector.close();
  });

  it("sends stored credentials to an explicitly configured localhost HTTP server", async () => {
    const state = { failNext: false, initializations: 0, headers: [] as Record<string, string>[] };
    const localAssignment = {
      ...ASSIGNMENT,
      server: { ...SERVER, endpoint: "http://localhost:8123/api/mcp", secretId: "secret-1" },
    };
    vi.stubGlobal("fetch", mcpFetch(state, "http://localhost:8123/api/mcp"));
    const prisma = {
      botMcpServer: { findMany: vi.fn().mockResolvedValue([localAssignment]) },
      secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "encrypted" }) },
      mcpCatalogStatus: { upsert: vi.fn() },
    };
    const connector = new McpConnector(
      prisma as never,
      {
        load: vi
          .fn()
          .mockReturnValue(
            JSON.stringify({ secret: "local-token", headers: { "X-Api-Key": "local-key" } }),
          ),
      } as never,
    );

    await connector.discoverTools({
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never);

    expect(state.headers[0]?.authorization).toBe("Bearer local-token");
    expect(state.headers[0]?.["x-api-key"]).toBe("local-key");
    await connector.close();
  });

  it("evicts a session after a failed call so the next call reconnects instead of reusing a dead session", async () => {
    const state = { failNext: false, initializations: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
      mcpCatalogStatus: { upsert: vi.fn() },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: {
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      },
    });
    const context = {
      spaceId: "w1",
      userId: "u1",
      botId: "bot-1",
      signal: new AbortController().signal,
    } as never;
    const call = {
      tool: "mcp__demo__echo",
      args: {},
      route: { connectorId: "mcp", resourceId: "server-1", toolName: "echo" },
    } as never;

    const tools = await connector.discoverTools(context);
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    expect(state.initializations).toBe(1);

    state.failNext = true;
    const failed: unknown[] = [];
    for await (const event of connector.execute(call, context)) failed.push(event);
    expect(failed).toMatchObject([{ type: "error" }]);

    state.failNext = false;
    const events: unknown[] = [];
    for await (const event of connector.execute(call, context)) events.push(event);
    expect(events).toMatchObject([{ type: "result" }]);
    expect(state.initializations).toBe(2);

    await connector.close();
  });

  it("does not reuse one session across workspaces", async () => {
    const state = { failNext: false, initializations: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue([ASSIGNMENT]),
        findFirst: vi.fn().mockResolvedValue(ASSIGNMENT),
      },
      mcpCatalogStatus: { upsert: vi.fn() },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
    });
    const contextFor = (spaceId: string, userId: string) =>
      ({ spaceId, userId, botId: "bot-1", signal: new AbortController().signal }) as never;

    await connector.discoverTools(contextFor("w1", "u1"));
    expect(state.initializations).toBe(1);

    await connector.discoverTools(contextFor("w1", "u2"));
    expect(state.initializations).toBe(2);

    await connector.discoverTools(contextFor("w2", "u1"));
    expect(state.initializations).toBe(3);

    await connector.discoverTools(contextFor("w1", "u1"));
    expect(state.initializations).toBe(3);

    await connector.close();
  });
});

describe("MCP connector catalog cache", () => {
  const NETWORK = { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] };
  const contextFor = (botId: string) =>
    ({ spaceId: "w1", userId: "u1", botId, signal: new AbortController().signal }) as never;

  function connectorFor(
    assignments: unknown[],
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    const prisma = {
      botMcpServer: {
        findMany: vi.fn().mockResolvedValue(assignments),
        findFirst: vi.fn().mockResolvedValue(assignments[0]),
      },
      mcpCatalogStatus: { upsert: vi.fn().mockResolvedValue({}) },
    };
    return new McpConnector(prisma as never, {} as never, {
      network: NETWORK,
      catalogTtlMs: options.ttlMs,
      now: options.now,
    });
  }

  /** Same connector, with the status upsert exposed so a test can read what discovery recorded. */
  function connectorRecordingStatus(options: { ttlMs?: number; now?: () => number } = {}) {
    const upsert = vi.fn().mockResolvedValue({});
    const prisma = {
      botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) },
      mcpCatalogStatus: { upsert },
    };
    const connector = new McpConnector(prisma as never, {} as never, {
      network: NETWORK,
      catalogTtlMs: options.ttlMs,
      now: options.now,
    });
    return { connector, upsert };
  }

  it("lists a server's tools once across runs instead of once per run", async () => {
    const state = { failNext: false, initializations: 0, lists: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const connector = connectorFor([ASSIGNMENT]);

    for (let run = 0; run < 5; run += 1) {
      const tools = await connector.discoverTools(contextFor("bot-1"));
      expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    }

    expect(state.lists).toBe(1);
    await connector.close();
  });

  it("shares one catalog between bots that use the same server and credentials", async () => {
    const state = { failNext: false, initializations: 0, lists: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const prisma = {
      botMcpServer: {
        findMany: vi.fn(async ({ where }: { where: { botId: string } }) => [
          { ...ASSIGNMENT, botId: where.botId },
        ]),
      },
      mcpCatalogStatus: { upsert: vi.fn() },
    };
    const connector = new McpConnector(prisma as never, {} as never, { network: NETWORK });

    await connector.discoverTools(contextFor("bot-1"));
    await connector.discoverTools(contextFor("bot-2"));
    await connector.discoverTools(contextFor("bot-3"));

    expect(state.lists).toBe(1);
    await connector.close();
  });

  it("collapses concurrent runs against one server into a single list", async () => {
    const state = { failNext: false, initializations: 0, lists: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const connector = connectorFor([ASSIGNMENT]);

    const runs = await Promise.all(
      Array.from({ length: 10 }, () => connector.discoverTools(contextFor("bot-1"))),
    );

    for (const tools of runs) expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    expect(state.lists).toBe(1);
    await connector.close();
  });

  it("keeps the bot's tools when a later tools/list fails", async () => {
    let time = 1_000;
    const state = { failNext: false, initializations: 0, lists: 0, listStatus: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const connector = connectorFor([ASSIGNMENT], { ttlMs: 60_000, now: () => time });

    expect((await connector.discoverTools(contextFor("bot-1"))).length).toBe(1);

    // The server that motivated this exhausts its CPU budget on tools/list and answers 5xx.
    state.listStatus = 500;
    time += 61_000;
    const tools = await connector.discoverTools(contextFor("bot-1"));

    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    await connector.close();
  });

  it("keeps the session alive when the server rejects a refresh but stays reachable", async () => {
    let time = 1_000;
    const state = { failNext: false, initializations: 0, lists: 0, listStatus: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const connector = connectorFor([ASSIGNMENT], { ttlMs: 60_000, now: () => time });

    await connector.discoverTools(contextFor("bot-1"));
    expect(state.initializations).toBe(1);

    state.listStatus = 503;
    time += 61_000;
    await connector.discoverTools(contextFor("bot-1"));

    // Reconnecting would charge a fresh handshake to a server that just said it was overloaded,
    // so the recovered refresh must go out on the session that was already open.
    state.listStatus = 0;
    time += MCP_CATALOG_BACKOFF_MS[0]! + 1_000;
    expect((await connector.discoverTools(contextFor("bot-1"))).length).toBe(1);

    expect(state.initializations).toBe(1);
    await connector.close();
  });

  it("drops the session when the server rejects the refresh as unauthorized", async () => {
    let time = 1_000;
    const state = { failNext: false, initializations: 0, lists: 0, listStatus: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const connector = connectorFor([ASSIGNMENT], { ttlMs: 60_000, now: () => time });

    await connector.discoverTools(contextFor("bot-1"));
    expect(state.initializations).toBe(1);

    // 403 is about this session's credentials, not about load, so the session is worth replacing.
    state.listStatus = 403;
    time += 61_000;
    await connector.discoverTools(contextFor("bot-1"));

    state.listStatus = 0;
    time += MCP_CATALOG_BACKOFF_MS[0]! + 1_000;
    await connector.discoverTools(contextFor("bot-1"));

    expect(state.initializations).toBe(2);
    await connector.close();
  });

  it("reports no tools when the first discovery of a server fails", async () => {
    const state = { failNext: false, initializations: 0, lists: 0, listStatus: 500 };
    vi.stubGlobal("fetch", mcpFetch(state));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const connector = connectorFor([ASSIGNMENT]);

    expect(await connector.discoverTools(contextFor("bot-1"))).toEqual([]);
    await connector.close();
  });

  it("lists again after the server revision changes", async () => {
    const state = { failNext: false, initializations: 0, lists: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const revised = { ...ASSIGNMENT, server: { ...SERVER, revision: 2 } };
    const prisma = {
      botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) },
      mcpCatalogStatus: { upsert: vi.fn() },
    };
    const connector = new McpConnector(prisma as never, {} as never, { network: NETWORK });

    await connector.discoverTools(contextFor("bot-1"));
    expect(state.lists).toBe(1);

    // A manual refresh, like any server edit, reaches every process by bumping the revision.
    prisma.botMcpServer.findMany.mockResolvedValue([revised]);
    await connector.discoverTools(contextFor("bot-1"));

    expect(state.lists).toBe(2);
    await connector.close();
  });

  it("relists before the TTL once the server announces its tools changed", async () => {
    let time = 1_000;
    let announce = false;
    let lists = 0;
    // Streamable HTTP may answer a POST with an SSE stream, so the notification rides along with
    // the response to tools/list. It is written first so it is parsed before the stream closes.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const message = JSON.parse(await request.text()) as { id?: number; method?: string };
      if (message.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "test", version: "1" },
          },
        });
      }
      if (message.method !== "tools/list") return new Response(null, { status: 202 });
      lists += 1;
      const result = {
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [{ name: `tool_${lists}`, inputSchema: { type: "object" } }] },
      };
      const events = [
        ...(announce ? [{ jsonrpc: "2.0", method: "notifications/tools/list_changed" }] : []),
        result,
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const connector = connectorFor([ASSIGNMENT], { ttlMs: 60_000, now: () => time });

    announce = true;
    expect((await connector.discoverTools(contextFor("bot-1")))[0]?.name).toBe("mcp__demo__tool_1");
    announce = false;

    // Well inside the TTL: only the announcement can explain a second list.
    time += 1_000;
    expect((await connector.discoverTools(contextFor("bot-1")))[0]?.name).toBe("mcp__demo__tool_2");
    expect(lists).toBe(2);

    // With nothing announced the catalog is served from cache again.
    time += 1_000;
    await connector.discoverTools(contextFor("bot-1"));
    expect(lists).toBe(2);

    await connector.close();
  });

  it("records what a listing found so the API can report it", async () => {
    const state = { failNext: false, initializations: 0, lists: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    const { connector, upsert } = connectorRecordingStatus();

    await connector.discoverTools(contextFor("bot-1"));

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({
      where: { serverId: "server-1" },
      update: { revision: 1, toolCount: 1, lastError: null, lastErrorAt: null },
    });
    await connector.close();
  });

  it("writes nothing for runs served from the cache", async () => {
    let time = 1_000;
    const state = { failNext: false, initializations: 0, lists: 0, listStatus: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { connector, upsert } = connectorRecordingStatus({ ttlMs: 60_000, now: () => time });

    await connector.discoverTools(contextFor("bot-1"));
    // Cache hits are not news about the server.
    await connector.discoverTools(contextFor("bot-1"));
    expect(upsert).toHaveBeenCalledTimes(1);

    state.listStatus = 503;
    time += 61_000;
    await connector.discoverTools(contextFor("bot-1"));
    expect(upsert).toHaveBeenCalledTimes(2);

    // Neither is a run inside the backoff window, which never asks the server anything.
    time += 1_000;
    await connector.discoverTools(contextFor("bot-1"));
    expect(upsert).toHaveBeenCalledTimes(2);
    await connector.close();
  });

  it("records a failed refresh without discarding the tool count it last saw", async () => {
    let time = 1_000;
    const state = { failNext: false, initializations: 0, lists: 0, listStatus: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { connector, upsert } = connectorRecordingStatus({ ttlMs: 60_000, now: () => time });

    await connector.discoverTools(contextFor("bot-1"));
    state.listStatus = 503;
    time += 61_000;
    await connector.discoverTools(contextFor("bot-1"));

    const update = upsert.mock.calls[1]?.[0]?.update as Record<string, unknown>;
    expect(update.lastError).toEqual(expect.any(String));
    // toolCount and listedAt are left alone, so the UI can still say how many tools are in play.
    expect(update).not.toHaveProperty("toolCount");
    expect(update).not.toHaveProperty("listedAt");
    await connector.close();
  });

  it("keeps serving tools when the status write fails", async () => {
    const state = { failNext: false, initializations: 0, lists: 0 };
    vi.stubGlobal("fetch", mcpFetch(state));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const prisma = {
      botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) },
      mcpCatalogStatus: { upsert: vi.fn().mockRejectedValue(new Error("db down")) },
    };
    const connector = new McpConnector(prisma as never, {} as never, { network: NETWORK });

    // Status is a report about discovery, not part of it.
    const tools = await connector.discoverTools(contextFor("bot-1"));

    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    await connector.close();
  });

  it("does not let one failing server hide another server's tools", async () => {
    const state = { failNext: false, initializations: 0, lists: 0 };
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).hostname === "broken.example.test")
        return new Response("nope", { status: 500 });
      return mcpFetch(state)(request);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      ...ASSIGNMENT,
      serverId: "server-2",
      server: {
        ...SERVER,
        id: "server-2",
        slug: "broken",
        endpoint: "https://broken.example.test/mcp",
      },
    };
    const connector = connectorFor([broken, ASSIGNMENT]);

    const tools = await connector.discoverTools(contextFor("bot-1"));

    expect(tools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
    await connector.close();
  });
});

describe("allowlistDrift", () => {
  it("names the allowed tools the server no longer offers", () => {
    const offered = [{ name: "echo" }, { name: "upper" }];
    expect(allowlistDrift(["echo", "vanished_tool"], offered)).toEqual({
      missing: ["vanished_tool"],
      offered: 2,
      stringAllowedCount: 2,
    });
    expect(allowlistDrift(["echo"], offered).missing).toEqual([]);
    // allowedTools is a Json column, so it can hold anything: it must not throw.
    expect(allowlistDrift(null, offered)).toEqual({
      missing: [],
      offered: 2,
      stringAllowedCount: 0,
    });
    // Non-string JSON values are ignored for both missing and the warning ratio.
    expect(allowlistDrift([42, "vanished_tool"], offered)).toEqual({
      missing: ["vanished_tool"],
      offered: 2,
      stringAllowedCount: 1,
    });
  });
});
