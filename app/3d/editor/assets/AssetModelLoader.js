import { sha256ExactBytes, sha256FromUri } from "../../../simulation/visual/VisualLayer.js";
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
        sanitize(root);
        let released = false;
        return {
            root,
            localBounds: value.localBounds.clone?.() ?? structuredClone(value.localBounds),
            release: () => {
                if (released) return;
                released = true;
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
        sanitize(root);
        const THREE = await this._three();
        const localBounds = new THREE.Box3().setFromObject(root);
        return { root, localBounds };
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
