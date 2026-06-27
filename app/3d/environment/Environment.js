import { ChunkManager } from "../editor/chunks/ChunkManager.js";
import { DEFAULT_CHUNK_SIZE } from "../editor/chunks/ChunkIndex.js";
import { EnvironmentDocument } from "../editor/document/EnvironmentDocument.js";
import { hydrateDocumentFromRuntime } from "../editor/document/documentRuntimeHydration.js";
import { EditorState } from "../editor/EditorState.js";
import { EnvironmentRegistry } from "../editor/EnvironmentRegistry.js";

/**
 * What is an environment?
 * 
 * An environment describes the scene in which the simulation takes place.
 * For example, a city, or a rural area, or a highway.
 * 
 * Generally, it's a collection of objects that can be used to create a realistic simulation.
 * For example, a city environment might include buildings, roads, traffic lights, and pedestrians.
 * A rural environment might include trees, grass, and animals.
 * A highway environment might include cars, trucks, and traffic signs.
 * 
 * This acts as a container for all the objects in the scene, and can be used to manage them.
 */
export class Environment {
    /**
     * 
     * @param {Data} data 
     */
    constructor(data, options = {}) {
        if (!data) throw new Error("Data object is required to create an environment.");

        this.data = data; // general data object
        this.environmentId = options.environmentId ?? "igvc";
        this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
        this.editorState = new EditorState(options.editorState);
        this.document = options.document instanceof EnvironmentDocument
            ? options.document
            : EnvironmentDocument.fromManifest(options.document ?? {});
        this.chunkManager = new ChunkManager({
            scene: data.three?.()?.scene ?? null,
            chunkSize: this.chunkSize,
        });
        this.registry = new EnvironmentRegistry({
            chunkManager: this.chunkManager,
        });

        // A list of all the static objects (as in, that don't move) in the environment.
        // These are particularly objects can still interact with LiDAR and other sensors, but they don't move.
        // Some examples are: Buildings, static cars, stop signs (or general signs), traffic lights, cones, etc.
        this.staticObjects = []; // Type: Array of GLSLObject

        // A list of all the dynamic objects (as in, that do move) in the environment.
        // Some examples are: Pedestrians, cyclists, moving cars, animals, etc.
        this.dynamicObjects = []; // Type: Array of GLSLObject

        // A list of visual objects that aren't necessarily part of the simulation, but are there for visual purposes.
        // For example, a skybox, or a ground plane.
        this.visualObjects = []; // Type: Array of ThreeJS objects

        this.scene = null;
        this.toolController = null;
    }

    setup(scene) {
        this.scene = scene;
        this.chunkManager.setScene(scene);
        this.registry.registerExistingContent(scene, this.data);
        hydrateDocumentFromRuntime(this.data, this.document);
    }

    editor() {
        return this.editorState;
    }

    getDocument() {
        return this.document;
    }

    objects() {
        return this.registry;
    }

    chunks() {
        return this.chunkManager;
    }

    setToolController(controller) {
        this.toolController?.dispose?.();
        this.toolController = controller;
    }

    dispose() {
        this.toolController?.dispose?.();
        this.toolController = null;
    }

    toManifest() {
        const editorSnapshot = this.editorState.snapshot();
        return {
            environmentId: this.environmentId,
            chunkSize: this.chunkSize,
            document: this.document.toManifest(),
            ...this.chunkManager.toManifest(),
            ...this.registry.toManifest(),
            editor: {
                layers: editorSnapshot.layers,
                hiddenEntityIds: [...editorSnapshot.hiddenEntityIds],
                editorMode: editorSnapshot.editorMode,
                map: editorSnapshot.map,
            },
        };
    }
}