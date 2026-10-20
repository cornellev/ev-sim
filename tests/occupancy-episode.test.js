import assert from "node:assert/strict";
import test from "node:test";

import { HeadlessEpisode } from "../app/simulation/headless/HeadlessEpisode.js";
import { HeadlessEpisodeError } from "../app/simulation/headless/HeadlessErrors.js";
import {
    PLANNING_OCCUPANCY_CONFIG_HASH,
    PLANNING_ORACLE_SCHEMA_HASH,
    measuredStateProfileRef,
    planningOccupancyProfileRef,
    planningOracleProfileRef,
    sensorOccupancyProfileRef,
} from "../app/simulation/headless/ProfileRegistry.js";
import { unpackTensor } from "../app/simulation/headless/TensorProtocol.js";
import { simulationSha256 } from "../app/simulation/kernel/SimulationHashes.js";
import { normalizeRunManifest, stripRunMetadata, validateRunManifest } from "../app/simulation/RunManifest.js";
import { verifyRoute } from "../app/scenarios/route/Route.js";
import { StorageService } from "../server/storage/StorageService.js";

const CELLS = 1000;
const RESOLUTION = 0.05;

function imuSensor() {
    return {
        id: "imu",
        type: "imu",
        enabled: true,
        parentId: "ego",
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        rateHz: 60,
        phaseNs: 0,
        calibration: {
            gravity: 9.80665,
            noise: {},
            angularVelocityStdDev: { x: 0, y: 0, z: 0 },
            linearAccelerationStdDev: { x: 0, y: 0, z: 0 },
            angularRandomWalk: { x: 0, y: 0, z: 0 },
            accelerationRandomWalk: { x: 0, y: 0, z: 0 },
            turnOnBias: { randomize: false, angular: { x: 0, y: 0, z: 0 }, acceleration: { x: 0, y: 0, z: 0 } },
        },
        latency: { fixedNs: 0, jitterNs: 0 },
        noise: { dropoutProbability: 0 },
        maxQueueFrames: 8,
    };
}

async function episodeBundle(sensors) {
    const resolved = await new StorageService().resolveRunManifest("igvc-default");
    resolved.manifest.sensorRig.sensors = sensors;
    resolved.manifest.clock.modules.physics = true;
    resolved.manifest.clock.modules.sensors = true;
    resolved.manifest.clock.maxSteps = null;
    resolved.manifest.controls.authority = "candidate";
    const initial = resolved.manifest.initialState.vehicles.find((entry) => entry.id === "ego")
        ?? resolved.manifest.initialState.vehicles[0];
    const roads = resolved.environment.manifest.document.roads;
    const edge = roads.edges[0];
    const nodes = new Map(roads.nodes.map((node) => [node.id, node]));
    const start = nodes.get(edge.startNodeId);
    const finish = nodes.get(edge.endNodeId);
    const verified = verifyRoute(resolved.environment.manifest, {
        id: "ego-route",
        actorId: initial.id,
        waypoints: [
            { id: "start", position: { x: start.x, y: 0, z: start.z } },
            { id: "finish", position: { x: finish.x, y: 0, z: finish.z } },
        ],
    });
    assert.equal(verified.ok, true);
    resolved.scenario = {
        scenario: {
            kind: "cev-sim.scenario",
            version: 1,
            id: "occupancy-episode",
            actors: [{ id: initial.id, role: "ego", name: "Ego" }],
            routes: [{
                id: "ego-route",
                actorId: initial.id,
                waypoints: verified.waypoints,
                verification: verified.verification,
            }],
            zones: [],
            triggers: [],
            completion: { conditions: [] },
            expectedOutcomes: [],
        },
    };
    return resolved;
}

function gridCell(observation, name, x, z) {
    const packed = observation.entries.find((entry) => entry.name === name).tensor.payload.packedData;
    const origin = unpackTensor(observation.entries.find((entry) => entry.name === `${name}/origin`).tensor);
    const col = Math.floor((x - origin[0]) / RESOLUTION);
    const row = Math.floor((z - origin[1]) / RESOLUTION);
    assert.ok(col >= 0 && row >= 0 && col < CELLS && row < CELLS);
    return { value: packed[row * CELLS + col], originX: origin[0], originZ: origin[1] };
}

test("manifest observation profiles stay off the default document and round-trip", () => {
    const plain = normalizeRunManifest({ id: "occupancy-manifest" });
    const explicitDefault = normalizeRunManifest({
        id: "occupancy-manifest",
        observationProfile: measuredStateProfileRef(),
    });
    assert.equal(plain.observationProfile, undefined);
    assert.deepEqual(plain, explicitDefault);
    const selected = normalizeRunManifest({
        id: "occupancy-manifest",
        observationProfile: planningOccupancyProfileRef(),
    });
    assert.deepEqual(selected.observationProfile, planningOccupancyProfileRef());
    assert.equal(selected.observationProfile.configHash, PLANNING_OCCUPANCY_CONFIG_HASH);
    const roundTrip = normalizeRunManifest(JSON.parse(JSON.stringify(selected)));
    assert.deepEqual(roundTrip.observationProfile, selected.observationProfile);
    assert.notEqual(
        simulationSha256(stripRunMetadata(plain)),
        simulationSha256(stripRunMetadata(selected)),
    );
    const missingLidar = validateRunManifest(normalizeRunManifest({
        id: "occupancy-manifest",
        observationProfile: sensorOccupancyProfileRef(),
        sensorRig: { sensors: [] },
    }));
    assert.equal(missingLidar.ok, false);
    assert.ok(missingLidar.issues.some((issue) => issue.path.startsWith("sensorRig")));
});

test("planning-occupancy publishes a moving costmap without changing planning-oracle", async () => {
    const resolved = await episodeBundle([imuSensor()]);
    const oracle = new HeadlessEpisode();
    const oracleDescriptor = await oracle.prepare(resolved, { observationProfile: planningOracleProfileRef() });
    const oracleNames = oracleDescriptor.observationSpace.dictionary.entries.map((entry) => entry.key);
    assert.equal(oracleNames.includes("oracle/occupancy"), false);
    assert.equal(PLANNING_ORACLE_SCHEMA_HASH, "634d60934e90cb05852b668865be750c2e50770a5981cb24b829e17071688a12");
    oracle.dispose();

    resolved.manifest.observationProfile = planningOccupancyProfileRef();
    const fromManifest = new HeadlessEpisode();
    const prepared = await fromManifest.prepare(resolved);
    assert.equal(fromManifest.episodeSpec.observationProfile.id, "planning-occupancy");
    assert.equal(prepared.observationSpace.id, "planning-occupancy");
    const overridden = new HeadlessEpisode();
    const override = await overridden.prepare(resolved, { observationProfile: measuredStateProfileRef() });
    assert.equal(override.observationSpace.id, "measured-state");
    overridden.dispose();

    const reset = fromManifest.reset();
    const ego = fromManifest.runtime.vehicles.vehicles[0];
    assert.equal(gridCell(reset.observation, "oracle/occupancy", ego.position.x, ego.position.z).value, 0);
    const yaw = Number(ego.rotation?.y) || 0;
    const barrelX = ego.position.x + Math.cos(yaw) * 4;
    const barrelZ = ego.position.z - Math.sin(yaw) * 4;
    fromManifest.kernel.context.episodeOverlay.upsert({
        id: "barrel",
        assetId: "barrel",
        pose: { position: { x: barrelX, y: 0, z: barrelZ }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
    });
    let moved = fromManifest.step([1, 0]);
    assert.equal(gridCell(moved.observation, "oracle/occupancy", barrelX, barrelZ).value, 1);
    const startPose = { x: ego.position.x, z: ego.position.z };
    const startOrigin = gridCell(reset.observation, "oracle/occupancy", startPose.x, startPose.z);
    let traveled = 0;
    for (let step = 0; step < 120 && traveled < 0.25; step += 1) {
        moved = fromManifest.step([1, 0]);
        const vehicle = fromManifest.runtime.vehicles.vehicles[0];
        traveled = Math.hypot(vehicle.position.x - startPose.x, vehicle.position.z - startPose.z);
    }
    assert.ok(traveled >= 0.05, `vehicle traveled ${traveled} m`);
    const vehicle = fromManifest.runtime.vehicles.vehicles[0];
    const nextOrigin = gridCell(moved.observation, "oracle/occupancy", vehicle.position.x, vehicle.position.z);
    const deltaX = nextOrigin.originX - startOrigin.originX;
    const deltaZ = nextOrigin.originZ - startOrigin.originZ;
    assert.ok(Math.abs(deltaX) > 0 || Math.abs(deltaZ) > 0);
    assert.ok(Math.abs(deltaX / RESOLUTION - Math.round(deltaX / RESOLUTION)) < 1e-6);
    assert.ok(Math.abs(deltaZ / RESOLUTION - Math.round(deltaZ / RESOLUTION)) < 1e-6);
    fromManifest.dispose();
});

test("sensor occupancy stays unknown until the lidar frame is delivered", async () => {
    const base = await new StorageService().resolveRunManifest("igvc-default");
    const lidar = structuredClone(base.manifest.sensorRig.sensors.find((sensor) => sensor.type === "lidar3d"));
    const stepNs = base.manifest.clock.stepNs;
    lidar.rateHz = 60;
    lidar.phaseNs = 0;
    lidar.pose = { position: { x: 0.5, y: 0, z: 0.5 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } };
    delete lidar.calibration.scanLayout;
    lidar.calibration.azimuth = { startDeg: -10, endDeg: 10, stepDeg: 10 };
    lidar.calibration.elevation = { startDeg: -30, endDeg: 1, stepDeg: 30 };
    lidar.calibration.products.pointCloud = true;
    lidar.latency = { fixedNs: stepNs, jitterNs: 0 };
    lidar.noise = { ...lidar.noise, dropoutProbability: 0, pointDropoutProbability: 0, bias: 0, standardDeviation: 0 };
    const resolved = await episodeBundle([imuSensor(), lidar]);
    const resolvedWithoutLidar = await episodeBundle([imuSensor()]);
    const missing = new HeadlessEpisode();
    await assert.rejects(
        () => missing.prepare(resolvedWithoutLidar, { observationProfile: sensorOccupancyProfileRef() }),
        (error) => error instanceof HeadlessEpisodeError && error.code === "BUNDLE_INVALID",
    );
    const episode = new HeadlessEpisode();
    await episode.prepare(resolved, { observationProfile: sensorOccupancyProfileRef() });
    const reset = episode.reset();
    const ego = episode.runtime.vehicles.vehicles[0];
    const yaw = Number(ego.rotation?.y) || 0;
    const forwardX = Math.cos(yaw);
    const forwardZ = -Math.sin(yaw);
    const leftX = -forwardZ;
    const leftZ = forwardX;
    const barrelX = ego.position.x + forwardX * 4;
    const barrelZ = ego.position.z + forwardZ * 4;
    const outsideX = ego.position.x + leftX * 12;
    const outsideZ = ego.position.z + leftZ * 12;
    episode.kernel.context.episodeOverlay.upsert({
        id: "barrel",
        assetId: "barrel",
        pose: { position: { x: barrelX, y: 0, z: barrelZ }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
    });
    episode.runtime.devices.lidar.scene.setEpisodePrimitives(
        episode.kernel.context.episodeOverlay.toLidarPrimitives(),
    );
    assert.equal(gridCell(reset.observation, "oracle/sensor-occupancy", barrelX, barrelZ).value, 0);
    const waiting = episode.step([0, 0]);
    assert.equal(gridCell(waiting.observation, "oracle/sensor-occupancy", barrelX, barrelZ).value, 0);
    const delivered = episode.step([0, 0]);
    let occupied = false;
    let free = false;
    for (let distance = 0.8; distance <= 4.4; distance += RESOLUTION) {
        const value = gridCell(
            delivered.observation,
            "oracle/sensor-occupancy",
            ego.position.x + forwardX * distance,
            ego.position.z + forwardZ * distance,
        ).value;
        if (distance < 3.2 && value === 1) free = true;
        if (distance > 3.4 && value === 2) occupied = true;
    }
    let occupiedCount = 0;
    let freeCount = 0;
    const sensor = delivered.observation.entries.find((entry) => entry.name === "oracle/sensor-occupancy").tensor.payload.packedData;
    for (const value of sensor) {
        if (value === 2) occupiedCount += 1;
        else if (value === 1) freeCount += 1;
    }
    assert.equal(occupied, true, `the barrel face is occupied (${occupiedCount} occupied, ${freeCount} free cells)`);
    assert.equal(free, true, `road in front of the barrel is free (${occupiedCount} occupied, ${freeCount} free cells)`);
    assert.equal(gridCell(delivered.observation, "oracle/sensor-occupancy", outsideX, outsideZ).value, 0);
    episode.dispose();
});
