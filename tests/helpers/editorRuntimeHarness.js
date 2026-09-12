/**
 * Node harness for the ED-02 editor runtime: a real Environment (document,
 * registry, chunks, SelectionStore, CommandBus, SceneProjector) over a real
 * THREE.Scene with duck-typed `data` services. The placement catalog and
 * building generator are browser-only, so the projector runtime is stubbed
 * with simple meshes that carry the same userData the real ones do.
 */

import * as THREE from "three";
import { Environment } from "../../app/3d/environment/Environment.js";
import { syncRoadsFromDocument } from "../../app/3d/editor/document/adapters/RoadRuntimeAdapter.js";
import { regenerateBuildingRuntime } from "../../app/3d/editor/projection/projectors/buildingsProjector.js";
import { placeFeatureRuntime } from "../../app/3d/editor/projection/projectors/featuresProjector.js";
import { deriveObjectGraph } from "../../app/3d/editor/objects/index.js";
import { readEnvironmentEditorFixture } from "./environmentEditorBaseline.js";

export function createStubTriangle(sourceId, type, index) {
    return { _uuid: `${type}:${sourceId}:${index}`, environmentGeometryType: type, environmentSourceId: sourceId, lidarTriangleIndex: index };
}

/** Stub projector runtime: box meshes with the userData the real objects carry. */
export function createStubProjectorRuntime() {
    const counters = { placeFeature: 0, removeFeature: 0, generateBuildings: 0, removeBuildingMeshes: 0 };
    return {
        counters,
        placeFeature({ data, scene, registry, feature }) {
            counters.placeFeature += 1;
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1, 0.6), new THREE.MeshStandardMaterial());
            mesh.name = `Prop:${feature.id}`;
            mesh.position.set(feature.x, 0, feature.z);
            const object = {
                _uuid: feature.id,
                tags: [feature.type],
                dir: feature.dir ?? 0,
                position: new THREE.Vector3(feature.x, 0, feature.z),
                _mesh: mesh,
                setPosition(x, y = 0, z = 0) {
                    if (x?.isVector3) this.position.copy(x);
                    else this.position.set(x, y, z);
                    this._mesh.position.copy(this.position);
                },
                addToScene(target) {
                    target.add(this._mesh);
                },
            };
            mesh.userData.fusionObject = object;
            object.addToScene(scene);
            const database = data.objects();
            database.addObject(object);
            if (!database.inScene.includes(feature.id)) database.inScene.push(feature.id);
            const entity = registry.registerEntity({
                id: `fusion:${feature.id}`,
                sourceId: feature.id,
                kind: feature.type,
                layer: "props",
                object3D: mesh,
                fusionObject: object,
                tags: [feature.type],
                label: feature.type,
            });
            return { object, entity };
        },
        removeFeature(data, scene, featureId) {
            counters.removeFeature += 1;
            const registry = data.environment().objects();
            const entity = registry.getEntity(`fusion:${featureId}`);
            entity?.object3D?.parent?.remove?.(entity.object3D);
            const database = data.objects();
            database.objects = database.objects.filter((object) => object._uuid !== featureId);
            database.inScene = database.inScene.filter((id) => id !== featureId);
            registry.unregisterEntity(`fusion:${featureId}`);
        },
        generateBuildings(scene, data, { records }) {
            counters.generateBuildings += 1;
            for (const record of records) {
                const xs = record.footprint.map((point) => point.x);
                const zs = record.footprint.map((point) => point.z);
                const width = Math.max(...xs) - Math.min(...xs);
                const depth = Math.max(...zs) - Math.min(...zs);
                const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, record.height, depth), new THREE.MeshStandardMaterial());
                mesh.name = `Building:${record.buildingId}`;
                mesh.position.set((Math.max(...xs) + Math.min(...xs)) / 2, record.height / 2, (Math.max(...zs) + Math.min(...zs)) / 2);
                mesh.userData.buildingId = record.buildingId;
                mesh.updateMatrixWorld(true);
                scene.add(mesh);
                data.objects().addObjects([0, 1].map((index) => createStubTriangle(record.buildingId, "building", index)));
            }
            data.bakeRunConfig().setBuildings(records.map((record) => ({ ...record })));
            return records;
        },
        removeBuildingMeshes(scene, buildingId) {
            counters.removeBuildingMeshes += 1;
            const meshes = [];
            scene.traverse((object) => {
                if (object.isMesh && object.userData?.buildingId === buildingId) meshes.push(object);
            });
            for (const mesh of meshes) mesh.parent?.remove(mesh);
            return meshes.length;
        },
    };
}

export function createDomElementStub() {
    return {
        addEventListener() {},
        removeEventListener() {},
        style: {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
        ownerDocument: { addEventListener() {}, removeEventListener() {} },
        setPointerCapture() {},
        releasePointerCapture() {},
    };
}

function createListenerHub(names) {
    const hub = { listeners: Object.fromEntries(names.map((name) => [name, new Set()])) };
    for (const name of names) {
        hub[`register${name}`] = (callback) => {
            hub.listeners[name].add(callback);
            return () => hub.listeners[name].delete(callback);
        };
    }
    hub.fire = (name, event) => hub.listeners[name].forEach((callback) => callback(event));
    return hub;
}

/**
 * @param {{ fixture?: string, manifestDocument?: object, withOverlay?: boolean, seedRuntime?: boolean }} [options]
 */
export async function createEditorHarness({ fixture = "legacy-v2.yard.json", manifestDocument = null, withOverlay = true, seedRuntime = true } = {}) {
    const manifest = manifestDocument ? { document: manifestDocument } : await readEnvironmentEditorFixture(fixture);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 1000);
    camera.position.set(40, 60, 80);
    camera.lookAt(40, 0, 40);
    const renderer = { domElement: createDomElementStub() };
    const city = {
        roads: [],
        intersections: [],
        roadSetup: false,
        intersectionSetup: false,
        getRoads() { return this.roads; },
        getIntersections() { return this.intersections; },
        addRoad(road) { this.roads.push(road); },
        addRoads(roads) { for (const road of roads) this.roads.push(road); },
        addIntersection(intersection) { this.intersections.push(intersection); },
    };
    const objectDatabase = {
        objects: [],
        inScene: [],
        replaceCalls: [],
        addObject(object) { this.objects.push(object); },
        addObjects(list) { for (const object of list) this.objects.push(object); },
        replaceTriangles(predicate, triangles = []) {
            const removed = this.objects.filter((object) => object.environmentGeometryType && predicate(object));
            this.replaceCalls.push({ removed: removed.map((object) => String(object.environmentSourceId)), added: triangles.length });
            this.objects = this.objects.filter((object) => !(object.environmentGeometryType && predicate(object)));
            this.objects.push(...triangles);
        },
        rebuildTextureData() {},
        triangles() { return this.objects.filter((object) => object.environmentGeometryType); },
    };
    const bakeConfig = { buildings: [], seed: 7, setBuildings(list) { this.buildings = list; } };
    const settings = { locks: [], disableControls(key) { this.locks.push(key); }, enableControls(key) { this.locks = this.locks.filter((entry) => entry !== key); } };
    const mouse = createListenerHub(["Down", "Up", "Move", "Click"]);
    const keys = {
        handlers: new Map(),
        registerKeyDown(key, callback) {
            if (!this.handlers.has(key)) this.handlers.set(key, new Set());
            this.handlers.get(key).add(callback);
            return () => this.handlers.get(key)?.delete(callback);
        },
        press(key) { this.handlers.get(key)?.forEach((callback) => callback({ key })); },
    };
    let renders = 0;
    const data = {
        three: () => ({ scene, camera, renderer }),
        city: () => city,
        objects: () => objectDatabase,
        bakeRunConfig: () => bakeConfig,
        simulation: () => ({ render() { renders += 1; } }),
        settings: () => settings,
        mouse: () => mouse,
        keys: () => keys,
        splats: () => null,
        environment: () => environment,
        editor: () => environment.editor(),
        selection: () => environment.selection(),
        commands: () => environment.commands(),
        renders: () => renders,
    };
    const environment = new Environment(data, {
        environmentId: manifest.document.environmentId ?? "yard",
        document: manifest.document,
        roadStylePreset: "default",
    });
    const document = environment.getDocument();
    if (withOverlay && document.objects.length === 0) document.replaceObjectGraph(deriveObjectGraph(document.snapshot()));
    const runtime = createStubProjectorRuntime();
    environment.setup(scene, { projectorRuntime: runtime });
    const registry = environment.objects();

    if (seedRuntime) {
        syncRoadsFromDocument(data, scene, document);
        for (const building of document.buildings) regenerateBuildingRuntime({ data, scene, registry, record: building, runtime });
        for (const feature of document.features) placeFeatureRuntime({ data, scene, registry, feature, runtime });
        bakeConfig.setBuildings(document.buildings.map((record) => ({ ...record })));
        runtime.counters.generateBuildings = 0;
        runtime.counters.placeFeature = 0;
        objectDatabase.replaceCalls.length = 0;
    }

    return {
        data,
        scene,
        camera,
        renderer,
        city,
        objectDatabase,
        bakeConfig,
        settings,
        mouse,
        keys,
        environment,
        document,
        registry,
        selection: environment.selection(),
        bus: environment.commands(),
        projector: environment.projector(),
        runtime,
        manifest,
    };
}
