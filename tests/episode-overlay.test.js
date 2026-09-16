import assert from "node:assert/strict";
import test from "node:test";

import { FEATURE_GEOMETRY_BY_TYPE } from "../app/3d/editor/objects/types/builtinProp.js";
import { createPhysicsBackendSelection } from "../app/physics/PhysicsBackend.js";
import { PhysicsEngine } from "../app/physics/PhysicsEngine.js";
import { OutputNodeBlock, ProgramInputBlock } from "../app/scripting/units/program/ProgramIO.block.js";
import { ScatterFeaturesBlock } from "../app/scripting/units/world/WorldBlocks.block.js";
import { BindingRuntime } from "../app/scripting/bindings/BindingRuntime.js";
import { registerBuiltInBlocks } from "../app/scripting/registerBuiltInBlocks.js";
import { ScriptManager } from "../app/scripting/ScriptManager.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { UNIT_TYPE } from "../app/scripting/types/PortTypes.js";
import { EpisodeOverlay } from "../app/simulation/episode/EpisodeOverlay.js";
import { createSimulationRuntimeContext } from "../app/simulation/kernel/SimulationRuntimeContext.js";
import { CpuLidarScene } from "../app/simulation/sensors/CpuLidarScene.js";
import {
    hashLidarGeometry,
    LIDAR_GEOMETRY_KIND,
    LIDAR_GEOMETRY_VERSION,
} from "../app/simulation/lidar/LidarGeometry.js";
import {
    createWorldDescription,
    hashWorldDescription,
} from "../app/simulation/world/WorldDescription.js";

function fakeRapier() {
    class BodyDescriptor {
        setTranslation(x, y, z) { this.translation = { x, y, z }; return this; }
    }
    class Body {
        constructor(world) { this.world = world; }
        isValid() { return Boolean(this.world); }
        setNextKinematicTranslation(position) { this.next = { ...position }; }
    }
    class World {
        constructor(gravity) {
            this.gravity = gravity;
            this.freed = false;
            this.bodies = [];
        }
        createRigidBody() {
            const body = new Body(this);
            this.bodies.push(body);
            return body;
        }
        createCollider() { return {}; }
        removeRigidBody(body) {
            this.bodies = this.bodies.filter((entry) => entry !== body);
            if (body) body.world = null;
        }
        step() {}
        free() { this.freed = true; }
    }
    return {
        init: async () => {},
        World,
        RigidBodyDesc: {
            fixed: () => new BodyDescriptor(),
            kinematicPositionBased: () => new BodyDescriptor(),
        },
        ColliderDesc: { cuboid: () => ({}) },
    };
}

function blankWorld() {
    return createWorldDescription({
        environmentId: "overlay-world",
        templateId: "blank",
        roadsAuthored: true,
        buildingsAuthored: true,
        featuresAuthored: true,
        document: {
            roads: { nodes: [], edges: [] },
            buildings: [],
            features: [],
        },
    });
}

function emptyLidarResource() {
    const description = {
        kind: LIDAR_GEOMETRY_KIND,
        version: LIDAR_GEOMETRY_VERSION,
        coordinateFrame: { units: "meters", upAxis: "+Y", forwardAxis: "+X" },
        staticPrimitives: [],
        actors: [],
    };
    return { description, hash: hashLidarGeometry(description) };
}

function connect(manager, from, output, to, input) {
    const result = manager.connectUnitsDetailed(from, output, to, input);
    assert.equal(result.ok, true, result.error);
}

function addProgramInput(manager, label, type, defaultValue) {
    const uuid = `in-${label}`;
    const block = new ProgramInputBlock(uuid);
    const config = {
        label,
        type,
        defaultValue: typeof defaultValue === "string" ? defaultValue : JSON.stringify(defaultValue),
    };
    block.hydrateState(config);
    manager.addUnit(block);
    manager.storeData(uuid, config);
    return uuid;
}

function compileScatterArtifact() {
    registerBuiltInBlocks();
    const manager = new ScriptManager();
    const head = new OutputNodeBlock("head");
    const headConfig = { outputs: [{ id: "output", label: "then", type: UNIT_TYPE }] };
    head.hydrateState(headConfig);
    manager.addUnit(head);
    manager.storeData("head", headConfig);
    manager.setHead("head");
    const route = addProgramInput(manager, "route", "route", {
        waypoints: [
            { x: 5, y: 0, z: 0 },
            { x: 15, y: 0, z: 0 },
        ],
    });
    const count = addProgramInput(manager, "count", "int32", "1");
    const side = addProgramInput(manager, "sideOffset", "float64", "0");
    const center = addProgramInput(manager, "centerProbability", "float64", "1");
    const along = addProgramInput(manager, "alongJitter", "float64", "0");
    const lateral = addProgramInput(manager, "lateralJitter", "float64", "0");
    const asset = addProgramInput(manager, "assetId", "string", "barrel");
    manager.addUnit(new ScatterFeaturesBlock("scatter"));
    connect(manager, route, "input", "scatter", "route");
    connect(manager, count, "input", "scatter", "count");
    connect(manager, side, "input", "scatter", "sideOffset");
    connect(manager, center, "input", "scatter", "centerProbability");
    connect(manager, along, "input", "scatter", "alongJitter");
    connect(manager, lateral, "input", "scatter", "lateralJitter");
    connect(manager, asset, "input", "scatter", "assetId");
    connect(manager, "scatter", "then", "head", "output");
    return manager.compile("scatter-overlay");
}

test("episode overlay upserts by id and clears without changing worldHash", () => {
    const world = blankWorld();
    const before = hashWorldDescription(world);
    const overlay = new EpisodeOverlay();
    const first = overlay.upsert({
        assetId: "barrel",
        pose: { position: { x: 3, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        scriptId: "s",
    });
    assert.equal(first, "episode:s:0");
    overlay.upsert({
        id: first,
        assetId: "barrel",
        pose: { position: { x: 4, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        scriptId: "s",
    });
    assert.equal(overlay.size, 1);
    const obstacle = overlay.toObstacles()[0];
    const geometry = FEATURE_GEOMETRY_BY_TYPE.barrel;
    assert.equal(obstacle.id, "episode:s:0");
    assert.equal(obstacle.sourceType, "barrel");
    assert.equal(obstacle.maxY - obstacle.minY, geometry.size.y);
    assert.ok(Math.abs(overlay.snapshot()[0].pose.position.x - 4) < 1e-9);
    overlay.clear();
    assert.equal(overlay.size, 0);
    assert.equal(hashWorldDescription(world), before);
});

test("unknown overlay asset types fail closed", () => {
    const overlay = new EpisodeOverlay();
    assert.throws(
        () => overlay.upsert({ assetId: "not-a-prop", pose: {}, scriptId: "s" }),
        /Unknown feature type/,
    );
});

test("physics colliders include episode overlay ids after resetRun", async () => {
    const world = blankWorld();
    const overlay = new EpisodeOverlay();
    overlay.upsert({
        assetId: "barrel",
        pose: { position: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        scriptId: "s",
    });
    const physics = new PhysicsEngine({
        vehicles: () => ({ vehicles: [] }),
        objects: () => ({ boxes: () => [] }),
        bindings: () => ({ signalStore: null }),
    }, { loadPhysics: async () => fakeRapier() });
    await physics.configureRun({
        manifest: {},
        worldDescription: world,
        backendSelection: createPhysicsBackendSelection(world),
    });
    physics.setEpisodeObstacles(overlay.toObstacles());
    physics.resetRun();
    assert.ok(physics.staticColliders.some((entry) => String(entry.id).startsWith("episode:")));
    overlay.clear();
    physics.setEpisodeObstacles(overlay.toObstacles());
    physics.resetRun();
    assert.equal(physics.staticColliders.some((entry) => String(entry.id).startsWith("episode:")), false);
    physics.disposeRun();
});

test("CPU LiDAR hits an episode barrel after overlay primitives are applied", () => {
    const overlay = new EpisodeOverlay();
    overlay.upsert({
        assetId: "barrel",
        pose: { position: { x: 5, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        scriptId: "s",
    });
    const scene = new CpuLidarScene(emptyLidarResource());
    const sensor = {
        id: "lidar",
        parentId: "ego",
        pose: { position: { x: 0, y: 0, z: 0.5 }, rotation: {} },
        calibration: {
            range: 20,
            azimuth: { startDeg: 0, endDeg: 1, stepDeg: 1 },
            elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 },
        },
    };
    const ego = { id: "ego", position: { x: 0, y: 0, z: 0 }, rotation: {} };
    assert.equal(scene.capture(sensor, [ego])[0], 0);
    scene.setEpisodePrimitives(overlay.toLidarPrimitives());
    assert.ok(scene.capture(sensor, [ego])[0] > 0);
    overlay.clear();
    scene.setEpisodePrimitives(overlay.toLidarPrimitives());
    assert.equal(scene.capture(sensor, [ego])[0], 0);
    scene.dispose();
});

test("kernel reset runs scatter once per episode without mutating worldHash", async () => {
    const { SimulationKernel } = await import("../app/simulation/kernel/SimulationKernel.js");
    const world = blankWorld();
    const worldHash = hashWorldDescription(world);
    const artifact = compileScatterArtifact();
    const lidarScene = new CpuLidarScene(emptyLidarResource());
    const telemetry = new SignalStore({}, { sourceId: "episode-overlay" });
    const scripts = new BindingRuntime({ autoLoad: false });
    await scripts.ready();
    const physics = new PhysicsEngine({
        vehicles: () => ({ vehicles: [] }),
        objects: () => ({ boxes: () => [] }),
        bindings: () => scripts,
    }, { loadPhysics: async () => fakeRapier() });
    const context = createSimulationRuntimeContext({
        telemetry,
        scripts,
        physics,
        vehicles: {
            vehicles: [],
            async configureFromManifest() {},
            resetRun() {},
        },
        devices: {
            devices: [],
            configureFromManifest() {},
            resetRun({ episodeLidarPrimitives } = {}) {
                lidarScene.setEpisodePrimitives(episodeLidarPrimitives ?? []);
            },
            update() {},
            deliver() {},
        },
    });
    await scripts.setManifest({
        enabled: true,
        bindings: [{
            id: "scatter-reset",
            scriptId: "scatter",
            trigger: { kind: "episode-reset" },
        }],
    }, { persist: false });
    await scripts.prepareResolvedScripts([{ scriptId: "scatter", artifact }], {
        seed: "42",
        world,
        overlay: context.episodeOverlay,
    });
    await physics.configureRun({
        manifest: {},
        worldDescription: world,
        backendSelection: createPhysicsBackendSelection(world),
    });
    const kernel = new SimulationKernel(context);
    kernel.simulationSemanticHash = "a".repeat(64);
    kernel.resolvedRun = {
        manifest: {
            id: "overlay-scatter",
            seed: "42",
            clock: { maxSteps: 0, publishClock: false, stepNs: 20_000_000 },
            sensorRig: { sensors: [] },
            initialState: { vehicles: [], signals: {} },
            topics: [],
        },
        world: { description: world, hash: worldHash },
        simulationSemanticHash: kernel.simulationSemanticHash,
        backendSelections: [],
    };

    kernel.reset({ resetSeed: "42" });
    assert.equal(context.episodeOverlay.size, 1);
    assert.ok(physics.staticColliders.some((entry) => String(entry.id).startsWith("episode:")));
    const sensor = {
        id: "lidar",
        parentId: "ego",
        pose: { position: { x: 0, y: 0, z: 0.5 }, rotation: {} },
        calibration: {
            range: 20,
            azimuth: { startDeg: 0, endDeg: 1, stepDeg: 1 },
            elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 },
        },
    };
    const hit = lidarScene.capture(sensor, [{ id: "ego", position: { x: 0, y: 0, z: 0 }, rotation: {} }]);
    assert.ok(hit[0] > 0);
    assert.equal(hashWorldDescription(world), worldHash);

    kernel.reset({ resetSeed: "42" });
    assert.equal(context.episodeOverlay.size, 1);
    assert.equal(hashWorldDescription(world), worldHash);

    kernel.dispose();
    lidarScene.dispose();
});
