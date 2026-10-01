const express = require('express');
const next = require('next');
const path = require('node:path');
const { loadEnvConfig } = require('@next/env');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const dev = process.env.NODE_ENV !== 'production';
loadEnvConfig(REPOSITORY_ROOT, dev);
const app = next({ dev });
const handle = app.getRequestHandler();

// just general logging + preflight checks
const ready = require("./startup.js").startup(REPOSITORY_ROOT, process.env);

if (!ready) {
    process.exit(1);
}

app.prepare().then(async () => {
    const server = express();

    const { resolveMarketplaceConfig } = await import('./marketplace/MarketplaceConfig.js');
    server.locals.marketplaceConfig = resolveMarketplaceConfig(process.env);

    // Storage API: persists environment edits, scripts, and bindings to disk.
    // The storage modules are ESM, so load them dynamically from this CommonJS file.
    const { StorageService } = await import('./storage/StorageService.js');
    const { mountStorageApi } = await import('./routes/storageApi.js');
    const { createMcpRouter } = await import('./mcp/createMcpRouter.js');
    const { createScriptingRouter } = await import('./scripting/scriptingRouter.js');
    const { LogService } = await import('./logging/LogService.js');
    const { createLogRouter } = await import('./routes/logRouter.js');
    const { HeadlessExperimentService } = await import('./headless/HeadlessExperimentService.js');
    const { HEADLESS_PROTOCOL } = await import('./headless/HeadlessProtocol.js');
    const { readSupervisorConfigFromEnv } = await import('./headless/SupervisorConfig.js');
    const { createHeadlessRouter } = await import('./routes/headlessRouter.js');
    const { CosmosClipJob } = await import('./headless/CosmosClipJob.js');
    const {
        createRequestSecurityMiddleware,
        resolveHttpSecurityConfig,
    } = await import('./security/RequestSecurity.js');
    const httpSecurity = resolveHttpSecurityConfig(process.env);
    const storageService = new StorageService(process.env.CEV_SIM_DATA_DIR, {
        visualAssets: {
            registryPath: process.env.CEV_SIM_VISUAL_SOURCE_REGISTRY || undefined,
        },
        bakeOutputSourceIds: process.env.CEV_SIM_BAKE_OUTPUT_SOURCE_IDS,
        // Environment writes are schema v4 (document.objects authoring overlay).
        // The ED-02 env-var opt-out was retired in ED-03; `environmentSchemaVersion: 3`
        // remains a test-only StorageService option.
    });
    let marketplaceService = null;
    let MarketplaceService = null;
    let createMarketplaceRouter = null;
    let createMarketplaceHostProfile = null;
    if (server.locals.marketplaceConfig.enabled) {
        const marketplaceServiceModule = await import('./marketplace/client/MarketplaceService.js');
        const marketplaceRouterModule = await import('./routes/marketplaceRouter.js');
        const marketplaceCompatibilityModule = await import('./marketplace/client/MarketplaceCompatibility.js');
        MarketplaceService = marketplaceServiceModule.MarketplaceService;
        createMarketplaceRouter = marketplaceRouterModule.createMarketplaceRouter;
        createMarketplaceHostProfile = marketplaceCompatibilityModule.createMarketplaceHostProfile;
    }
    const logService = new LogService(process.env.CEV_SIM_LOGS_DIR, {
        maxImportBytes: process.env.CEV_SIM_MAX_LOG_IMPORT_BYTES
            ? Number(process.env.CEV_SIM_MAX_LOG_IMPORT_BYTES)
            : undefined,
    });
    let supervisorConfig;
    let supervisorConfigError = null;
    try {
        supervisorConfig = await readSupervisorConfigFromEnv(process.env, REPOSITORY_ROOT) ?? undefined;
    } catch (error) {
        supervisorConfigError = error.message;
        console.error(`[headless] ${error.message}`);
    }
    const headlessExperimentService = new HeadlessExperimentService(storageService, logService, {
        supervisorConfig,
    });
    await headlessExperimentService.initialize();
    if (MarketplaceService) {
        const { storageEvents } = await import('./mcp/events.js');
        marketplaceService = await MarketplaceService.open(storageService.dataDir, {
            pluginStore: storageService.plugins,
            storageService,
            editorAssetStore: storageService.editorAssets,
            visualAssetStore: storageService.visualAssets,
            publishPluginLibraryChange: async ({ pluginId, action, packageHash, revision }) => {
                storageEvents.publish({
                    domain: 'plugin',
                    id: pluginId,
                    action,
                    data: { packageHash, revision },
                });
            },
            hostProfileProvider: async () => createMarketplaceHostProfile({
                supervisorCapabilities: await headlessExperimentService.supervisor.getCapabilities({
                    clientProtocol: HEADLESS_PROTOCOL,
                }),
            }),
            connectionDirectory: server.locals.marketplaceConfig.connectionsDir,
        });
        storageService.setMarketplaceExecutablePolicy(marketplaceService.executablePolicy);
        server.locals.marketplaceService = marketplaceService;
    }
    const cosmosClipJob = new CosmosClipJob({
        artifactRoot: headlessExperimentService.artifactRoot,
        renderer: headlessExperimentService.supervisor.config.renderer,
        resolveRenderer: async () => {
            const loaded = await readSupervisorConfigFromEnv(process.env, REPOSITORY_ROOT);
            return loaded?.renderer ?? {};
        },
        gpuTurn: headlessExperimentService.gpuTurn,
        managedBusy: () => headlessExperimentService.managedWorkPending(),
        supervisor: headlessExperimentService.supervisor,
        storage: storageService,
    });
    await cosmosClipJob.initialize();

    // Parse JSON only for Express-owned routes. A global body parser locks the
    // request stream and breaks Next.js App Router handlers that still need to
    // read the body themselves. Plugin catalog/compile live on Express so they
    // can use StorageService.
    server.use(['/api', '/mcp'], createRequestSecurityMiddleware(httpSecurity));
    const jsonParser = express.json({ limit: process.env.CEV_SIM_JSON_LIMIT || '8mb' });
    const headlessJsonParser = express.json({ limit: process.env.CEV_SIM_HEADLESS_JSON_LIMIT || '1mb' });
    if (marketplaceService) server.use('/api/marketplace', createMarketplaceRouter(marketplaceService));
    server.use('/api/logs', createLogRouter(logService));
    mountStorageApi(server, storageService, { jsonParser });
    server.use('/api/scripting', jsonParser, createScriptingRouter(storageService));
    server.use('/api/headless', headlessJsonParser, createHeadlessRouter(headlessExperimentService, cosmosClipJob));
    if (supervisorConfigError) cosmosClipJob.rendererError = supervisorConfigError;
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

    const { RemoteRevisionProbe } = await import('./revision/RemoteRevisionProbe.js');
    const { createRevisionRouter } = await import('./routes/revisionRouter.js');
    const revisionProbe = new RemoteRevisionProbe({ repoRoot: REPOSITORY_ROOT });
    await revisionProbe.start();
    server.use('/api/revision', createRevisionRouter(revisionProbe));

    server.all(/(.*)/, (req, res) => {
        return handle(req, res);
    });

    const PORT = process.env.PORT || 3000;
    const httpServer = server.listen(PORT, httpSecurity.bindHost, (err) => {
        if (err) throw err;
        console.log(`> Ready on http://${httpSecurity.bindHost}:${PORT}`);
        console.log(`> MCP endpoint: http://${httpSecurity.bindHost}:${PORT}/mcp`);
    });

    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        httpServer.close();
        await marketplaceService?.close();
        await headlessExperimentService.close();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
})
