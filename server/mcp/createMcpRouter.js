import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerEnvironmentTools } from "./environmentTools.js";
import { registerScriptingTools } from "./scriptingTools.js";
import { registerBindingTools } from "./bindingTools.js";

/**
 * Build an Express router that serves the sensor-fusion MCP endpoint.
 *
 * Stateless Streamable HTTP: a fresh McpServer + transport per request so
 * concurrent agent sessions do not share mutable server state.
 *
 * @param {import("../storage/StorageService.js").StorageService} storage
 */
export function createMcpRouter(storage) {
    const router = express.Router();

    router.all("/", async (req, res) => {
        const server = createSensorFusionMcpServer(storage);
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
 */
export function createSensorFusionMcpServer(storage) {
    const server = new McpServer({
        name: "sensor-fusion",
        version: "0.1.0",
    });

    registerEnvironmentTools(server, storage);
    registerScriptingTools(server, storage);
    registerBindingTools(server, storage);

    return server;
}
