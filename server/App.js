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
    const { createStorageRouter } = await import('./routes/storageRouter.js');
    const { createMcpRouter } = await import('./mcp/createMcpRouter.js');
    const { LogService } = await import('./logging/LogService.js');
    const { createLogRouter } = await import('./routes/logRouter.js');
    const storageService = new StorageService();
    const logService = new LogService();

    // Parse JSON only for Express-owned routes. A global body parser locks the
    // request stream and breaks Next.js App Router handlers (e.g. POST
    // /api/scripting/compile) that need to read the body themselves.
    const jsonParser = express.json({ limit: '20mb' });
    server.use('/api/logs', createLogRouter(logService));
    server.use('/api/storage', jsonParser, createStorageRouter(storageService));
    server.use('/mcp', jsonParser, createMcpRouter(storageService, logService));

    server.all(/(.*)/, (req, res) => {
        return handle(req, res);
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, (err) => {
        if (err) throw err;
        console.log(`> Ready on http://localhost:${PORT}`);
        console.log(`> MCP endpoint: http://localhost:${PORT}/mcp`);
    });
})
