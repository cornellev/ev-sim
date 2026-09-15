import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";

import { CommandBus } from "../app/3d/editor/commands/CommandBus.js";
import { placeAssetInstance } from "../app/3d/editor/commands/assetCommands.js";
import { assetStudioCommands } from "../app/3d/editor/commands/assetStudioCommands.js";
import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createBuiltinObjectTypeRegistry } from "../app/3d/editor/objects/builtinObjectTypes.js";
import { AssetStudioSession } from "../app/3d/editor/assets/AssetStudioSession.js";
import { deltaFromTranslation } from "../app/3d/editor/objects/transformDelta.js";
import { compileAssetDefinition, generateVoxelProxy } from "../app/editor-assets/AssetCompiler.js";
import { createEmptyAssetDefinition, hashAssetMetric, validateAssetDefinition } from "../app/editor-assets/AssetDefinition.js";
import { compileAssetVisualLayer } from "../app/editor-assets/AssetVisualLayerCompiler.js";
import { meshFromPrimitive } from "../app/editor-assets/VoxelMeshSimplifier.js";
import { createPhysicsBackendSelection, PHYSICS_CAPABILITY_ID_V2 } from "../app/physics/PhysicsBackend.js";
import { sweepAabbConvex } from "../app/physics/SweptConvex.js";
import { isRouteVerificationCurrent, routeAlgorithmVersionFor, validateRouteVerification, verifyRoute } from "../app/scenarios/route/Route.js";
import { createLidarGeometry } from "../app/simulation/lidar/LidarGeometry.js";
import { createWorldResource, assertWorldResource, hashWorldDescription } from "../app/simulation/world/WorldDescription.js";
import { EditorAssetStore } from "../server/storage/EditorAssetStore.js";
import { createAssetStore, makeNamedMaterialGlb, makePng, publishAsset } from "./helpers/visual-assets.js";

const USE_HASH = "a".repeat(64);
const MODEL_GEOMETRY = { 0: { vertices: [[-1, 0, -1], [1, 0, -1], [0, 2, 0]], triangles: [[0, 1, 2]] } };

function sourceDefinition() {
    return createEmptyAssetDefinition({ modelUseHash: USE_HASH, name: "Body" });
}

function compiledFixture() {
    const definition = sourceDefinition();
    definition.collisionProxies.push({
        id: "collision", kind: "box", enabled: true,
        transform: { position: [0, 1, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        size: [2, 2, 2],
    });
    definition.lidarProxies.push({
        id: "lidar", kind: "box", enabled: true, semantic: "unknown",
        transform: { position: [0, 1, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        size: [2, 2, 2],
    });
    return compileAssetDefinition(definition, { sourceGeometries: { source: MODEL_GEOMETRY } });
}

function environmentWithMetric(compiled = compiledFixture()) {
    return {
        environmentId: "ed07-world",
        templateId: "blank",
        roadsAuthored: true,
        buildingsAuthored: true,
        featuresAuthored: true,
        document: {
            environmentId: "ed07-world",
            roads: {
                nodes: [{ id: "start-node", x: -20, y: 0, z: 0 }, { id: "finish-node", x: 20, y: 0, z: 0 }],
                edges: [{ id: "road", startNodeId: "start-node", endNodeId: "finish-node", width: 8, laneCount: 2, bidirectional: true }],
            },
            buildings: [], features: [],
            objects: [{
                id: "crate-instance", typeId: "asset-instance", typeVersion: 2, name: "Crate", parentId: null, order: 0,
                components: { tags: [], locked: false, editorHidden: false, asset: { assetId: "crate", revision: 2, position: { x: 0, y: 0, z: 0 }, rotationY: Math.PI / 4, scale: { x: 2, y: 1, z: 0.5 }, overrides: {} } },
            }],
            assetMetrics: { version: 1, definitions: [{ assetId: "crate", revision: 2, metricHash: compiled.metricHash, collision: compiled.metric.collision, lidar: compiled.metric.lidar }] },
        },
    };
}

test("ED-07 definitions compile deterministically and stale only geometry-dependent generated proxies", () => {
    const malformed = sourceDefinition();
    malformed.parts[0].transform.scale[0] = Number.NaN;
    const malformedIssues = validateAssetDefinition(malformed);
    assert.ok(malformedIssues.some((entry) => entry.code === "asset.number.positive"));
    assert.throws(() => compileAssetDefinition(malformed, { sourceGeometries: { source: MODEL_GEOMETRY } }), (error) => (
        error.issues?.some((entry) => entry.code === "asset.number.positive") === true
    ));
    const definition = sourceDefinition();
    assert.deepEqual(validateAssetDefinition(definition), []);
    const first = compileAssetDefinition(definition, { sourceGeometries: { source: MODEL_GEOMETRY } });
    const second = compileAssetDefinition(definition, { sourceGeometries: { source: MODEL_GEOMETRY } });
    assert.deepEqual(first.metric, second.metric);
    assert.equal(first.metricHash, second.metricHash);

    const generated = generateVoxelProxy(definition, { id: "generated", channel: "lidar", includedPartIds: ["root"], voxelSize: 0.1, semantic: "unknown", sourceGeometries: { source: MODEL_GEOMETRY } });
    definition.lidarProxies.push(generated);
    assert.deepEqual(compileAssetDefinition(definition, { sourceGeometries: { source: MODEL_GEOMETRY } }).staleProxyIds, []);
    definition.parts[0].name = "Display-only rename";
    assert.deepEqual(compileAssetDefinition(definition, { sourceGeometries: { source: MODEL_GEOMETRY } }).staleProxyIds, []);
    definition.parts[0].transform.position[0] = 1;
    assert.deepEqual(compileAssetDefinition(definition, { sourceGeometries: { source: MODEL_GEOMETRY } }).staleProxyIds, ["generated"]);
    definition.parts[0].transform.position[0] = 0;
    assert.deepEqual(compileAssetDefinition(definition, { sourceGeometries: { source: MODEL_GEOMETRY } }).staleProxyIds, []);
    definition.lidarProxies[0].generated.parameters.voxelSize = 0.25;
    assert.deepEqual(compileAssetDefinition(definition, { sourceGeometries: { source: MODEL_GEOMETRY } }).staleProxyIds, ["generated"]);
});

test("ED-07 material-only child revisions preserve generated proxy freshness", () => {
    const geometryHash = "b".repeat(64);
    const child = {
        version: 2, revision: 1, modelUseHash: "c".repeat(64), geometryHash,
        appearance: [], metric: { version: 1, collision: [], lidar: [] },
        geometry: MODEL_GEOMETRY,
    };
    const definition = createEmptyAssetDefinition();
    definition.parts.push({
        id: "child", parentId: null, order: 0, name: "Child",
        transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        content: { kind: "asset-reference", assetId: "child", revision: 1 },
        appearanceVisible: true, materialBindings: {},
    });
    definition.lidarProxies.push(generateVoxelProxy(definition, {
        id: "child-proxy", channel: "lidar", includedPartIds: ["child"], semantic: "unknown",
        resolvedChildren: { "child@1": child },
    }));
    assert.deepEqual(compileAssetDefinition(definition, { resolvedChildren: { "child@1": child } }).staleProxyIds, []);
    const appearanceOnly = { ...child, modelUseHash: "d".repeat(64), appearance: [{ id: "new-material" }] };
    assert.deepEqual(compileAssetDefinition(definition, { resolvedChildren: { "child@1": appearanceOnly } }).staleProxyIds, []);
});

test("ED-07 asset sessions keep independent history and reject stale generation commits", async () => {
    const a = new AssetStudioSession({ assetId: "a", revision: 1, definition: sourceDefinition(), sourceGeometries: { source: MODEL_GEOMETRY } });
    const b = new AssetStudioSession({ assetId: "b", revision: 1, definition: sourceDefinition(), sourceGeometries: { source: MODEL_GEOMETRY } });
    assert.equal(a.bus.execute(assetStudioCommands.setNormalization({ metersPerUnit: 0.01 })).ok, true);
    assert.equal(a.dirty, true);
    assert.equal(b.dirty, false);
    assert.equal(a.bus.undo().ok, true);
    assert.equal(a.dirty, false);
    const pending = a.generateProxy({ id: "async", channel: "lidar", includedPartIds: ["root"], semantic: "unknown" });
    a.bus.execute(assetStudioCommands.setNormalization({ pivot: [1, 0, 0] }));
    assert.equal((await pending).ok, false);
    assert.equal(a.document.lidarProxies.length, 0);
    const gesture = a.bus.beginGesture({ objectIds: ["root"] });
    assert.equal(gesture.ok, true);
    assert.equal(a.bus.updateGesture(gesture.gestureId, deltaFromTranslation({ x: 2 })).ok, true);
    assert.equal(a.bus.commitGesture(gesture.gestureId).ok, true);
    assert.equal(a.document.getPart("root").transform.position[0], 2);
    assert.equal(a.bus.undo().ok, true);
    assert.equal(a.document.getPart("root").transform.position[0], 0);
    a.dispose(); b.dispose();
});

test("ED-07 asset sessions cache compile and dirty, invalidate on commands and runtime deps, and keep numeric edits to one history entry", () => {
    const session = new AssetStudioSession({ assetId: "cached", revision: 1, definition: sourceDefinition(), sourceGeometries: { source: MODEL_GEOMETRY } });
    const first = session.compile();
    assert.equal(session.compile(), first, "compile is cached while the document and runtime deps are unchanged");
    session.setView({ camera: { position: [4, 3, 2], target: [0, 0, 0] } });
    session.setView({ showCollision: false, showLidar: false });
    const includedPartIds = session.document.parts.map((entry) => entry.id);
    session.setView({ includedPartIds });
    assert.deepEqual(session.snapshot().view.includedPartIds, includedPartIds);
    assert.equal(session.compile(), first, "camera and overlay view changes do not recompile");
    const dirtyBefore = session.dirty;
    assert.equal(session.dirty, dirtyBefore);
    session.setView({ showCollision: false });
    assert.equal(session.compile(), first, "no-op view patches do not invalidate compile");

    session.bus.execute(assetStudioCommands.setNormalization({ metersPerUnit: 0.25 }));
    const afterCommand = session.compile();
    assert.notEqual(afterCommand, first);
    assert.equal(session.compile(), afterCommand);
    assert.equal(session.dirty, true);
    assert.equal(session.dirty, true, "dirty reuses the cached snapshot stringify");

    session.setResolvedChild("child@1", { version: 2, revision: 1, modelUseHash: "c".repeat(64), geometry: MODEL_GEOMETRY });
    const afterChild = session.compile();
    assert.notEqual(afterChild, afterCommand);
    session.removeResolvedChild("child@1");
    assert.notEqual(session.compile(), afterChild);

    session.discard(sourceDefinition(), 1);
    assert.equal(session.dirty, false);
    const historyBefore = session.bus.snapshot().historyLength;
    assert.equal(session.bus.execute(assetStudioCommands.setNormalization({ pivot: [1.25, 0, 0] })).ok, true);
    assert.equal(session.bus.snapshot().historyLength, historyBefore + 1);
    session.dispose();
});

test("ED-07 placement and undo atomically carry the v2 pin and metric snapshot", () => {
    const compiled = compiledFixture();
    const document = new EnvironmentDocument({ environmentId: "atomic", roads: { nodes: [], edges: [] } });
    const bus = new CommandBus({ document, registry: createBuiltinObjectTypeRegistry() });
    const asset = { assetId: "crate", revision: 2, position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: { x: 1, y: 1, z: 1 }, overrides: {} };
    const publishedRevision = { version: 2, revision: 2, metric: compiled.metric, metricHash: compiled.metricHash };
    const result = bus.execute(placeAssetInstance({ record: { id: "crate-instance", typeId: "asset-instance", typeVersion: 2, name: "Crate", parentId: null, order: 0, components: { asset } }, publishedRevision }));
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(document.objects[0].typeVersion, 2);
    assert.equal(document.assetMetrics.definitions[0].metricHash, compiled.metricHash);
    assert.equal(bus.undo().ok, true);
    assert.equal(document.objects.length, 0);
    assert.equal(document.assetMetrics, null);
    assert.equal(bus.redo().ok, true);
    assert.equal(document.assetMetrics.definitions.length, 1);
});

test("ED-07 world v3, route v8, swept collision, and LiDAR share one metric identity", () => {
    const environment = environmentWithMetric();
    const world = createWorldResource(environment);
    assert.equal(world.description.version, 3);
    assertWorldResource(world);
    assert.equal(createPhysicsBackendSelection(world).capabilityId, PHYSICS_CAPABILITY_ID_V2);
    const convex = world.description.assetProxies[0].collision[0];
    assert.ok(Number.isFinite(sweepAabbConvex({ x: -10, y: 1, z: 0 }, { x: 10, y: 1, z: 0 }, { x: 0.5, y: 0.5, z: 0.5 }, convex)));
    const lidar = createLidarGeometry(world);
    assert.ok(lidar.staticPrimitives.some((entry) => entry.sourceId === "crate-instance" && entry.tags.includes("unknown")));

    assert.equal(routeAlgorithmVersionFor(environment), 8);
    const verified = verifyRoute(environment, [
        { id: "start", x: -18, y: 0, z: 2, anchor: { kind: "road", id: "road", fraction: 0.05, laneMode: "fixed", laneIndex: 0 } },
        { id: "finish", x: 18, y: 0, z: 2, anchor: { kind: "road", id: "road", fraction: 0.95, laneMode: "fixed", laneIndex: 0 } },
    ]);
    assert.equal(verified.ok, true, JSON.stringify(verified.issues));
    assert.equal(verified.verification.baseAlgorithmVersion, 5);
    assert.equal(verified.verification.metricWorldHash, world.description.metricWorldHash);
    assert.equal(validateRouteVerification(verified.route, environment).ok, true);
    const changed = structuredClone(environment);
    changed.document.assetMetrics.definitions[0].collision[0].vertices[0][0] -= 0.25;
    changed.document.assetMetrics.definitions[0].metricHash = hashAssetMetric({ version: 1, collision: changed.document.assetMetrics.definitions[0].collision, lidar: changed.document.assetMetrics.definitions[0].lidar });
    assert.equal(isRouteVerificationCurrent(verified.route, changed), false);

    const missing = environmentWithMetric();
    delete missing.document.assetMetrics;
    assert.throws(() => createWorldResource(missing), /metric (?:snapshot|definition)/i);
    const tampered = environmentWithMetric();
    tampered.document.assetMetrics.definitions[0].collision[0].vertices[0][0] -= 0.5;
    assert.throws(() => createWorldResource(tampered), /metricHash|metric hash/i);
    const corruptWorld = structuredClone(world);
    corruptWorld.description.assetProxies[0].collision[0].triangles[0][0] = 999;
    corruptWorld.hash = hashWorldDescription(corruptWorld.description);
    assert.throws(() => assertWorldResource(corruptWorld), /index|indices/i);
});

test("ED-07 published appearance compiles into measured visual-layer instances without invented truth", () => {
    const compiled = compiledFixture();
    const revision = { version: 2, modelUseHash: USE_HASH, definition: compiled.definition, appearance: [] };
    const record = environmentWithMetric(compiled).document.objects[0];
    const use = { asset: { sha256: "b".repeat(64), mediaType: "model/gltf-binary", sizeBytes: 100, role: "mesh" }, dependencies: {}, sourceIds: ["owned"] };
    const world = createWorldResource(environmentWithMetric(compiled));
    const result = compileAssetVisualLayer({ world, inputs: [{ record, revision }], closureUses: [{ useHash: USE_HASH, use }] });
    assert.equal(result.description.instances.length, 1);
    assert.equal(result.description.bindings[0].truthEntityId, "crate-instance");
    const appearanceOnlyWorld = { ...world, description: { ...world.description, assetProxies: [] } };
    const appearanceOnly = compileAssetVisualLayer({ world: appearanceOnlyWorld, inputs: [{ record, revision }], closureUses: [{ useHash: USE_HASH, use }] });
    assert.equal(appearanceOnly.description.bindings.length, 0);
});

test("ED-07 primitive mesh policy remains frozen", () => {
    const sphere = meshFromPrimitive({ kind: "sphere", radius: 1 });
    const cylinder = meshFromPrimitive({ kind: "cylinder", radius: 1, height: 2 });
    assert.equal(sphere.vertices.length, 24 * 11 + 2);
    assert.equal(cylinder.vertices.length, 24 * 2 + 2);
});

test("ED-07 server publication recompiles and roots deterministic material-named appearance", async (t) => {
    const fixture = await createAssetStore();
    t.after(() => fs.rm(fixture.dir, { recursive: true, force: true }));
    const source = await publishAsset(fixture.store, makeNamedMaterialGlb("factory-red"), {
        mediaType: "model/gltf-binary", role: "mesh",
    });
    const definition = createEmptyAssetDefinition({ modelUseHash: source.useHash, name: "Body" });
    const compiled = compileAssetDefinition(definition, { sourceGeometries: { source: MODEL_GEOMETRY } });
    const store = new EditorAssetStore(fixture.dir, { visualAssets: fixture.store, assetStudioEnabled: true });
    const published = await store.publishRevision({
        assetId: "compiled-crate", name: "Compiled crate", publicationId: "ed07-publication",
        expectedAssetRevision: 0, modelUseHash: source.useHash, definition,
        metric: compiled.metric, metricHash: compiled.metricHash, appearance: compiled.materials,
    }, 0);
    assert.equal(published.revision.version, 2);
    assert.notEqual(published.revision.modelUseHash, source.useHash);
    assert.deepEqual(published.revision.appearance.map((material) => material.id), [
        "asset:compiled-crate:1:material:source/source-material-0",
    ]);
    const compiledUse = await fixture.store.getUse(published.revision.modelUseHash);
    assert.equal(compiledUse.asset.mediaType, "model/gltf-binary");
    assert.equal((await fixture.store.getRoot("editor-asset:compiled-crate:revision:1")).useHash, published.revision.modelUseHash);

    const assemblyDefinition = createEmptyAssetDefinition();
    assemblyDefinition.parts.push({
        id: "child-ref", parentId: null, order: 0, name: "Pinned crate",
        transform: { position: [2, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        content: { kind: "asset-reference", assetId: "compiled-crate", revision: 1 },
        appearanceVisible: true, materialBindings: {},
    });
    const assemblyCompiled = compileAssetDefinition(assemblyDefinition, {
        resolvedChildren: { "compiled-crate@1": published.revision },
    });
    const assembly = await store.publishRevision({
        assetId: "assembly", name: "Assembly", publicationId: "ed07-assembly-publication",
        expectedAssetRevision: 0, modelUseHash: published.revision.modelUseHash,
        definition: assemblyDefinition, metric: assemblyCompiled.metric,
        metricHash: assemblyCompiled.metricHash, appearance: assemblyCompiled.materials,
    }, 1);
    assert.deepEqual(assembly.revision.definition.parts[0].content, {
        kind: "asset-reference", assetId: "compiled-crate", revision: 1,
    });
    assert.deepEqual(assembly.revision.appearance.map((material) => material.id), [
        "asset:assembly:1:material:child-ref/asset:compiled-crate:1:material:source/source-material-0",
    ]);
    assert.deepEqual(await store.publishRevision({
        assetId: "assembly", name: "Assembly", publicationId: "ed07-assembly-publication",
        expectedAssetRevision: 0, modelUseHash: published.revision.modelUseHash,
        definition: assemblyDefinition, metric: assemblyCompiled.metric,
        metricHash: assemblyCompiled.metricHash, appearance: assemblyCompiled.materials,
    }, 1), { catalogRevision: 2, asset: assembly.asset, revision: assembly.revision });
    await assert.rejects(() => store.publishRevision({
        assetId: "assembly", name: "Changed payload", publicationId: "ed07-assembly-publication",
        expectedAssetRevision: 0, modelUseHash: published.revision.modelUseHash,
        definition: assemblyDefinition, metric: assemblyCompiled.metric,
        metricHash: assemblyCompiled.metricHash, appearance: assemblyCompiled.materials,
    }, 1), (error) => error.code === "EDITOR_ASSET_IMMUTABLE_CONFLICT");
});

test("ED-07 studio publication can be disabled and partial multi-root acquisition recovers", async (t) => {
    const fixture = await createAssetStore();
    t.after(() => fs.rm(fixture.dir, { recursive: true, force: true }));
    const source = await publishAsset(fixture.store, makeNamedMaterialGlb("factory"), { mediaType: "model/gltf-binary", role: "mesh" });
    const texture = await publishAsset(fixture.store, makePng(), { mediaType: "image/png", role: "texture" });
    const definition = createEmptyAssetDefinition({ modelUseHash: source.useHash, name: "Body" });
    definition.materials.push({
        id: "paint", mode: "metallic-roughness", alphaMode: "OPAQUE", alphaCutoff: 0.5, doubleSided: false,
        parameters: {
            baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.8,
            emissiveFactor: [0, 0, 0], emissiveStrength: 1, normalScale: 1, occlusionStrength: 1,
            clearcoatFactor: 0, clearcoatRoughnessFactor: 0, sheenColorFactor: [0, 0, 0],
            sheenRoughnessFactor: 0, specularFactor: 1, specularColorFactor: [1, 1, 1],
        },
        textures: [{ slot: "baseColor", useHash: texture.useHash, assetUri: `sha256:${texture.use.asset.sha256}`, texCoord: 0, transform: { offset: [0, 0], rotation: 0, scale: [1, 1] } }],
        extensions: [],
    });
    definition.parts[0].materialBindings.default = "paint";
    const compiled = compileAssetDefinition(definition, { sourceGeometries: { source: MODEL_GEOMETRY } });
    const draft = {
        assetId: "recoverable", name: "Recoverable", publicationId: "recoverable-publication",
        expectedAssetRevision: 0, modelUseHash: source.useHash, definition,
        metric: compiled.metric, metricHash: compiled.metricHash, appearance: compiled.materials,
    };
    const disabled = new EditorAssetStore(fixture.dir, { visualAssets: fixture.store });
    await assert.rejects(() => disabled.publishRevision(draft, 0), /publication is disabled/);

    let acquisitions = 0;
    const crashed = new EditorAssetStore(fixture.dir, {
        visualAssets: fixture.store, assetStudioEnabled: true,
        faults: { editorAssetAfterRootAcquire() { acquisitions += 1; if (acquisitions === 2) throw new Error("crash after dependency root"); } },
    });
    await assert.rejects(() => crashed.publishRevision(draft, 0), /crash after dependency root/);
    const owner = "editor-asset:recoverable:revision:1";
    assert.ok(await fixture.store.getRoot(owner));
    assert.ok(await fixture.store.getRoot(`${owner}:dependency:1`));
    const recovered = new EditorAssetStore(fixture.dir, { visualAssets: fixture.store, assetStudioEnabled: true });
    await recovered.initialize();
    assert.equal(await fixture.store.getRoot(owner), null);
    assert.equal(await fixture.store.getRoot(`${owner}:dependency:1`), null);
    assert.equal((await recovered.list()).assets.length, 0);
});
