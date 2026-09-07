import {
    VISUAL_KTX2_TRANSCODER_PATH,
    VISUAL_PREVIEW_ERROR_CODES,
    VISUAL_PREVIEW_STATUS,
    VisualPreviewError,
    assertPinnedKtx2TranscoderPath,
    assertVisualLayer,
    assertVisualLayerAccess,
    assertVisualLayerAccessMatches,
    assertVisualLayerTruthBindings,
    hashVisualLayer,
    hashVisualLayerAccess,
    isVisualLayerMaterializableReference,
    sha256ExactBytes,
    sha256FromUri,
} from "../../../simulation/visual/VisualLayer.js";
import { VisualAssetClient } from "./VisualAssetClient.js";
import { VisualLayerClient } from "./VisualLayerClient.js";
import { createDigestUrlModifier } from "./VisualGltfUriGuard.js";
import {
    assertGltfMaterialBijection,
    createDescriptorMaterial,
    replaceEmbeddedMaterials,
} from "./VisualMaterialFactory.js";
import { sanitizePreviewObject } from "./VisualPreviewIsolation.js";

const GLTF_MEDIA = new Set(["model/gltf-binary", "model/gltf+json"]);

export class VisualLayerMaterializer {
    constructor({
        previewRoot,
        renderer = null,
        layerClient = new VisualLayerClient(),
        assetClient = new VisualAssetClient(),
        THREE: threeImpl = null,
        GLTFLoader = null,
        KTX2Loader,
        decodeTexture = null,
        parseGltf = null,
    } = {}) {
        this.previewRoot = previewRoot;
        this.renderer = renderer;
        this.layerClient = layerClient;
        this.assetClient = assetClient;
        this.THREE = threeImpl;
        this.GLTFLoader = GLTFLoader;
        this.KTX2Loader = KTX2Loader;
        this.decodeTexture = decodeTexture;
        this.parseGltf = parseGltf;
        this._generation = 0;
        this._controller = null;
        this._disposed = false;
        this._objectUrls = new Set();
        this._stagingUrls = new Set();
        this._ktx2Loader = null;
        this._committed = null;
        this._committedWorldHash = null;
        this._bindings = new Map();
        this._lastRequest = null;
        this._listeners = new Set();
        this.status = idleStatus();
    }

    subscribe(listener) {
        this._listeners.add(listener);
        listener(this.status);
        return () => this._listeners.delete(listener);
    }

    visualBindings() {
        return new Map(this._bindings);
    }

    async replace(reference, worldResource) {
        this._assertNotDisposed();
        const generation = ++this._generation;
        this._abortCurrent();
        const controller = new AbortController();
        this._controller = controller;
        this._lastRequest = { reference: reference ?? null, worldResource: worldResource ?? null };
        const worldHash = worldResource?.hash ?? null;
        if (this._committedWorldHash && worldHash && this._committedWorldHash !== worldHash) {
            this._disposeCommitted();
        }
        this._setStatus(VISUAL_PREVIEW_STATUS.loading);
        let staged = null;
        try {
            if (!reference) {
                this._disposeCommitted();
                this._committedWorldHash = worldHash;
                this._setStatus(VISUAL_PREVIEW_STATUS.idle);
                return this.status;
            }
            if (!isVisualLayerMaterializableReference(reference)) {
                throw new VisualPreviewError(
                    VISUAL_PREVIEW_ERROR_CODES.ACCESS_MISSING,
                    "Visual layer reference is not materializable until an accessHash is attached.",
                );
            }
            const documents = await this._loadDocuments(reference, controller.signal);
            this._throwIfStale(generation, controller.signal);
            const { descriptor, access } = documents;
            this._assertWorldAndBindings(descriptor, worldResource);
            const uses = await this._loadUses(access, controller.signal);
            this._throwIfStale(generation, controller.signal);
            assertVisualLayerAccessMatches(access, descriptor, uses);
            const resources = await this._fetchNeededAssets(descriptor, access, uses, controller.signal);
            this._throwIfStale(generation, controller.signal);
            staged = await this._stageLayer(descriptor, resources, controller.signal);
            this._throwIfStale(generation, controller.signal);
            this._disposeCommitted();
            this._commit(staged, worldHash);
            staged = null;
            this._setStatus(VISUAL_PREVIEW_STATUS.ready);
            return this.status;
        } catch (error) {
            await this._disposeGroup(staged?.group ?? staged);
            this._revokeStagingUrls();
            if (generation !== this._generation) return this.status;
            this._disposeCommitted();
            if (error?.code === VISUAL_PREVIEW_ERROR_CODES.SUPERSEDED) {
                return this.status;
            }
            this._setStatus(VISUAL_PREVIEW_STATUS.error, normalizePreviewError(error));
            return this.status;
        }
    }

    async retry() {
        return this.replace(this._lastRequest?.reference, this._lastRequest?.worldResource);
    }

    clear() {
        this._generation += 1;
        this._abortCurrent();
        this._disposeCommitted();
        this._committedWorldHash = null;
        this._lastRequest = null;
        this._setStatus(VISUAL_PREVIEW_STATUS.idle);
        return this.status;
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._generation += 1;
        this._abortCurrent();
        this._disposeCommitted();
        this._disposeKtx2();
        this._revokeObjectUrls();
        this._listeners.clear();
        this.previewRoot = null;
        this.status = idleStatus();
    }

    _assertNotDisposed() {
        if (this._disposed) {
            throw new VisualPreviewError(VISUAL_PREVIEW_ERROR_CODES.SUPERSEDED, "Visual layer materializer is disposed.");
        }
    }

    _abortCurrent() {
        this._controller?.abort();
        this._controller = null;
    }

    _throwIfStale(generation, signal) {
        if (this._disposed || generation !== this._generation || signal?.aborted) {
            throw new VisualPreviewError(VISUAL_PREVIEW_ERROR_CODES.SUPERSEDED, "Visual preview load was superseded.");
        }
    }

    async _loadDocuments(reference, signal) {
        try {
            const documents = await this.layerClient.getAccess(reference.descriptorHash, reference.accessHash);
            this._throwIfStale(this._generation, signal);
            assertVisualLayer(documents.descriptor);
            assertVisualLayerAccess(documents.access);
            if (hashVisualLayer(documents.descriptor) !== reference.descriptorHash) {
                throw new VisualPreviewError(
                    VISUAL_PREVIEW_ERROR_CODES.HASH_MISMATCH,
                    "Fetched visual-layer descriptor digest does not match the reference.",
                );
            }
            if (hashVisualLayerAccess(documents.access) !== reference.accessHash) {
                throw new VisualPreviewError(
                    VISUAL_PREVIEW_ERROR_CODES.HASH_MISMATCH,
                    "Fetched visual-layer access digest does not match the reference.",
                );
            }
            return documents;
        } catch (error) {
            throw mapClientError(error, VISUAL_PREVIEW_ERROR_CODES.DESCRIPTOR_MISSING);
        }
    }

    _assertWorldAndBindings(descriptor, worldResource) {
        const worldHash = worldResource?.hash;
        if (worldHash && descriptor.sourceWorldHash !== worldHash) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.WORLD_MISMATCH,
                `Visual layer is bound to world ${descriptor.sourceWorldHash}, not ${worldHash}.`,
            );
        }
        try {
            if (worldResource?.description) {
                assertVisualLayerTruthBindings(descriptor, worldResource.description);
            }
        } catch (error) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.BINDING_INVALID,
                error.message,
            );
        }
    }

    async _loadUses(access, signal) {
        const uses = new Map();
        for (const entry of access.assets) {
            try {
                const use = await this.assetClient.getUse(entry.useHash);
                this._throwIfStale(this._generation, signal);
                uses.set(entry.useHash, use);
            } catch (error) {
                throw mapClientError(error, VISUAL_PREVIEW_ERROR_CODES.ASSET_MISSING);
            }
        }
        return uses;
    }

    async _fetchNeededAssets(descriptor, access, uses, signal) {
        const digestToUse = new Map(access.assets.map((entry) => [entry.sha256, entry.useHash]));
        const needed = new Set();
        for (const instance of descriptor.instances) {
            const digest = sha256FromUri(instance.assetUri);
            needed.add(digest);
            this._collectUseClosure(digestToUse.get(digest), uses, needed);
            const materialIds = new Set(instance.materialIds);
            for (const material of descriptor.materials) {
                if (!materialIds.has(material.id)) continue;
                for (const texture of material.textures) {
                    const textureDigest = sha256FromUri(texture.assetUri);
                    needed.add(textureDigest);
                    this._collectUseClosure(digestToUse.get(textureDigest), uses, needed);
                }
            }
        }
        const resources = new Map();
        for (const digest of needed) {
            const useHash = digestToUse.get(digest);
            if (!useHash) {
                throw new VisualPreviewError(
                    VISUAL_PREVIEW_ERROR_CODES.ASSET_MISSING,
                    `Visual asset ${digest} is not present in the access sidecar.`,
                );
            }
            const use = uses.get(useHash);
            resources.set(digest, await this._fetchAsset(useHash, use.asset, signal));
        }
        return resources;
    }

    _collectUseClosure(useHash, uses, needed) {
        const use = uses.get(useHash);
        if (!use) return;
        needed.add(use.asset.sha256);
        for (const [uri] of Object.entries(use.dependencies)) {
            const digest = sha256FromUri(uri);
            if (digest) needed.add(digest);
        }
    }

    async _fetchAsset(useHash, expected, signal) {
        let content;
        try {
            content = await this.assetClient.getUseContent(useHash);
        } catch (error) {
            throw mapClientError(error, VISUAL_PREVIEW_ERROR_CODES.ASSET_MISSING);
        }
        this._throwIfStale(this._generation, signal);
        const bytes = content.bytes instanceof Uint8Array ? content.bytes : new Uint8Array(content.bytes);
        if (bytes.byteLength !== expected.sizeBytes) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.SIZE_MISMATCH,
                `Asset ${expected.sha256} byte length ${bytes.byteLength} does not match ${expected.sizeBytes}.`,
            );
        }
        const mediaType = String(content.mediaType ?? expected.mediaType).split(";")[0].trim();
        if (mediaType !== expected.mediaType) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.MEDIA_MISMATCH,
                `Asset ${expected.sha256} media type ${mediaType} does not match ${expected.mediaType}.`,
            );
        }
        const etag = String(content.etag ?? "").replaceAll("\"", "");
        if (etag && etag !== expected.sha256) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.HASH_MISMATCH,
                `Asset ${expected.sha256} ETag does not match the declared digest.`,
            );
        }
        if (sha256ExactBytes(bytes) !== expected.sha256) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.HASH_MISMATCH,
                `Browser-computed digest does not match asset ${expected.sha256}.`,
            );
        }
        return { bytes, mediaType: expected.mediaType, useHash, role: expected.role };
    }

    async _stageLayer(descriptor, resources, signal) {
        const THREE = await this._three();
        const staged = new THREE.Group();
        staged.name = "cev-sim.visual-layer-staged";
        const layerHash = hashVisualLayer(descriptor);
        sanitizePreviewObject(staged, { layerHash, instanceId: null });
        const urlMap = this.parseGltf ? new Map() : this._objectUrlMap(resources);
        const parsed = new Map();
        const materialsById = new Map(descriptor.materials.map((material) => [material.id, material]));
        const bindingsByInstance = new Map(descriptor.bindings.map((binding) => [binding.instanceId, binding]));
        const stagedBindings = new Map();
        for (const instance of descriptor.instances) {
            this._throwIfStale(this._generation, signal);
            const digest = sha256FromUri(instance.assetUri);
            if (!parsed.has(digest)) {
                parsed.set(digest, await this._parsePrimaryAsset(digest, resources, urlMap, signal));
            }
            const template = parsed.get(digest);
            assertGltfMaterialBijection(template.json, instance.materialIds);
            const textures = await this._texturesForInstance(instance, materialsById, resources, signal);
            const instanceMaterials = new Map();
            for (const materialId of instance.materialIds) {
                instanceMaterials.set(
                    materialId,
                    createDescriptorMaterial(THREE, materialsById.get(materialId), textures),
                );
            }
            const root = template.scene.clone(true);
            if (instance.materialIds.length > 0) {
                replaceEmbeddedMaterials(root, THREE, instanceMaterials);
            }
            root.matrix.fromArray(instance.matrix);
            root.matrixAutoUpdate = false;
            root.updateMatrixWorld(true);
            const binding = bindingsByInstance.get(instance.id) ?? null;
            if (binding) stagedBindings.set(instance.id, { ...binding });
            sanitizePreviewObject(root, {
                layerHash,
                instanceId: instance.id,
                bindingId: binding?.id ?? null,
            });
            staged.add(root);
        }
        return { group: staged, bindings: stagedBindings };
    }

    async _parsePrimaryAsset(digest, resources, urlMap, signal) {
        const resource = resources.get(digest);
        if (!resource) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.ASSET_MISSING,
                `Primary visual asset ${digest} was not fetched.`,
            );
        }
        if (!GLTF_MEDIA.has(resource.mediaType)) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.MEDIA_MISMATCH,
                `Primary asset ${digest} must be glTF.`,
            );
        }
        if (this.parseGltf) {
            const parsed = await this.parseGltf(resource.bytes, digest, resources);
            this._throwIfStale(this._generation, signal);
            return parsed;
        }
        const THREE = await this._three();
        const { GLTFLoader } = await this._loaders();
        const manager = new THREE.LoadingManager();
        manager.setURLModifier(createDigestUrlModifier(urlMap));
        const loader = new GLTFLoader(manager);
        const ktx2 = await this._ensureKtx2(manager, resources);
        if (ktx2) loader.setKTX2Loader(ktx2);
        try {
            const gltf = await loader.parseAsync(toArrayBuffer(resource.bytes), "");
            this._throwIfStale(this._generation, signal);
            return {
                scene: gltf.scene,
                json: gltf.parser?.json ?? {},
            };
        } catch (error) {
            if (error instanceof VisualPreviewError) throw error;
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.DECODER_FAILED,
                error.message || "glTF decode failed.",
            );
        }
    }

    async _texturesForInstance(instance, materialsById, resources, signal) {
        const textures = new Map();
        for (const materialId of instance.materialIds) {
            const material = materialsById.get(materialId);
            for (const texture of material.textures) {
                if (textures.has(texture.slot)) continue;
                const digest = sha256FromUri(texture.assetUri);
                textures.set(texture.slot, await this._decodeTexture(resources.get(digest), texture.slot, signal));
            }
        }
        return textures;
    }

    async _decodeTexture(resource, slot, signal) {
        if (!resource) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.ASSET_MISSING,
                `Texture for slot ${slot} was not fetched.`,
            );
        }
        this._throwIfStale(this._generation, signal);
        try {
            if (this.decodeTexture) return await this.decodeTexture(resource.bytes, resource.mediaType, slot);
            const THREE = await this._three();
            if (resource.mediaType === "image/ktx2") {
                const ktx2 = await this._ensureKtx2(null, new Map([["ktx2", resource]]));
                if (!ktx2) {
                    throw new VisualPreviewError(
                        VISUAL_PREVIEW_ERROR_CODES.UNSUPPORTED_RENDERER,
                        "KTX2 textures require a supported GPU transcoder.",
                    );
                }
                return await ktx2.parse(toArrayBuffer(resource.bytes));
            }
            const blob = new Blob([resource.bytes], { type: resource.mediaType });
            const objectUrl = URL.createObjectURL(blob);
            this._stagingUrls.add(objectUrl);
            const loader = new THREE.TextureLoader();
            return await loader.loadAsync(objectUrl);
        } catch (error) {
            if (error instanceof VisualPreviewError) throw error;
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.DECODER_FAILED,
                error.message || `Failed to decode ${resource.mediaType} texture.`,
            );
        }
    }

    _objectUrlMap(resources) {
        const map = new Map();
        for (const [digest, resource] of resources) {
            const blob = new Blob([resource.bytes], { type: resource.mediaType });
            const objectUrl = URL.createObjectURL(blob);
            this._stagingUrls.add(objectUrl);
            map.set(digest, { objectUrl, ...resource });
        }
        return map;
    }

    async _ensureKtx2(manager, resources) {
        const needsKtx2 = [...(resources?.values?.() ?? [])].some((entry) => entry.mediaType === "image/ktx2");
        if (!needsKtx2 && !this._ktx2Loader) return this._ktx2Loader;
        if (this._ktx2Loader) return this._ktx2Loader;
        const { KTX2Loader } = await this._loaders();
        if (!KTX2Loader) {
            if (needsKtx2) {
                throw new VisualPreviewError(
                    VISUAL_PREVIEW_ERROR_CODES.UNSUPPORTED_RENDERER,
                    "KTX2 loader is unavailable.",
                );
            }
            return null;
        }
        const THREE = await this._three();
        const loader = new KTX2Loader(manager ?? new THREE.LoadingManager());
        loader.setTranscoderPath(assertPinnedKtx2TranscoderPath(VISUAL_KTX2_TRANSCODER_PATH));
        if (this.renderer) {
            loader.detectSupport(this.renderer);
            const config = loader.workerConfig ?? {};
            const supported = Object.values(config).some(Boolean);
            if (needsKtx2 && !supported) {
                throw new VisualPreviewError(
                    VISUAL_PREVIEW_ERROR_CODES.UNSUPPORTED_RENDERER,
                    "Renderer does not support the pinned KTX2 transcoder.",
                );
            }
        } else if (needsKtx2) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.UNSUPPORTED_RENDERER,
                "KTX2 textures require a supported GPU transcoder.",
            );
        }
        this._ktx2Loader = loader;
        return loader;
    }

    async _three() {
        if (this.THREE) return this.THREE;
        this.THREE = await import("three");
        return this.THREE;
    }

    async _loaders() {
        if (!this.GLTFLoader) {
            const gltfModule = await import("three/examples/jsm/loaders/GLTFLoader.js");
            this.GLTFLoader = gltfModule.GLTFLoader;
        }
        if (this.KTX2Loader === undefined) {
            const ktxModule = await import("three/examples/jsm/loaders/KTX2Loader.js");
            this.KTX2Loader = ktxModule.KTX2Loader;
        }
        return { GLTFLoader: this.GLTFLoader, KTX2Loader: this.KTX2Loader };
    }

    _commit(staged, worldHash) {
        const group = staged.group;
        this.previewRoot.add(group);
        this._committed = group;
        this._committedWorldHash = worldHash;
        this._bindings = staged.bindings ?? new Map();
        group.name = "cev-sim.visual-layer";
        for (const url of this._stagingUrls) this._objectUrls.add(url);
        this._stagingUrls.clear();
    }

    _disposeCommitted() {
        if (this._committed) {
            this.previewRoot?.remove?.(this._committed);
            disposeObjectTree(this._committed);
            this._committed = null;
            this._revokeObjectUrls();
        }
        this._bindings = new Map();
    }

    async _disposeGroup(group) {
        if (!group) return;
        disposeObjectTree(group);
    }

    _disposeKtx2() {
        if (!this._ktx2Loader) return;
        this._ktx2Loader.dispose?.();
        this._ktx2Loader = null;
    }

    _revokeStagingUrls() {
        revokeUrlSet(this._stagingUrls);
    }

    _revokeObjectUrls() {
        revokeUrlSet(this._objectUrls);
        this._revokeStagingUrls();
    }

    _setStatus(status, error = null) {
        this.status = {
            status,
            error: error ? {
                code: error.code ?? VISUAL_PREVIEW_ERROR_CODES.DECODER_FAILED,
                message: error.message,
            } : null,
        };
        for (const listener of this._listeners) listener(this.status);
    }
}

function idleStatus() {
    return { status: VISUAL_PREVIEW_STATUS.idle, error: null };
}

function revokeUrlSet(urls) {
    for (const url of urls) {
        try {
            URL.revokeObjectURL(url);
        } catch {
            // already revoked
        }
    }
    urls.clear();
}

function toArrayBuffer(bytes) {
    if (bytes instanceof ArrayBuffer) return bytes;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function disposeObjectTree(root) {
    if (!root) return;
    root.removeFromParent?.();
    root.traverse?.((object) => {
        object.geometry?.dispose?.();
        const materials = [].concat(object.material ?? []);
        for (const material of materials) disposeMaterial(material);
    });
}

function disposeMaterial(material) {
    if (!material) return;
    for (const value of Object.values(material)) {
        if (value?.isTexture) value.dispose?.();
    }
    material.dispose?.();
}

function normalizePreviewError(error) {
    if (error instanceof VisualPreviewError) return error;
    return new VisualPreviewError(
        error?.code && Object.values(VISUAL_PREVIEW_ERROR_CODES).includes(error.code)
            ? error.code
            : VISUAL_PREVIEW_ERROR_CODES.DECODER_FAILED,
        error?.message || "Visual preview failed.",
    );
}

function mapClientError(error, fallback) {
    if (error instanceof VisualPreviewError) return error;
    const status = error?.status ?? error?.payload?.status;
    const code = error?.code ?? error?.payload?.code;
    if (status === 403 || code === "VISUAL_ASSET_RIGHTS_DENIED" || code === "VISUAL_LAYER_RIGHTS_DENIED") {
        return new VisualPreviewError(VISUAL_PREVIEW_ERROR_CODES.RIGHTS_DENIED, error.message);
    }
    if (status === 404 || code === "VISUAL_LAYER_DESCRIPTOR_NOT_FOUND") {
        return new VisualPreviewError(VISUAL_PREVIEW_ERROR_CODES.DESCRIPTOR_MISSING, error.message);
    }
    if (status === 404 || code === "VISUAL_ASSET_USE_NOT_FOUND" || code === "VISUAL_LAYER_ACCESS_NOT_FOUND") {
        return new VisualPreviewError(
            fallback === VISUAL_PREVIEW_ERROR_CODES.DESCRIPTOR_MISSING
                ? VISUAL_PREVIEW_ERROR_CODES.ASSET_MISSING
                : fallback,
            error.message,
        );
    }
    return new VisualPreviewError(fallback, error?.message || "Visual preview request failed.");
}
