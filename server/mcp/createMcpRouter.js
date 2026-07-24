import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerEnvironmentTools } from "./environmentTools.js";
import { registerScriptingTools } from "./scriptingTools.js";
import { registerBindingTools } from "./bindingTools.js";
import { registerLoggingTools } from "./loggingTools.js";

/**
 * Build an Express router that serves the cev-sim MCP endpoint.
 *
 * Stateless Streamable HTTP: a fresh McpServer + transport per request so
 * concurrent agent sessions do not share mutable server state.
 *
 * @param {import("../storage/StorageService.js").StorageService} storage
 * @param {import("../logging/LogService.js").LogService} logService
 */
export function createMcpRouter(storage, logService) {
    const router = express.Router();

    router.all("/", async (req, res) => {
        const server = createSensorFusionMcpServer(storage, logService);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });

        res.on("close", () => {
            transport.close().catch(() => {});
            server.close().catch(() => {});
        });

        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            console.error("[mcp] request failed:", error);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: error?.message || "Internal MCP error" },
                    id: null,
                });
            }
        }
    });

    return router;
}

/**
 * @param {import("../storage/StorageService.js").StorageService} storage
 * @param {import("../logging/LogService.js").LogService} logService
 */
export function createSensorFusionMcpServer(storage, logService) {
    const server = new McpServer({
        name: "cev-sim",
        version: "0.1.0",
    });

    registerEnvironmentTools(server, storage);
    registerScriptingTools(server, storage);
    registerBindingTools(server, storage);
    registerLoggingTools(server, logService);

    return server;
}
