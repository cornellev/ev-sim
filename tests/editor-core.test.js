import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
    ChunkIndex,
    getChunkBounds,
    getChunkKeyForPoint,
    getCoveredChunkKeysForBounds,
} from "../app/3d/editor/chunks/ChunkIndex.js";
import { ChunkManager } from "../app/3d/editor/chunks/ChunkManager.js";
import { EDITOR_TOOLS, EditorState } from "../app/3d/editor/EditorState.js";
import { EnvironmentRegistry } from "../app/3d/editor/EnvironmentRegistry.js";
import {
    getPickableObjectRoots,
    isPointerDrag,
    pickEnvironmentEntity,
} from "../app/3d/editor/tools/SelectTool.js";

test("chunk keys and bounds use configurable chunk size", () => {
    assert.equal(getChunkKeyForPoint({ x: 0, z: 0 }, 20), "0,0");
    assert.equal(getChunkKeyForPoint({ x: 19.9, z: -0.1 }, 20), "0,-1");
    assert.deepEqual(getChunkBounds("2,-1", 20), {
        minX: 40,
        minZ: -20,
        maxX: 60,
        maxZ: 0,
    });
});

test("objects can be indexed across multiple chunks", () => {
    const covered = getCoveredChunkKeysForBounds({
        minX: 18,
        minZ: 2,
        maxX: 42,
        maxZ: 22,
    }, 20);

    assert.deepEqual(covered, ["0,0", "0,1", "1,0", "1,1", "2,0", "2,1"]);

    const index = new ChunkIndex({ chunkSize: 20 });
    const membership = index.assignObject("building:wide", {
        minX: 18,
        minZ: 2,
        maxX: 42,
        maxZ: 22,
    });

    assert.equal(membership.primaryChunk, "1,0");
    assert.deepEqual(membership.coveredChunks, covered);
    assert.equal(index.listChunks().length, covered.length);
});

test("editor state publishes tool, selection, layers, and hidden objects", () => {
    const editor = new EditorState();
    const snapshots = [];
    const unsubscribe = editor.subscribe((snapshot) => snapshots.push(snapshot));

    editor.setActiveTool(EDITOR_TOOLS.TRANSLATE);
    editor.selectEntity({ id: "building:a", kind: "building", layer: "buildings" });
    editor.setLayerVisible("props", false);
    editor.setEntityHidden("building:a", true);
    unsubscribe();

    const latest = snapshots.at(-1);
    assert.equal(latest.activeTool, EDITOR_TOOLS.TRANSLATE);
    assert.deepEqual(latest.selection, {
        id: "building:a",
        kind: "building",
        layer: "buildings",
    });
    assert.equal(latest.layers.props, false);
    assert.equal(latest.hiddenEntityIds.has("building:a"), true);
});

test("editor state tracks chunk outline visibility and selection suppression", () => {
    const editor = new EditorState();
    editor.setChunkOutlinesVisible(false);
    assert.equal(editor.snapshot().chunkOutlinesVisible, false);

    assert.equal(editor.isSelectionSuppressed(), false);
    editor.suppressSelection(1000);
    assert.equal(editor.isSelectionSuppressed(), true);
});

test("registry resolves entities from env ids, building ids, and fusion objects", () => {
    const scene = new THREE.Scene();
    const chunkManager = new ChunkManager({ scene, chunkSize: 20 });
    const registry = new EnvironmentRegistry({ chunkManager });

    const building = new THREE.Mesh(
        new THREE.BoxGeometry(4, 8, 4),
        new THREE.MeshBasicMaterial(),
    );
    building.userData.buildingId = "abc";
    scene.add(building);

    const fusionObject = {
        _uuid: "fusion-1",
        tags: ["barrel"],
        constructor: { name: "Barrel" },
    };
    const prop = new THREE.Group();
    const child = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial(),
    );
    prop.userData.fusionObject = fusionObject;
    prop.add(child);
    scene.add(prop);

    registry.registerExistingContent(scene, {
        bakeRunConfig: () => ({
            buildings: [{
                buildingId: "abc",
                footprint: [
                    { x: 0, y: 0, z: 0 },
                    { x: 4, y: 0, z: 0 },
                    { x: 4, y: 0, z: 4 },
                    { x: 0, y: 0, z: 4 },
                ],
                height: 8,
                tags: ["building"],
            }],
        }),
    });

    assert.equal(registry.findEntityFromObject3D(building)?.id, "building:abc");
    assert.equal(registry.findEntityFromObject3D(child)?.id, "fusion:fusion-1");
    assert.equal(registry.getEntity("building:abc").primaryChunk, "0,0");
    assert.equal(registry.getEntity("fusion:fusion-1").layer, "props");
});

test("registry registers road and intersection roots as road-layer entities", () => {
    const scene = new THREE.Scene();
    const chunkManager = new ChunkManager({ scene, chunkSize: 20 });
    const registry = new EnvironmentRegistry({ chunkManager });

    const roadRoot = new THREE.Group();
    roadRoot.name = "Road";
    const roadLine = new THREE.Mesh(
        new THREE.BoxGeometry(10, 0.05, 1),
        new THREE.MeshBasicMaterial(),
    );
    roadRoot.add(roadLine);
    scene.add(roadRoot);

    const intersectionRoot = new THREE.Group();
    intersectionRoot.name = "Intersection";
    const intersectionSurface = new THREE.Mesh(
        new THREE.BoxGeometry(4, 0.05, 4),
        new THREE.MeshBasicMaterial(),
    );
    intersectionRoot.add(intersectionSurface);
    scene.add(intersectionRoot);

    registry.registerExistingContent(scene, {
        bakeRunConfig: () => ({ buildings: [] }),
        city: () => ({
            getRoads: () => [{ root: roadRoot }],
            getIntersections: () => [{ root: intersectionRoot }],
        }),
    });

    assert.equal(registry.getEntity("road:0").layer, "roads");
    assert.equal(registry.getEntity("intersection:0").layer, "roads");
    assert.equal(registry.findEntityFromObject3D(roadLine)?.id, "road:0");
    assert.equal(registry.findEntityFromObject3D(intersectionSurface)?.id, "intersection:0");

    registry.setLayerVisible("roads", false);
    assert.equal(roadRoot.visible, false);
    assert.equal(intersectionRoot.visible, false);
});

test("findEntityFromObject3D skips non-selectable ancestors instead of aborting", () => {
    const scene = new THREE.Scene();
    const registry = new EnvironmentRegistry();

    const chunkGroup = new THREE.Group();
    chunkGroup.userData.skipEnvironmentSelection = true;
    scene.add(chunkGroup);

    const building = new THREE.Mesh(
        new THREE.BoxGeometry(4, 8, 4),
        new THREE.MeshBasicMaterial(),
    );
    building.userData.buildingId = "nested";
    chunkGroup.add(building);

    registry.registerEntity({
        id: "building:nested",
        sourceId: "nested",
        kind: "building",
        layer: "buildings",
        object3D: building,
    });

    assert.equal(registry.findEntityFromObject3D(building)?.id, "building:nested");
});

test("picking ignores scene chrome and respects layer visibility", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 10, 20);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    const renderer = {
        domElement: {
            getBoundingClientRect: () => ({
                left: 0,
                top: 0,
                width: 800,
                height: 600,
                right: 800,
                bottom: 600,
            }),
        },
    };

    const registry = new EnvironmentRegistry();
    const building = new THREE.Mesh(
        new THREE.BoxGeometry(4, 8, 4),
        new THREE.MeshBasicMaterial(),
    );
    building.position.set(0, 4, 0);
    building.userData.buildingId = "target";
    scene.add(building);

    const blocker = new THREE.Mesh(
        new THREE.BoxGeometry(40, 40, 40),
        new THREE.MeshBasicMaterial(),
    );
    blocker.userData.skipEnvironmentSelection = true;
    scene.add(blocker);

    registry.registerEntity({
        id: "building:target",
        sourceId: "target",
        kind: "building",
        layer: "buildings",
        object3D: building,
    });

    const roots = getPickableObjectRoots(registry, { layers: { buildings: true, roads: true, props: true } });
    assert.deepEqual(roots, [building]);

    const picked = pickEnvironmentEntity({
        clientX: 400,
        clientY: 300,
        camera,
        renderer,
        registry,
        layers: { buildings: true, roads: true, props: true },
    });

    assert.equal(picked?.id, "building:target");

    const hiddenLayerPick = pickEnvironmentEntity({
        clientX: 400,
        clientY: 300,
        camera,
        renderer,
        registry,
        layers: { buildings: false, roads: true, props: true },
    });

    assert.equal(hiddenLayerPick, null);
});

test("pointer drag threshold distinguishes clicks from camera drags", () => {
    assert.equal(isPointerDrag({ clientX: 0, clientY: 0 }, { clientX: 2, clientY: 2 }), false);
    assert.equal(isPointerDrag({ clientX: 0, clientY: 0 }, { clientX: 6, clientY: 0 }), true);
});

test("chunk manager removes entity membership from index", () => {
    const scene = new THREE.Scene();
    const chunkManager = new ChunkManager({ scene, chunkSize: 20 });
    const registry = new EnvironmentRegistry({ chunkManager });

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    registry.registerEntity({
        id: "building:test",
        kind: "building",
        object3D: mesh,
        bounds: { minX: 0, minZ: 0, maxX: 10, maxZ: 10 },
    });

    assert.ok(chunkManager.getMembership("building:test"));

    registry.unregisterEntity("building:test");
    assert.equal(chunkManager.getMembership("building:test"), null);
});
