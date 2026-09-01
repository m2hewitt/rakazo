-- Discovery caches each MCP server's tool list in the worker process. The API cannot read that
-- memory, so the outcome of the last listing is recorded here for the UI to report.

CREATE TABLE "mcp_catalog_status" (
    "serverId" TEXT NOT NULL,
    "revision" INTEGER,
    "toolCount" INTEGER,
    -- Null until a listing has succeeded; a server that has only ever failed still gets a row.
    "listedAt" TIMESTAMP(3),
    "refreshedAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),

    CONSTRAINT "mcp_catalog_status_pkey" PRIMARY KEY ("serverId")
);

-- The status is meaningless without its server, and deleting a server must not strand it.
ALTER TABLE "mcp_catalog_status" ADD CONSTRAINT "mcp_catalog_status_serverId_fkey"
    FOREIGN KEY ("serverId") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
