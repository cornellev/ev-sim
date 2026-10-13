/** Shared vehicle model loader for the editor studio and the browser vehicle. */

import { applyModelPlacement } from "./ModelPlacement.js";
import { assertVehicleMemberBytes } from "../../vehicles/model/validateVehicleModel.js";

const GLB_NAME = /^[a-f0-9]{64}\.glb$/;
const IMAGE_NAME = /^[a-f0-9]{64}\.(png|jpg|ktx2)$/;

function throwIfAborted(signal) {
    if (signal?.aborted) {
        const error = new DOMException("Vehicle model load cancelled.", "AbortError");
        throw error;
    }
}

function toArrayBuffer(bytes) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function emptyLease({ stale = true, aborted = false } = {}) {
    return {
        stale,
        aborted,
        root: null,
        nodeMappings: new Map(),
        gltfJson: null,
        alignment: null,
        dispose() {},
    };
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

/** Map a decoded scene back to trusted glTF node indexes. */
export function nodeMappingsFromAssociations(root, associations) {
    const map = new Map();
    root?.traverse?.((object) => {
        const association = associations?.get?.(object);
        if (Number.isInteger(association?.nodes)) {
            map.set(object, { nodeIndex: association.nodes, name: object.name ?? "" });
        }
    });
    return map;
}

function siblingUrlModifier(resources) {
    const objectUrls = new Set([...resources.values()].map((entry) => entry.objectUrl));
    return (url) => {
        if (typeof url !== "string" || url.length === 0) throw new Error("Rejected empty glTF URI before a request occurred.");
        if (objectUrls.has(url)) return url;
        const clean = url.split(/[?#]/, 1)[0];
        let name = clean.split("/").pop() ?? "";
        try { name = decodeURIComponent(name); } catch { throw new Error(`Rejected glTF URI ${JSON.stringify(url)}`); }
        const match = resources.get(name);
        if (match?.objectUrl) return match.objectUrl;
        throw new Error(`Rejected glTF URI ${JSON.stringify(url)}`);
    };
}

/**
 * Describe how a saved vehicle model should be fetched.
 * Version 3 content-addressed GLBs carry their sibling images. Other assets
 * stay a single URL so existing glTF relative buffers keep loading.
 */
export function publishedVehicleModelSource(manifest, modelUrl) {
    const asset = typeof manifest?.model?.asset === "string" ? manifest.model.asset : "";
    if (!modelUrl) return null;
    const canonical = manifest?.version === 3
        && GLB_NAME.test(asset)
        && !asset.startsWith("/")
        && !/^[a-z][a-z0-9+.-]*:/i.test(asset);
    if (!canonical) return { kind: "url", url: modelUrl };
    const queryAt = modelUrl.indexOf("?");
    const query = queryAt >= 0 ? modelUrl.slice(queryAt) : "";
    const base = modelUrl.slice(0, modelUrl.lastIndexOf("/") + 1);
    return {
        kind: "url",
        asset: { name: asset, url: modelUrl, mediaType: "model/gltf-binary" },
        dependencies: (manifest.model?.dependencies ?? []).map((name) => ({
            name,
            url: `${base}${encodeURIComponent(name)}${query}`,
        })),
    };
}

export class VehicleModelLoader {
    constructor({
        THREE = null,
        GLTFLoader = null,
        KTX2Loader = null,
        renderer = null,
        parseGltf = null,
        readMember = null,
        fetchResource = null,
    } = {}) {
        this.THREE = THREE;
        this.GLTFLoader = GLTFLoader;
        this.KTX2Loader = KTX2Loader;
        this.renderer = renderer;
        this.parseGltf = parseGltf;
        this.readMember = readMember;
        this.fetchResource = fetchResource;
        this.generations = new Map();
        this.leases = new Set();
        this.disposed = false;
    }

    async load(request, { signal } = {}) {
        if (this.disposed) throw new Error("VehicleModelLoader is disposed.");
        const slotId = String(request?.slotId ?? "");
        if (!slotId) throw new TypeError("Vehicle model load requires a slotId.");
        const generation = (this.generations.get(slotId) ?? 0) + 1;
        this.generations.set(slotId, generation);
        try {
            throwIfAborted(signal);
            const lease = await this._load(request, signal);
            if (this.disposed || this.generations.get(slotId) !== generation || signal?.aborted) {
                lease.dispose();
                return emptyLease({ aborted: signal?.aborted === true });
            }
            this.leases.add(lease);
            const release = lease.dispose;
            lease.dispose = () => {
                this.leases.delete(lease);
                release();
            };
            return lease;
        } catch (error) {
            if (signal?.aborted || error?.name === "AbortError") return emptyLease({ aborted: true });
            if (this.generations.get(slotId) !== generation || this.disposed) return emptyLease();
            throw error;
        }
    }

    async _load(request, signal) {
        const source = request?.source;
        if (!source || (source.kind !== "url" && source.kind !== "bytes")) {
            throw new TypeError("Vehicle model source must be url or bytes.");
        }
        if (source.kind === "url" && !source.asset) {
            const parsed = await this._loadLegacyUrl(source.url, signal);
            return this._finish(parsed, request, null);
        }
        const asset = source.asset;
        const dependencies = source.dependencies ?? [];
        if (!GLB_NAME.test(String(asset?.name ?? ""))) {
            throw new Error(`Vehicle model "${asset?.name ?? ""}" is not a content-addressed sibling filename.`);
        }
        for (const dependency of dependencies) {
            if (!IMAGE_NAME.test(String(dependency?.name ?? ""))) {
                throw new Error(`Dependency "${dependency?.name ?? ""}" is not a content-addressed sibling filename.`);
            }
        }
        const assetBytes = await this._memberBytes(asset, signal);
        const loadedDependencies = [];
        for (const dependency of dependencies) {
            loadedDependencies.push({
                ...dependency,
                bytes: await this._memberBytes(dependency, signal),
            });
        }
        const parsed = await this._decode(assetBytes, loadedDependencies, signal);
        return this._finish(parsed, request, assetBytes);
    }

    async _loadLegacyUrl(url, signal) {
        throwIfAborted(signal);
        const GLTFLoader = await this._gltfLoader();
        const loader = new GLTFLoader();
        const parsed = await loader.loadAsync(url);
        throwIfAborted(signal);
        return parsed;
    }

    async _memberBytes(member, signal) {
        throwIfAborted(signal);
        let bytes = member?.bytes ?? null;
        if (bytes == null && this.readMember) bytes = await this.readMember(member, signal);
        if (bytes == null && member?.url) bytes = await this._fetch(member.url, signal);
        if (bytes == null) throw new Error(`Vehicle model member "${member?.name ?? member?.url ?? ""}" has no bytes.`);
        throwIfAborted(signal);
        return assertVehicleMemberBytes(member, bytes);
    }

    async _fetch(url, signal) {
        throwIfAborted(signal);
        if (this.fetchResource) {
            const result = await this.fetchResource(url, signal);
            throwIfAborted(signal);
            return result?.bytes ?? result;
        }
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`Vehicle model request failed for ${url}.`);
        throwIfAborted(signal);
        return new Uint8Array(await response.arrayBuffer());
    }

    async _decode(bytes, dependencies, signal) {
        throwIfAborted(signal);
        const parsed = this.parseGltf
            ? await this.parseGltf(bytes, { dependencies, signal })
            : await this._parse(bytes, dependencies, signal);
        throwIfAborted(signal);
        return parsed;
    }

    async _parse(bytes, dependencies, signal) {
        const THREE = await this._three();
        const GLTFLoader = await this._gltfLoader();
        const manager = new THREE.LoadingManager();
        const resources = new Map();
        const urls = [];
        for (const dependency of dependencies) {
            const objectUrl = URL.createObjectURL(new Blob([dependency.bytes], { type: dependency.mediaType }));
            urls.push(objectUrl);
            resources.set(dependency.name, { objectUrl, mediaType: dependency.mediaType });
        }
        manager.setURLModifier(siblingUrlModifier(resources));
        const loader = new GLTFLoader(manager);
        if (dependencies.some((entry) => entry.mediaType === "image/ktx2")) {
            const KTX2Loader = await this._ktx2Loader();
            const ktx2 = new KTX2Loader(manager).setTranscoderPath("/vendor/basis/");
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

    _finish(parsed, request, glbBytes = null) {
        const root = parsed?.scene ?? parsed?.root;
        if (!root?.traverse) throw new Error("GLTF decoder returned no scene root.");
        const associationSource = parsed.parser?.associations ?? parsed.associations;
        const associations = associationSource instanceof Map ? associationSource : new Map();
        const alignment = applyModelPlacement(root, request.model, request.boundingBox ?? null);
        let released = false;
        const lease = {
            stale: false,
            aborted: false,
            root,
            glbBytes: glbBytes ? new Uint8Array(glbBytes) : null,
            nodeMappings: nodeMappingsFromAssociations(root, associations),
            gltfJson: parsed.parser?.json ?? parsed.json ?? null,
            alignment,
            dispose: () => {
                if (released) return;
                released = true;
                disposeRoot(root);
            },
        };
        return lease;
    }

    async _gltfLoader() {
        if (!this.GLTFLoader) {
            ({ GLTFLoader: this.GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js"));
        }
        return this.GLTFLoader;
    }

    async _ktx2Loader() {
        if (!this.KTX2Loader) {
            ({ KTX2Loader: this.KTX2Loader } = await import("three/examples/jsm/loaders/KTX2Loader.js"));
        }
        return this.KTX2Loader;
    }

    async _three() {
        if (!this.THREE) this.THREE = await import("three");
        return this.THREE;
    }

    dispose() {
        this.disposed = true;
        for (const lease of [...this.leases]) lease.dispose();
        this.leases.clear();
        this.generations.clear();
    }
}
