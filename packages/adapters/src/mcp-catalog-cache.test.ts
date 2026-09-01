import { describe, expect, it, vi } from "vitest";
import { MCP_CATALOG_BACKOFF_MS, McpCatalogCache } from "./mcp-catalog-cache.js";

const TOOLS = [{ name: "echo", inputSchema: { type: "object" } }];
const OTHER = [{ name: "upper", inputSchema: { type: "object" } }];

function clock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

describe("McpCatalogCache", () => {
  it("lists a server's tools once for repeated runs inside the TTL", async () => {
    const time = clock();
    const cache = new McpCatalogCache({ ttlMs: 60_000, now: time.now });
    const load = vi.fn().mockResolvedValue(TOOLS);

    expect(await cache.get("ad", 1, load)).toMatchObject({ status: "refreshed", tools: TOOLS });
    time.advance(59_000);
    expect(await cache.get("ad", 1, load)).toMatchObject({ status: "hit", ageMs: 59_000 });
    expect(load).toHaveBeenCalledTimes(1);

    time.advance(2_000);
    expect(await cache.get("ad", 1, load)).toMatchObject({ status: "refreshed" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps concurrent runs against one server to a single list", async () => {
    const cache = new McpCatalogCache({ now: clock().now });
    let release = (_: typeof TOOLS) => {};
    const load = vi.fn(
      () =>
        new Promise<typeof TOOLS>((resolve) => {
          release = resolve;
        }),
    );

    const runs = Promise.all(Array.from({ length: 10 }, () => cache.get("ad", 1, load)));
    release(TOOLS);

    for (const outcome of await runs) expect(outcome).toMatchObject({ tools: TOOLS });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("serves the previous catalog when a refresh fails", async () => {
    const time = clock();
    const cache = new McpCatalogCache({ ttlMs: 60_000, now: time.now });
    const load = vi
      .fn()
      .mockResolvedValueOnce(TOOLS)
      .mockRejectedValue(
        Object.assign(new Error("Worker exceeded resource limits"), { code: 500 }),
      );

    await cache.get("ad", 1, load);
    time.advance(61_000);

    expect(await cache.get("ad", 1, load)).toMatchObject({
      status: "stale",
      tools: TOOLS,
      ageMs: 61_000,
    });
  });

  it("reports failure when the first ever discovery fails", async () => {
    const cache = new McpCatalogCache({ now: clock().now });
    const load = vi.fn().mockRejectedValue(new Error("boom"));

    expect(await cache.get("ad", 1, load)).toMatchObject({ status: "failed" });
  });

  it("backs off instead of retrying a failing server on every run", async () => {
    const time = clock();
    const cache = new McpCatalogCache({ ttlMs: 60_000, now: time.now });
    const load = vi.fn().mockResolvedValueOnce(TOOLS).mockRejectedValue(new Error("503"));

    await cache.get("ad", 1, load);
    time.advance(61_000);
    await cache.get("ad", 1, load);
    expect(load).toHaveBeenCalledTimes(2);

    // Runs inside the backoff window are served from cache without touching the server.
    time.advance(MCP_CATALOG_BACKOFF_MS[0] - 1_000);
    expect(await cache.get("ad", 1, load)).toMatchObject({ status: "stale", tools: TOOLS });
    expect(load).toHaveBeenCalledTimes(2);

    time.advance(2_000);
    await cache.get("ad", 1, load);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("widens the backoff window as failures repeat", async () => {
    const time = clock();
    const cache = new McpCatalogCache({ ttlMs: 60_000, now: time.now });
    const load = vi.fn().mockResolvedValueOnce(TOOLS).mockRejectedValue(new Error("503"));

    await cache.get("ad", 1, load);
    for (const window of MCP_CATALOG_BACKOFF_MS) {
      time.advance(window);
      await cache.get("ad", 1, load);
    }
    const attempts = load.mock.calls.length;

    // The ladder's last step is longer than its first, so the first window no longer clears it.
    time.advance(MCP_CATALOG_BACKOFF_MS[0]);
    await cache.get("ad", 1, load);
    expect(load).toHaveBeenCalledTimes(attempts);
  });

  it("discards a catalog listed under a different server revision", async () => {
    const time = clock();
    const cache = new McpCatalogCache({ ttlMs: 60_000, now: time.now });
    const load = vi.fn().mockResolvedValueOnce(TOOLS).mockResolvedValue(OTHER);

    await cache.get("ad", 1, load);
    expect(await cache.get("ad", 2, load)).toMatchObject({ status: "refreshed", tools: OTHER });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not answer a new revision with the catalog of the old one", async () => {
    const cache = new McpCatalogCache({ now: clock().now });
    await cache.get("ad", 1, vi.fn().mockResolvedValue(TOOLS));

    // A revision bump means the credentials or endpoint changed; the old tools prove nothing,
    // so a failed refresh has nothing safe to fall back on.
    const failing = vi.fn().mockRejectedValue(new Error("503"));
    expect(await cache.get("ad", 2, failing)).toMatchObject({ status: "failed" });
  });

  it("refreshes before the TTL once the server announces changed tools", async () => {
    const time = clock();
    const cache = new McpCatalogCache({ ttlMs: 60_000, now: time.now });
    const load = vi.fn().mockResolvedValueOnce(TOOLS).mockResolvedValue(OTHER);

    await cache.get("ad", 1, load);
    cache.markStale("ad");

    expect(await cache.get("ad", 1, load)).toMatchObject({ status: "refreshed", tools: OTHER });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not let a refresh bury an announcement that arrived while it ran", async () => {
    const time = clock();
    const cache = new McpCatalogCache({ ttlMs: 60_000, now: time.now });
    // Streamable HTTP can carry the announcement on the same stream as the list it answers.
    const load = vi
      .fn()
      .mockImplementationOnce(async () => {
        cache.markStale("ad");
        return TOOLS;
      })
      .mockResolvedValue(OTHER);

    expect(await cache.get("ad", 1, load)).toMatchObject({ status: "refreshed", tools: TOOLS });
    expect(await cache.get("ad", 1, load)).toMatchObject({ status: "refreshed", tools: OTHER });
    // Nothing was announced the second time, so the catalog settles instead of looping.
    expect(await cache.get("ad", 1, load)).toMatchObject({ status: "hit" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("lets an announcement cut short a backoff left by an earlier failure", async () => {
    const time = clock();
    const cache = new McpCatalogCache({ ttlMs: 60_000, now: time.now });
    const load = vi.fn().mockResolvedValueOnce(TOOLS).mockRejectedValueOnce(new Error("503"));

    await cache.get("ad", 1, load);
    time.advance(61_000);
    await cache.get("ad", 1, load);
    expect(load).toHaveBeenCalledTimes(2);

    load.mockResolvedValue(OTHER);
    cache.markStale("ad");
    expect(await cache.get("ad", 1, load)).toMatchObject({ status: "refreshed", tools: OTHER });
  });

  it("lists again after the catalog is invalidated", async () => {
    const cache = new McpCatalogCache({ now: clock().now });
    const load = vi.fn().mockResolvedValue(TOOLS);

    await cache.get("ad", 1, load);
    cache.invalidate("ad");
    await cache.get("ad", 1, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps catalogs of different servers apart", async () => {
    const cache = new McpCatalogCache({ now: clock().now });

    await cache.get("ad", 1, vi.fn().mockResolvedValue(TOOLS));
    const other = await cache.get("other", 1, vi.fn().mockResolvedValue(OTHER));

    expect(other).toMatchObject({ status: "refreshed", tools: OTHER });
  });
});
