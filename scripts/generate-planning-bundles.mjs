import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyRoute } from "../app/scenarios/route/Route.js";
import { canonicalRunBundleStringify } from "../server/headless/RunBundle.js";
import { createPlanningBundle, routeHeadingChange } from "../server/headless/PlanningBundle.js";
import { StorageService } from "../server/storage/StorageService.js";

const outputDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../python/examples/bundles");

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "cev-planning-fixtures-"));
const storage = new StorageService(scratch);
const environment = await storage.getEnvironment("igvc", { full: true });
const edges = environment?.document?.roads?.edges ?? [];
if (edges.length === 0) throw new Error("The built-in IGVC environment has no road edges.");

const ranked = [];
const skipped = [];
for (const edge of edges) {
    try {
        const bundle = await createPlanningBundle({
            roadId: edge.id,
            bundleId: `igvc-${edge.id.replace(/[^A-Za-z0-9._-]/g, "-")}`,
            sensors: "state",
        });
        const polyline = bundle.resolved.scenario.scenario.routes[0].verification.polyline;
        ranked.push({
            id: edge.id,
            change: Math.abs(routeHeadingChange(polyline)),
            bundle,
        });
    } catch (error) {
        skipped.push({ id: edge.id, message: error.message });
    }
}
if (ranked.length === 0) {
    throw new Error(`No IGVC edge produced a clear planning bundle. ${JSON.stringify(skipped)}`);
}
ranked.sort((left, right) => left.change - right.change || left.id.localeCompare(right.id));
const straight = ranked[0];
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, "straight.json"), canonicalRunBundleStringify(straight.bundle));

const nodes = environment.document.roads.nodes;
const turns = [];
for (const start of nodes) {
    for (const finish of nodes) {
        if (start.id === finish.id) continue;
        const verified = verifyRoute(environment, {
            id: "ego-route",
            actorId: "ego",
            waypoints: [
                { id: "start", position: { x: start.x, y: 0, z: start.z } },
                { id: "finish", position: { x: finish.x, y: 0, z: finish.z } },
            ],
        });
        if (!verified.ok) continue;
        const change = Math.abs(routeHeadingChange(verified.verification.polyline));
        if (change > 0.4) turns.push({ start: start.id, finish: finish.id, change });
    }
}
turns.sort((left, right) => right.change - left.change || left.start.localeCompare(right.start));
let curve = null;
for (const turn of turns) {
    try {
        const bundle = await createPlanningBundle({
            startNodeId: turn.start,
            finishNodeId: turn.finish,
            bundleId: "igvc-turn",
            sensors: "state",
        });
        const polyline = bundle.resolved.scenario.scenario.routes[0].verification.polyline;
        const change = Math.abs(routeHeadingChange(polyline));
        if (change <= 0.4) continue;
        curve = { start: turn.start, finish: turn.finish, change, bundle };
        break;
    } catch (error) {
        skipped.push({ id: `${turn.start}->${turn.finish}`, message: error.message });
    }
}
if (curve) {
    await fs.writeFile(path.join(outputDir, "curve.json"), canonicalRunBundleStringify(curve.bundle));
}
await fs.rm(scratch, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
    straight: { road: straight.id, headingChangeRad: straight.change },
    curve: curve ? { start: curve.start, finish: curve.finish, headingChangeRad: curve.change } : null,
    edgeCount: edges.length,
    skipped,
}, null, 2) + "\n");
