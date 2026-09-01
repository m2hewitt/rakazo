/**
 * Tool catalogs change when a server is edited, not when a bot runs. Listing them once per run
 * put the load of every run on the MCP server; servers with an expensive `tools/list` answered by
 * exhausting their own CPU budget, and the bot then saw zero tools. The catalog is cached per
 * server identity, refreshed on a TTL, and kept across a failed refresh.
 */
export type McpListedTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

/** Long enough that a burst of runs costs one `tools/list`, short enough to pick up server edits. */
export const MCP_CATALOG_TTL_MS = 15 * 60 * 1000;

/** Consecutive failed refreshes back off on this ladder; the last step repeats. */
export const MCP_CATALOG_BACKOFF_MS = [30_000, 120_000, 600_000] as const;

export type McpCatalogOutcome =
  | { status: "hit"; tools: McpListedTool[]; ageMs: number }
  | { status: "refreshed"; tools: McpListedTool[]; durationMs: number }
  /** The refresh failed, or is backing off, but a catalog from before it survives. */
  | { status: "stale"; tools: McpListedTool[]; ageMs: number; error: unknown }
  | { status: "failed"; error: unknown };

type CatalogEntry = {
  tools: McpListedTool[];
  revision: number;
  fetchedAt: number;
  /** Set by a `notifications/tools/list_changed`: serve these tools, but refresh before the TTL. */
  stale: boolean;
  failures: number;
  retryAt: number;
  lastError?: unknown;
};

type PendingRefresh = { revision: number; promise: Promise<McpListedTool[]> };

function backoffFor(failures: number): number {
  const step = Math.min(Math.max(failures, 1), MCP_CATALOG_BACKOFF_MS.length);
  return MCP_CATALOG_BACKOFF_MS[step - 1]!;
}

/**
 * Keyed by server identity rather than by bot, so every bot sharing one server and one set of
 * credentials shares the catalog. Allowlist filtering stays with the caller: the cache holds what
 * the server offers, not what a given bot may call.
 */
export class McpCatalogCache {
  private readonly entries = new Map<string, CatalogEntry>();
  private readonly refreshing = new Map<string, PendingRefresh>();
  /** Counts announcements per server, so one that lands mid-refresh is not lost to its result. */
  private readonly announcements = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? MCP_CATALOG_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async get(
    key: string,
    revision: number,
    load: () => Promise<McpListedTool[]>,
  ): Promise<McpCatalogOutcome> {
    // A new revision means endpoint, transport, headers or credentials changed, so the catalog
    // they produced is not evidence about the server as it is now configured.
    const cached = this.entries.get(key);
    if (cached && cached.revision !== revision) this.entries.delete(key);
    const entry = cached?.revision === revision ? cached : undefined;

    if (entry && !entry.stale && this.now() - entry.fetchedAt < this.ttlMs) {
      return { status: "hit", tools: entry.tools, ageMs: this.now() - entry.fetchedAt };
    }
    if (entry && this.now() < entry.retryAt) {
      return {
        status: "stale",
        tools: entry.tools,
        ageMs: this.now() - entry.fetchedAt,
        error: entry.lastError,
      };
    }

    const startedAt = this.now();
    try {
      const tools = await this.refresh(key, revision, load);
      return { status: "refreshed", tools, durationMs: this.now() - startedAt };
    } catch (error) {
      const survivor = this.recordFailure(key, revision, error);
      if (!survivor) return { status: "failed", error };
      return {
        status: "stale",
        tools: survivor.tools,
        ageMs: this.now() - survivor.fetchedAt,
        error,
      };
    }
  }

  /** A server that announced changed tools keeps serving its catalog until the next refresh. */
  markStale(key: string): void {
    this.announcements.set(key, (this.announcements.get(key) ?? 0) + 1);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.stale = true;
    // An announcement is fresh information: it outranks a backoff left by an earlier failure.
    entry.retryAt = 0;
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.refreshing.clear();
    this.announcements.clear();
  }

  /** Concurrent runs against one server share a single `tools/list`. */
  private refresh(
    key: string,
    revision: number,
    load: () => Promise<McpListedTool[]>,
  ): Promise<McpListedTool[]> {
    const pending = this.refreshing.get(key);
    if (pending?.revision === revision) return pending.promise;

    // A server can announce changed tools on the very stream that carries this list. Comparing
    // the announcement count across the call keeps that from being overwritten by its result.
    const announcedBefore = this.announcements.get(key) ?? 0;
    const promise = load().then((tools) => {
      this.entries.set(key, {
        tools,
        revision,
        fetchedAt: this.now(),
        stale: (this.announcements.get(key) ?? 0) !== announcedBefore,
        failures: 0,
        retryAt: 0,
      });
      return tools;
    });
    const started: PendingRefresh = { revision, promise };
    this.refreshing.set(key, started);
    return promise.finally(() => {
      if (this.refreshing.get(key) === started) this.refreshing.delete(key);
    });
  }

  private recordFailure(key: string, revision: number, error: unknown): CatalogEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.revision !== revision) return undefined;
    entry.failures += 1;
    entry.lastError = error;
    entry.retryAt = this.now() + backoffFor(entry.failures);
    return entry;
  }
}
