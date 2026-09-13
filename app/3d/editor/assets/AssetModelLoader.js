import { sha256ExactBytes, sha256FromUri } from "../../../simulation/visual/VisualLayer.js";
import { normalizeAssetDefinition } from "../../../editor-assets/AssetDefinition.js";
import { VisualAssetClient } from "../../environment/visual/VisualAssetClient.js";
import { createDigestUrlModifier } from "../../environment/visual/VisualGltfUriGuard.js";

const GLTF_MEDIA = new Set(["model/gltf+json", "model/gltf-binary"]);

function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Asset model load cancelled.", "AbortError");
}

function toArrayBuffer(bytes) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function sanitize(root) {
    root.traverse?.((object) => {
        object.userData = { cevSimVisualPreviewOnly: true };
    });
}

function disposeRoot(root) {
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    root?.traverse?.((object) => {
        if (object.geometry) geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            if (!material) continue;
            materials.add(material);
            for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
        }
    });
    textures.forEach((texture) => texture.dispose?.());
    materials.forEach((material) => material.dispose?.());
    geometries.forEach((geometry) => geometry.dispose?.());
}

function cloneOwnedMaterials(root) {
    const materials = new Set();
    const textures = new Set();
    root.traverse?.((object) => {
        if (!object.material) return;
        const originals = Array.isArray(object.material) ? object.material : [object.material];
        const replacements = originals.map((source) => {
            const material = source?.clone?.() ?? source;
            if (!material || material === source) return material;
            materials.add(material);
            for (const [key, value] of Object.entries(material)) {
                if (!value?.isTexture) continue;
                const texture = value.clone();
                material[key] = texture;
                textures.add(texture);
            }
            return material;
        });
        object.material = Array.isArray(object.material) ? replacements : replacements[0];
    });
    return () => {
        textures.forEach((texture) => texture.dispose?.());
        materials.forEach((material) => material.dispose?.());
    };
}

function cloneTrustedMappings(sourceRoot, cloneRoot, associations) {
    const source = [];
    const clones = [];
    sourceRoot.traverse?.((object) => source.push(object));
    cloneRoot.traverse?.((object) => clones.push(object));
    const result = new Map();
    source.forEach((object, index) => {
        const mapping = associations.get(object);
        if (mapping && clones[index]) result.set(clones[index], structuredClone(mapping));
    });
    return result;
}

/** Numeric compiler input keyed by trusted GLTF node index. */
export function extractAssetSourceGeometries(lease) {
    const result = new Map();
    lease?.root?.traverse?.((object) => {
        if (!object?.isMesh || !object.geometry?.attributes?.position) return;
        let cursor = object;
        let mapping = null;
        let mappingObject = null;
        while (cursor && !mapping) {
            const candidate = lease.nodeMappings?.get(cursor);
            if (Number.isInteger(candidate?.nodes)) { mapping = candidate; mappingObject = cursor; }
            cursor = cursor.parent;
        }
        if (!mapping) return;
        const geometry = object.geometry;
        const positions = geometry.attributes.position;
        const entry = result.get(mapping.nodes) ?? {
            vertices: [], triangles: [],
            matrix: mappingObject?.matrix?.toArray?.() ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        };
        const offset = entry.vertices.length;
        for (let index = 0; index < positions.count; index += 1) {
            entry.vertices.push([positions.getX(index), positions.getY(index), positions.getZ(index)]);
        }
        const indices = geometry.index
            ? Array.from({ length: geometry.index.count }, (_, index) => geometry.index.getX(index))
            : Array.from({ length: positions.count }, (_, index) => index);
        for (let index = 0; index + 2 < indices.length; index += 3) {
            entry.triangles.push([indices[index] + offset, indices[index + 1] + offset, indices[index + 2] + offset]);
        }
        result.set(mapping.nodes, entry);
    });
    return result;
}

/** Build the first editable definition from trusted GLTF node associations. */
export function createImportedAssetDefinition({ lease, modelUseHash, name = "Model", sourceId = "source" } = {}) {
    const geometries = extractAssetSourceGeometries(lease);
    const mappedNodes = new Map();
    const ordered = [];
    lease?.root?.traverse?.((object) => {
        const nodeIndex = lease.nodeMappings?.get(object)?.nodes;
        if (!Number.isInteger(nodeIndex) || mappedNodes.has(nodeIndex)) return;
        mappedNodes.set(nodeIndex, object);
        ordered.push({ nodeIndex, object });
    });
    if (ordered.length === 0) {
        return normalizeAssetDefinition({
            kind: "cev-sim.asset-definition", version: 1,
            normalization: { metersPerUnit: 1, orientation: [0, 0, 0, 1], pivot: [0, 0, 0] },
            sources: [{ id: sourceId, modelUseHash }],
            parts: [{
                id: "root", parentId: null, order: 0, name,
                transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
                content: { kind: "model-node", sourceId, nodeIndex: 0 },
                appearanceVisible: true, materialBindings: {},
            }],
            materials: [], lidarProxies: [], collisionProxies: [],
        });
    }
    const objectToNode = new Map([...mappedNodes].map(([nodeIndex, object]) => [object, nodeIndex]));
    const siblingOrders = new Map();
    const parts = ordered.map(({ nodeIndex, object }) => {
        let parent = object.parent;
        while (parent && !objectToNode.has(parent)) parent = parent.parent;
        const parentNode = parent ? objectToNode.get(parent) : null;
        const parentId = Number.isInteger(parentNode) ? `node-${parentNode}` : null;
        const order = siblingOrders.get(parentId) ?? 0;
        siblingOrders.set(parentId, order + 1);
        return {
            id: `node-${nodeIndex}`,
            parentId,
            order,
            name: String(object.name || `${name} node ${nodeIndex}`),
            transform: {
                position: object.position?.toArray?.() ?? [0, 0, 0],
                quaternion: object.quaternion?.toArray?.() ?? [0, 0, 0, 1],
                scale: object.scale?.toArray?.() ?? [1, 1, 1],
            },
            content: geometries.has(nodeIndex)
                ? { kind: "model-node", sourceId, nodeIndex }
                : { kind: "group" },
            appearanceVisible: true,
            materialBindings: {},
        };
    });
    return normalizeAssetDefinition({
        kind: "cev-sim.asset-definition", version: 1,
        normalization: { metersPerUnit: 1, orientation: [0, 0, 0, 1], pivot: [0, 0, 0] },
        sources: [{ id: sourceId, modelUseHash }], parts,
        materials: [], lidarProxies: [], collisionProxies: [],
    });
}

export class AssetModelLoader {
    constructor({
        assetClient = new VisualAssetClient(),
        THREE = null,
        GLTFLoader = null,
        KTX2Loader = null,
        renderer = null,
        parseGltf = null,
    } = {}) {
        this.assetClient = assetClient;
        this.THREE = THREE;
        this.GLTFLoader = GLTFLoader;
        this.KTX2Loader = KTX2Loader;
        this.renderer = renderer;
        this.parseGltf = parseGltf;
        this.entries = new Map();
        this.disposed = false;
    }

    async acquire(modelUseHash, { signal } = {}) {
        if (this.disposed) throw new Error("AssetModelLoader is disposed.");
        throwIfAborted(signal);
        let entry = this.entries.get(modelUseHash);
        if (!entry) {
            entry = { refs: 0, value: null, promise: null };
            entry.promise = this._load(modelUseHash, signal).then((value) => {
                entry.value = value;
                return value;
            }).catch((error) => {
                this.entries.delete(modelUseHash);
                throw error;
            });
            this.entries.set(modelUseHash, entry);
        }
        const value = entry.value ?? await entry.promise;
        throwIfAborted(signal);
        entry.refs += 1;
        const root = value.root.clone(true);
        const disposeOwnedMaterials = cloneOwnedMaterials(root);
        const nodeMappings = cloneTrustedMappings(value.root, root, value.associations);
        sanitize(root);
        let released = false;
        return {
            root,
            localBounds: value.localBounds.clone?.() ?? structuredClone(value.localBounds),
            nodeMappings,
            release: () => {
                if (released) return;
                released = true;
                disposeOwnedMaterials();
                entry.refs -= 1;
                if (entry.refs === 0 && this.entries.get(modelUseHash) === entry) {
                    this.entries.delete(modelUseHash);
                    disposeRoot(value.root);
                }
            },
        };
    }

    async _load(modelUseHash, signal) {
        await this.assetClient.validateClosure({ useHash: modelUseHash, operations: ["display"] }, signal);
        const uses = new Map();
        const contents = new Map();
        const visit = async (useHash) => {
            if (uses.has(useHash)) return;
            throwIfAborted(signal);
            const use = await this.assetClient.getUse(useHash, { signal });
            uses.set(useHash, use);
            for (const child of Object.values(use.dependencies ?? {})) await visit(child);
        };
        await visit(modelUseHash);
        for (const [useHash, use] of uses) {
            const content = await this.assetClient.getUseContent(useHash, { signal });
            const bytes = content.bytes instanceof Uint8Array ? content.bytes : new Uint8Array(content.bytes);
            const mediaType = String(content.mediaType ?? "").split(";")[0];
            if (bytes.byteLength !== use.asset.sizeBytes || mediaType !== use.asset.mediaType || sha256ExactBytes(bytes) !== use.asset.sha256) {
                throw new Error(`Visual asset use ${useHash} failed byte identity verification.`);
            }
            contents.set(useHash, { bytes, mediaType });
        }
        const primaryUse = uses.get(modelUseHash);
        if (!GLTF_MEDIA.has(primaryUse.asset.mediaType)) throw new Error("Editor asset model use must be GLTF.");
        const primary = contents.get(modelUseHash).bytes;
        const dependencies = new Map();
        for (const [uri, useHash] of Object.entries(primaryUse.dependencies ?? {})) {
            const digest = sha256FromUri(uri);
            const childUse = uses.get(useHash);
            if (!digest || childUse.asset.sha256 !== digest) throw new Error(`Model dependency ${uri} does not match its use digest.`);
            dependencies.set(digest, { ...contents.get(useHash), useHash });
        }
        let parsed;
        if (this.parseGltf) parsed = await this.parseGltf(primary, { dependencies, uses, signal });
        else parsed = await this._parse(primary, dependencies, signal);
        const root = parsed.scene ?? parsed.root;
        if (!root?.clone) throw new Error("GLTF decoder returned no scene root.");
        const associationSource = parsed.parser?.associations ?? parsed.associations;
        const associations = associationSource instanceof Map ? new Map(associationSource) : new Map();
        sanitize(root);
        const THREE = await this._three();
        const localBounds = new THREE.Box3().setFromObject(root);
        return { root, localBounds, associations };
    }

    async _parse(bytes, dependencies, signal) {
        const THREE = await this._three();
        if (!this.GLTFLoader) ({ GLTFLoader: this.GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js"));
        const manager = new THREE.LoadingManager();
        const urls = new Map();
        const resources = new Map();
        for (const [digest, resource] of dependencies) {
            const objectUrl = URL.createObjectURL(new Blob([resource.bytes], { type: resource.mediaType }));
            urls.set(digest, objectUrl);
            resources.set(digest, { objectUrl });
        }
        manager.setURLModifier(createDigestUrlModifier(resources, { allowInternalBlobUrls: true }));
        const loader = new this.GLTFLoader(manager);
        if ([...dependencies.values()].some((entry) => entry.mediaType === "image/ktx2")) {
            if (!this.KTX2Loader) ({ KTX2Loader: this.KTX2Loader } = await import("three/examples/jsm/loaders/KTX2Loader.js"));
            const ktx2 = new this.KTX2Loader(manager).setTranscoderPath("/vendor/basis/");
            if (this.renderer) ktx2.detectSupport(this.renderer);
            loader.setKTX2Loader(ktx2);
        }
        try {
            const result = await loader.parseAsync(toArrayBuffer(bytes), "");
            throwIfAborted(signal);
            return result;
        } finally {
            urls.forEach((url) => URL.revokeObjectURL(url));
        }
    }

    async _three() {
        if (!this.THREE) this.THREE = await import("three");
        return this.THREE;
    }

    dispose() {
        this.disposed = true;
        for (const entry of this.entries.values()) if (entry.value) disposeRoot(entry.value.root);
        this.entries.clear();
    }
}
