const express = require('express');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
    const server = express();

    // Storage API: persists environment edits, scripts, and bindings to disk.
    // The storage modules are ESM, so load them dynamically from this CommonJS file.
    const { StorageService } = await import('./storage/StorageService.js');
    const { mountStorageApi } = await import('./routes/storageApi.js');
    const { createMcpRouter } = await import('./mcp/createMcpRouter.js');
    const { LogService } = await import('./logging/LogService.js');
    const { createLogRouter } = await import('./routes/logRouter.js');
    const { HeadlessExperimentService } = await import('./headless/HeadlessExperimentService.js');
    const { readSupervisorConfig } = await import('./headless/SupervisorConfig.js');
    const { createHeadlessRouter } = await import('./routes/headlessRouter.js');
    const storageService = new StorageService(process.env.CEV_SIM_DATA_DIR, {
        visualAssets: {
            registryPath: process.env.CEV_SIM_VISUAL_SOURCE_REGISTRY || undefined,
        },
        bakeOutputSourceIds: process.env.CEV_SIM_BAKE_OUTPUT_SOURCE_IDS,
        // Environment writes are schema v4 (document.objects authoring overlay).
        // The ED-02 env-var opt-out was retired in ED-03; `environmentSchemaVersion: 3`
        // remains a test-only StorageService option.
    });
    const logService = new LogService(process.env.CEV_SIM_LOGS_DIR);
    const supervisorConfig = process.env.CEV_SIM_HEADLESS_SUPERVISOR_CONFIG
        ? await readSupervisorConfig(process.env.CEV_SIM_HEADLESS_SUPERVISOR_CONFIG)
        : undefined;
    const headlessExperimentService = new HeadlessExperimentService(storageService, logService, {
        supervisorConfig,
    });
    await headlessExperimentService.initialize();

    // Parse JSON only for Express-owned routes. A global body parser locks the
    // request stream and breaks Next.js App Router handlers (e.g. POST
    // /api/scripting/compile) that need to read the body themselves.
    const jsonParser = express.json({ limit: '20mb' });
    server.use('/api/logs', createLogRouter(logService));
    mountStorageApi(server, storageService, { jsonParser });
    server.use('/api/headless', jsonParser, createHeadlessRouter(headlessExperimentService));
    const path = require("node:path");
    // three does not export `./package.json`; resolve the pinned Basis files via
    // the exported `examples/jsm` glob instead.
    const THREE_BASIS_DIR = path.dirname(
        require.resolve("three/examples/jsm/libs/basis/basis_transcoder.js"),
    );
    server.use("/vendor/basis", express.static(THREE_BASIS_DIR, {
        fallthrough: false,
        index: false,
        maxAge: "1y",
        immutable: true,
    }));
    server.use('/mcp', jsonParser, createMcpRouter(storageService, logService, headlessExperimentService));

    server.all(/(.*)/, (req, res) => {
        return handle(req, res);
    });

    const PORT = process.env.PORT || 3000;
    const httpServer = server.listen(PORT, (err) => {
        if (err) throw err;
        console.log(`> Ready on http://localhost:${PORT}`);
        console.log(`> MCP endpoint: http://localhost:${PORT}/mcp`);
    });

    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        httpServer.close();
        await headlessExperimentService.close();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
})
