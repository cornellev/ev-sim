import express from "express";
import { storageEvents } from "../mcp/events.js";

/**
 * Builds the Express router mounted at `/api/storage`.
 *
 * This layer is intentionally thin: it only translates HTTP requests into
 * StorageService calls and serializes the results back as JSON. All storage
 * behavior (caching, atomic writes, on-disk layout) lives in StorageService.
 *
 * @param {import("../storage/StorageService.js").StorageService} service
 */
export function createStorageRouter(service) {
    const router = express.Router();

    // --- Environments ---
    router.get("/environments", handle(async () => service.listEnvironments()));
    router.post("/environments", handle(async (req) => service.createEnvironment(req.body ?? {})));
    router.post("/environments/:id/duplicate", handle(async (req) => (
        service.duplicateEnvironment(req.params.id, req.body ?? {})
    )));
    router.patch("/environments/:id", handle(async (req) => (
        service.renameEnvironment(req.params.id, req.body?.name)
    )));
    router.delete("/environments/:id", handle(async (req) => service.deleteEnvironment(req.params.id)));
    router.get("/environments/:id", handle(async (req) => service.getEnvironment(req.params.id)));
    router.put("/environments/:id", handle(async (req) => service.putEnvironment(req.params.id, req.body)));

    // --- Scripts ---
    router.get("/scripts", handle(async () => service.listScripts()));
    router.get("/scripts/:id", handle(async (req) => service.getScript(req.params.id)));
    router.put("/scripts/:id", handle(async (req) => service.putScript(req.body)));
    router.delete("/scripts/:id", handle(async (req) => service.deleteScript(req.params.id)));

    // --- Bindings ---
    router.get("/bindings", handle(async () => service.getBindings()));
    router.put("/bindings", handle(async (req) => service.putBindings(req.body)));

    // --- Scenarios ---
    router.get("/scenario-catalog", handle(async () => service.getScenarioCatalog()));
    router.put("/scenario-catalog", handle(async (req) => {
        const catalog = await service.putScenarioCatalog(req.body ?? {});
        storageEvents.publish({ domain: "scenario-catalog", action: "updated" });
        return catalog;
    }));
    router.get("/scenarios", handle(async () => service.listScenarios()));
    router.post("/scenarios", handle(async (req) => {
        const scenario = await service.createScenario(req.body ?? {});
        storageEvents.publish({ domain: "scenario", id: scenario.id, action: "created" });
        return scenario;
    }));
    router.post("/scenarios/:id/duplicate", handle(async (req) => {
        const scenario = await service.duplicateScenario(req.params.id, req.body ?? {});
        storageEvents.publish({ domain: "scenario", id: scenario.id, action: "created" });
        return scenario;
    }));
    router.post("/scenarios/:id/validate", handle(async (req) => service.validateScenario(req.params.id, req.body ?? null)));
    router.post("/scenarios/:id/resolve", handle(async (req) => service.resolveScenario(req.params.id, req.body ?? null)));
    router.post("/scenarios/:id/verify-route", handle(async (req) => service.verifyScenarioRoute(req.params.id, req.body ?? {})));
    router.get("/scenarios/:id", handle(async (req) => service.getScenario(req.params.id)));
    router.put("/scenarios/:id", handle(async (req) => {
        const scenario = await service.putScenario(req.params.id, req.body ?? {});
        storageEvents.publish({ domain: "scenario", id: scenario.id, action: "updated" });
        return scenario;
    }));
    router.delete("/scenarios/:id", handle(async (req) => {
        const deleted = await service.deleteScenario(req.params.id, req.query?.expectedRevision);
        if (deleted) storageEvents.publish({ domain: "scenario", id: req.params.id, action: "deleted" });
        return deleted;
    }));

    // --- Experiment suites, results, and immutable baselines ---
    router.get("/experiment-suites", handle(async () => service.listExperimentSuites()));
    router.post("/experiment-suites", handle(async (req) => {
        const suite = await service.createExperimentSuite(req.body ?? {});
        storageEvents.publish({ domain: "experiment-suite", id: suite.id, action: "created" });
        return suite;
    }));
    router.post("/experiment-suites/:id/duplicate", handle(async (req) => {
        const suite = await service.duplicateExperimentSuite(req.params.id, req.body ?? {});
        storageEvents.publish({ domain: "experiment-suite", id: suite.id, action: "created" });
        return suite;
    }));
    router.post("/experiment-suites/:id/validate", handle(async (req) => (
        service.validateExperimentSuite(req.params.id, req.body ?? null)
    )));
    router.post("/experiment-suites/:id/resolve-case", handle(async (req) => (
        service.resolveExperimentCase(req.params.id, req.body ?? {})
    )));
    router.get("/experiment-suites/:id", handle(async (req) => service.getExperimentSuite(req.params.id)));
    router.put("/experiment-suites/:id", handle(async (req) => {
        const suite = await service.putExperimentSuite(req.params.id, req.body ?? {});
        storageEvents.publish({ domain: "experiment-suite", id: suite.id, action: "updated" });
        return suite;
    }));
    router.delete("/experiment-suites/:id", handle(async (req) => {
        const deleted = await service.deleteExperimentSuite(req.params.id, req.query?.expectedRevision);
        if (deleted) storageEvents.publish({ domain: "experiment-suite", id: req.params.id, action: "deleted" });
        return deleted;
    }));

    router.get("/experiment-results", handle(async () => service.listExperimentResults()));
    router.post("/experiment-results", handle(async (req) => {
        const result = await service.createExperimentResult(req.body ?? {});
        storageEvents.publish({ domain: "experiment-result", id: result.id, action: "created" });
        return result;
    }));
    router.get("/experiment-results/:id", handle(async (req) => service.getExperimentResult(req.params.id)));
    router.post("/experiment-results/:id/validate", handle(async (req) => (
        service.validateExperimentResult(req.params.id, req.body ?? null)
    )));
    router.put("/experiment-results/:id", handle(async (req) => {
        const result = await service.putExperimentResult(req.params.id, req.body ?? {});
        storageEvents.publish({ domain: "experiment-result", id: result.id, action: "updated" });
        return result;
    }));
    router.delete("/experiment-results/:id", handle(async (req) => {
        const deleted = await service.deleteExperimentResult(req.params.id, req.query?.expectedRevision);
        if (deleted) storageEvents.publish({ domain: "experiment-result", id: req.params.id, action: "deleted" });
        return deleted;
    }));

    router.get("/experiment-baselines", handle(async (req) => (
        service.listExperimentBaselines(req.query?.suiteId || null)
    )));
    router.post("/experiment-baselines", handle(async (req) => {
        const baseline = await service.createExperimentBaseline(req.body ?? {});
        storageEvents.publish({ domain: "experiment-baseline", id: baseline.id, action: "created" });
        return baseline;
    }));
    router.get("/experiment-baselines/:id", handle(async (req) => service.getExperimentBaseline(req.params.id)));
    router.post("/experiment-baselines/:id/validate", handle(async (req) => (
        service.validateExperimentBaseline(req.params.id, req.body ?? null)
    )));
    router.delete("/experiment-baselines/:id", handle(async (req) => {
        const deleted = await service.deleteExperimentBaseline(req.params.id);
        if (deleted) storageEvents.publish({ domain: "experiment-baseline", id: req.params.id, action: "deleted" });
        return deleted;
    }));

    // --- Simulation run manifests ---
    router.get("/run-manifests", handle(async () => service.listRunManifests()));
    router.post("/run-manifests", handle(async (req) => service.createRunManifest(req.body ?? {})));
    router.post("/run-manifests/import", handle(async (req) => service.importRunBundle(req.body ?? {})));
    router.post("/run-manifests/:id/duplicate", handle(async (req) => service.duplicateRunManifest(req.params.id, req.body ?? {})));
    router.post("/run-manifests/:id/validate", handle(async (req) => service.validateRunManifest(req.params.id, req.body ?? null)));
    router.post("/run-manifests/:id/resolve", handle(async (req) => service.resolveRunManifest(req.params.id, req.body ?? null)));
    router.get("/run-manifests/:id/export", handle(async (req) => service.exportRunManifest(req.params.id)));
    router.get("/run-manifests/:id", handle(async (req) => service.getRunManifest(req.params.id)));
    router.put("/run-manifests/:id", handle(async (req) => service.putRunManifest(req.params.id, req.body ?? {})));
    router.delete("/run-manifests/:id", handle(async (req) => service.deleteRunManifest(req.params.id)));

    // --- Vehicle manifests ---
    router.get("/vehicles", handle(async () => service.listVehicleManifests()));
    router.post("/vehicles", handle(async (req) => service.createVehicleManifest(req.body ?? {})));
    router.post("/vehicles/import", handle(async (req) => service.importVehicleBundle(req.body ?? {})));
    router.post("/vehicles/:id/duplicate", handle(async (req) => service.duplicateVehicleManifest(req.params.id, req.body ?? {})));
    router.post("/vehicles/:id/validate", handle(async (req) => service.validateVehicleManifest(req.params.id, req.body ?? null)));
    router.get("/vehicles/:id/export", handle(async (req) => service.exportVehicleBundle(req.params.id)));
    router.get("/vehicles/:id", handle(async (req) => service.getVehicleManifest(req.params.id)));
    router.put("/vehicles/:id", handle(async (req) => service.putVehicleManifest(req.params.id, req.body ?? {})));
    router.delete("/vehicles/:id", handle(async (req) => service.deleteVehicleManifest(req.params.id)));

    // --- Vehicle model assets (raw binary uploads, not JSON) ---
    const rawBody = express.raw({ limit: "100mb", type: () => true });
    router.put("/vehicle-assets/:id/:file", rawBody, handle(async (req) => {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            throw new Error("A non-empty binary request body is required.");
        }
        return service.putVehicleAsset(req.params.id, req.params.file, req.body);
    }));
    router.get("/vehicle-assets/:id/:file", async (req, res) => {
        try {
            const buffer = await service.readVehicleAsset(req.params.id, req.params.file);
            res.setHeader("Content-Type", assetContentType(req.params.file));
            res.setHeader("Cache-Control", "no-cache");
            res.send(buffer);
        } catch (error) {
            if (error.code === "ENOENT") {
                res.status(404).json({ error: `Asset "${req.params.file}" does not exist.` });
                return;
            }
            console.error(`[storage] GET ${req.originalUrl} failed:`, error);
            res.status(400).json({ error: error.message });
        }
    });
    router.delete("/vehicle-assets/:id/:file", handle(async (req) => service.deleteVehicleAsset(req.params.id, req.params.file)));

    // --- Settings ---
    router.get("/settings/:key", handle(async (req) => ({ value: await service.getSetting(req.params.key) })));
    router.put("/settings/:key", handle(async (req) => ({ value: await service.putSetting(req.params.key, req.body?.value) })));

    // --- MCP live-sync SSE (MCP-originated changes only) ---
    router.get("/events", (req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        res.write(": connected\n\n");

        const onChange = (payload) => {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        storageEvents.on("change", onChange);

        const heartbeat = setInterval(() => {
            res.write(": heartbeat\n\n");
        }, 25000);

        req.on("close", () => {
            clearInterval(heartbeat);
            storageEvents.off("change", onChange);
        });
    });

    return router;
}

function assetContentType(fileName) {
    const lower = String(fileName).toLowerCase();
    if (lower.endsWith(".glb")) return "model/gltf-binary";
    if (lower.endsWith(".gltf")) return "model/gltf+json";
    return "application/octet-stream";
}

/**
 * Wrap an async handler so it always responds with JSON and forwards errors as
 * a 500 with a readable message instead of crashing the request.
 */
function handle(fn) {
    return async (req, res) => {
        try {
            const result = await fn(req);
            res.json(result ?? null);
        } catch (error) {
            console.error(`[storage] ${req.method} ${req.originalUrl} failed:`, error);
            res.status(400).json({ error: error.message });
        }
    };
}
