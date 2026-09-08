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
    defaultVisualLodPolicy,
    hashVisualLayer,
    hashVisualLayerAccess,
    hashVisualLodPolicy,
    isVisualLayerMaterializableReference,
    sha256ExactBytes,
    sha256FromUri,
} from "../../../simulation/visual/VisualLayer.js";
import { getVisualScaleProfile } from "../../../simulation/visual/VisualScaleProfile.js";
import { VisualAssetClient } from "./VisualAssetClient.js";
import { VisualLayerClient } from "./VisualLayerClient.js";
import { createDigestUrlModifier } from "./VisualGltfUriGuard.js";
import {
    assertGltfMaterialBijection,
    createDescriptorMaterial,
    replaceEmbeddedMaterials,
} from "./VisualMaterialFactory.js";
import { sanitizePreviewObject } from "./VisualPreviewIsolation.js";
import { VisualBudgetError } from "./VisualMemoryLedger.js";
import {
    VisualChunkResidencyController,
    emptyResidencySnapshot,
} from "./VisualChunkResidencyController.js";
import {
    VisualResourceCache,
    visualResourceCacheForRenderer,
} from "./VisualResourceCache.js";

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
        cache = null,
        profile = getVisualScaleProfile(),
        lodPolicy = defaultVisualLodPolicy(),
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
        this.profile = profile;
        this.lodPolicy = lodPolicy;
        this.lodPolicyHash = hashVisualLodPolicy(lodPolicy);
        this._ownsCache = false;
        this.cache = cache ?? (renderer
            ? visualResourceCacheForRenderer(renderer, cacheOptions(this))
            : null);
        if (!this.cache) {
            this.cache = new VisualResourceCache(cacheOptions(this));
            this._ownsCache = true;
        }
        this.residency = new VisualChunkResidencyController({
            policy: lodPolicy,
            profile,
        });
        this._generation = 0;
        this._controller = null;
        this._disposed = false;
        this._ktx2Loader = null;
        this._committedWorldHash = null;
        this._bindings = new Map();
        this._lastRequest = null;
        this._listeners = new Set();
        this._documents = null;
        this._uses = new Map();
        this._interest = this.residency.normalizeInterest({ position: { x: 0, y: 0, z: 0 } });
        this._resident = new Map();
        this._queued = new Set();
        this._reconcileActive = null;
        this._coalescedInterest = null;
        this._layerSwitch = false;
        this._detachCache = this.cache.attach(this);
        this.status = idleStatus(this._residencyMetrics());
    }

    subscribe(listener) {
        this._listeners.add(listener);
        listener(this.status);
        return () => this._listeners.delete(listener);
    }

    visualBindings() {
        return new Map(this._bindings);
    }

    bakeSnapshotInputs() {
        if (!this._documents) return null;
        const selectedChunks = [...this._resident.entries()]
            .map(([id, resident]) => ({
                id: String(id),
                lodSignature: String(resident.lodSignature ?? ""),
            }))
            .sort((left, right) => String(left.id).localeCompare(String(right.id)));
        return {
            descriptor: this._documents.descriptor,
            access: this._documents.access,
            uses: [...this._uses.values()],
            selectedChunks,
            generation: this._generation,
            previewRoot: this.previewRoot,
            cache: this.cache,
            worldHash: this._committedWorldHash,
            bindings: this.visualBindings(),
            lodPolicyHash: this.lodPolicyHash,
        };
    }

    residencySnapshot() {
        return this._residencyMetrics();
    }

    async replace(reference, worldResource, { interest } = {}) {
        this._assertNotDisposed();
        if (this.cache.dead) this.handleContextLost();
        const generation = ++this._generation;
        this._abortCurrent();
        const controller = new AbortController();
        this._controller = controller;
        this._lastRequest = {
            reference: reference ?? null,
            worldResource: worldResource ?? null,
            interest: interest ?? this._interest,
        };
        if (interest) this._interest = this.residency.normalizeInterest(interest);
        const worldHash = worldResource?.hash ?? null;
        this._layerSwitch = true;
        this._coalescedInterest = null;
        if (this._committedWorldHash && worldHash && this._committedWorldHash !== worldHash) {
            this._releaseAllResident();
        }
        this._setStatus(VISUAL_PREVIEW_STATUS.loading);
        try {
            if (!reference) {
                this._releaseAllResident();
                this._documents = null;
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
            await this._revalidateCachedRights(uses, controller.signal);
            this._documents = { descriptor, access };
            this._uses = uses;
            this._committedWorldHash = worldHash;
            await this._reconcile({
                generation,
                signal: controller.signal,
                retainCommittedAoi: false,
            });
            return this.status;
        } catch (error) {
            if (generation !== this._generation) return this.status;
            this._releaseAllResident();
            if (error?.code === VISUAL_PREVIEW_ERROR_CODES.SUPERSEDED) return this.status;
            this._setStatus(VISUAL_PREVIEW_STATUS.error, normalizePreviewError(error));
            return this.status;
        } finally {
            if (generation === this._generation) this._layerSwitch = false;
        }
    }

    async updateInterest(interest = {}) {
        this._assertNotDisposed();
        if (this.cache.dead) {
            this.handleContextLost();
            return this.status;
        }
        this._interest = this.residency.normalizeInterest({ ...this._interest, ...interest });
        if (this._lastRequest) this._lastRequest.interest = this._interest;
        if (!this._documents) {
            this._setStatus(this.status.status, this.status.error && normalizePreviewError(this.status.error));
            return this.status;
        }
        if (this._reconcileActive) {
            this._coalescedInterest = this._interest;
            return this._reconcileActive;
        }
        return this._drainReconcile({ retainCommittedAoi: true });
    }

    async retry() {
        if (this.status?.residency?.retainCommittedAoi && this._documents) {
            return this.updateInterest(this._interest);
        }
        return this.replace(
            this._lastRequest?.reference,
            this._lastRequest?.worldResource,
            { interest: this._lastRequest?.interest },
        );
    }

    clear() {
        this._generation += 1;
        this._abortCurrent();
        this._releaseAllResident();
        this._documents = null;
        this._committedWorldHash = null;
        this._lastRequest = null;
        this._setStatus(VISUAL_PREVIEW_STATUS.idle);
        return this.status;
    }

    handleContextLost(reason) {
        this._generation += 1;
        this._abortCurrent();
        this._releaseAllResident({ skipCacheRelease: true });
        this.cache = this.cache.recreate({ reason });
        this._detachCache = this.cache.attach(this);
        this._ownsCache = false;
        this._setStatus(
            VISUAL_PREVIEW_STATUS.error,
            new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.CONTEXT_LOST,
                reason || "The visual renderer context was lost.",
            ),
        );
        return this.status;
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._generation += 1;
        this._abortCurrent();
        this._releaseAllResident();
        this._disposeKtx2();
        this._detachCache?.();
        if (this._ownsCache) this.cache.dispose();
        this._listeners.clear();
        this.previewRoot = null;
        this.status = idleStatus(emptyResidencySnapshot());
    }

    _assertNotDisposed() {
        if (this._disposed) {
            throw new VisualPreviewError(VISUAL_PREVIEW_ERROR_CODES.SUPERSEDED, "Visual layer materializer is disposed.");
        }
    }

    _abortCurrent() {
        this._controller?.abort();
        this._controller = null;
        this._coalescedInterest = null;
    }

    _throwIfStale(generation, signal) {
        if (this._disposed || generation !== this._generation || signal?.aborted) {
            throw new VisualPreviewError(VISUAL_PREVIEW_ERROR_CODES.SUPERSEDED, "Visual preview load was superseded.");
        }
    }

    async _drainReconcile({ retainCommittedAoi }) {
        const controller = this._controller ?? new AbortController();
        this._controller = controller;
        const generation = this._generation;
        this._reconcileActive = this._reconcile({
            generation,
            signal: controller.signal,
            retainCommittedAoi,
        }).finally(() => {
            if (this._reconcileActive) this._reconcileActive = null;
        });
        await this._reconcileActive;
        if (this._coalescedInterest && generation === this._generation) {
            this._interest = this._coalescedInterest;
            this._coalescedInterest = null;
            return this._drainReconcile({ retainCommittedAoi: true });
        }
        return this.status;
    }

    async _reconcile({ generation, signal, retainCommittedAoi }) {
        const descriptor = this._documents.descriptor;
        let plan;
        try {
            plan = this.residency.plan(descriptor, this._interest);
        } catch (error) {
            if (retainCommittedAoi && isBudgetError(error)) {
                this._setStatus(VISUAL_PREVIEW_STATUS.error, normalizePreviewError(error), {
                    retainCommittedAoi: true,
                });
                return this.status;
            }
            throw error;
        }
        const desiredIds = new Set([
            ...plan.required.map((chunk) => chunk.id),
            ...plan.prefetch.map((chunk) => chunk.id),
        ]);
        const missingRequired = plan.required.filter((chunk) => !this._chunkMatches(chunk.id, plan));
        const missingPrefetch = plan.prefetch.filter((chunk) => !this._chunkMatches(chunk.id, plan));
        for (const chunk of [...missingRequired, ...missingPrefetch]) this._queued.add(chunk.id);
        this._setStatus(VISUAL_PREVIEW_STATUS.loading, null, { plan });

        const staged = [];
        try {
            for (const chunk of missingRequired) {
                this._throwIfStale(generation, signal);
                staged.push(await this._loadChunk(chunk, plan, generation, signal));
            }
            for (const chunk of missingPrefetch) {
                this._throwIfStale(generation, signal);
                if (this._resident.size + staged.length >= this.residency.maxResidentChunks) {
                    this.residency.prefetchShed += 1;
                    break;
                }
                try {
                    staged.push(await this._loadChunk(chunk, plan, generation, signal));
                } catch (error) {
                    if (isBudgetError(error)) {
                        this.residency.prefetchShed += 1;
                        continue;
                    }
                    throw error;
                }
            }
            for (const loaded of staged) {
                this._commitChunk(loaded);
            }
            for (const chunkId of [...this._resident.keys()]) {
                if (!desiredIds.has(chunkId)) this._evictChunk(chunkId);
            }
            this._queued.clear();
            this._rebuildBindings();
            this._setStatus(VISUAL_PREVIEW_STATUS.ready, null, { plan });
            return this.status;
        } catch (error) {
            for (const loaded of staged) await this._disposeStagedChunk(loaded);
            this._queued.clear();
            if (generation !== this._generation) return this.status;
            if (retainCommittedAoi && isBudgetError(error) && this._resident.size > 0) {
                this._setStatus(VISUAL_PREVIEW_STATUS.error, normalizePreviewError(error), {
                    plan,
                    retainCommittedAoi: true,
                });
                return this.status;
            }
            throw error;
        }
    }

    _chunkMatches(chunkId, plan) {
        const resident = this._resident.get(chunkId);
        if (!resident) return false;
        return resident.lodSignature === lodSignatureForChunk(chunkId, this._documents.descriptor, plan);
    }

    async _loadChunk(chunk, plan, generation, signal) {
        const THREE = await this._three();
        const descriptor = this._documents.descriptor;
        const layerHash = hashVisualLayer(descriptor);
        const group = new THREE.Group();
        group.name = `cev-sim.visual-chunk:${chunk.id}`;
        sanitizePreviewObject(group, { layerHash, instanceId: null });
        const leases = [];
        const instances = descriptor.instances.filter((instance) => instance.chunkIds.includes(chunk.id));
        try {
            for (const instance of instances) {
                this._throwIfStale(generation, signal);
                const staged = await this._stageInstance(instance, plan, layerHash, generation, signal);
                leases.push(...staged.leases);
                group.add(staged.root);
            }
            return {
                chunkId: chunk.id,
                group,
                leases,
                lodSignature: lodSignatureForChunk(chunk.id, descriptor, plan),
                bindings: instances.flatMap((instance) => {
                    const binding = descriptor.bindings.find((entry) => entry.instanceId === instance.id);
                    return binding ? [[instance.id, { ...binding }]] : [];
                }),
            };
        } catch (error) {
            for (const lease of leases) lease.release?.();
            disposeInstanceTree(group);
            throw error;
        }
    }

    async _stageInstance(instance, plan, layerHash, generation, signal) {
        const THREE = await this._three();
        const lod = plan.selectedLods[instance.id];
        const digest = lod.digest;
        const parsed = await this._acquireParsed(digest, generation, signal);
        const leases = [parsed];
        try {
            assertGltfMaterialBijection(parsed.value.json, instance.materialIds);
            const textures = await this._texturesForInstance(instance, leases, generation, signal);
            const instanceMaterials = new Map();
            const materialsById = new Map(this._documents.descriptor.materials.map((material) => [material.id, material]));
            for (const materialId of instance.materialIds) {
                instanceMaterials.set(
                    materialId,
                    createDescriptorMaterial(THREE, materialsById.get(materialId), textures),
                );
            }
            const root = parsed.value.scene.clone(true);
            if (instance.materialIds.length > 0) {
                replaceEmbeddedMaterials(root, THREE, instanceMaterials);
            }
            root.matrix.fromArray(instance.matrix);
            root.matrixAutoUpdate = false;
            root.updateMatrixWorld(true);
            const binding = this._documents.descriptor.bindings.find((entry) => entry.instanceId === instance.id);
            sanitizePreviewObject(root, {
                layerHash,
                instanceId: instance.id,
                bindingId: binding?.id ?? null,
            });
            return { root, leases };
        } catch (error) {
            for (const lease of leases) lease.release?.();
            throw error;
        }
    }

    async _acquireParsed(digest, generation, signal) {
        const encoded = await this._acquireEncoded(digest, generation, signal);
        const closureLeases = await this._acquireDependencyLeases(encoded.entry?.useHash, generation, signal);
        try {
            const parsed = await this.cache.acquireParsed({
                digest,
                useHash: encoded.entry?.useHash,
                bytes: estimateParsedBytes(encoded.value),
                signal,
                loader: async () => {
                    const parsedValue = await this._parsePrimaryAsset(digest, encoded.value, signal);
                    return {
                        value: parsedValue,
                        bytes: estimateParsedBytes(encoded.value),
                        dispose: (value) => disposeObjectTree(value?.scene),
                    };
                },
            });
            this._throwIfStale(generation, signal);
            encoded.release();
            for (const lease of closureLeases) lease.release();
            return parsed;
        } catch (error) {
            encoded.release();
            for (const lease of closureLeases) lease.release();
            throw error;
        }
    }

    async _acquireDependencyLeases(useHash, generation, signal) {
        const leases = [];
        const use = this._uses.get(useHash);
        if (!use) return leases;
        for (const dependencyUseHash of Object.values(use.dependencies ?? {})) {
            const dependency = this._uses.get(dependencyUseHash);
            if (!dependency?.asset?.sha256) continue;
            leases.push(await this._acquireEncoded(dependency.asset.sha256, generation, signal));
        }
        return leases;
    }

    async _acquireEncoded(digest, generation, signal) {
        const { access } = this._documents;
        const digestToUse = new Map(access.assets.map((entry) => [entry.sha256, entry.useHash]));
        const useHash = digestToUse.get(digest);
        if (!useHash) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.ASSET_MISSING,
                `Visual asset ${digest} is not present in the access sidecar.`,
            );
        }
        const use = this._uses.get(useHash);
        this._throwIfStale(generation, signal);
        return this.cache.acquireEncoded({
            digest,
            useHash,
            mediaType: use.asset.mediaType,
            sizeBytes: use.asset.sizeBytes,
            signal,
            loader: async () => {
                const resource = await this._fetchAsset(useHash, use.asset, signal);
                this._collectUseClosure(useHash, this._uses, new Set());
                return resource.bytes;
            },
        });
    }

    async _revalidateCachedRights(uses, signal) {
        const useHashes = [...uses.keys()];
        try {
            await this.cache.revalidateSourceRights(useHashes);
        } catch (error) {
            this._throwIfStale(this._generation, signal);
            throw mapClientError(error, VISUAL_PREVIEW_ERROR_CODES.RIGHTS_DENIED);
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

    async _parsePrimaryAsset(digest, encodedBytes, signal) {
        const useHash = this._useHashForDigest(digest);
        const use = this._uses.get(useHash);
        const mediaType = use?.asset?.mediaType;
        if (!GLTF_MEDIA.has(mediaType)) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.MEDIA_MISMATCH,
                `Primary asset ${digest} must be glTF.`,
            );
        }
        if (this.parseGltf) {
            const parsed = await this.parseGltf(encodedBytes, digest, null);
            this._throwIfStale(this._generation, signal);
            return parsed;
        }
        const THREE = await this._three();
        const { GLTFLoader } = await this._loaders();
        const resources = await this._dependencyResourceMap(use, signal);
        const urlMap = this._objectUrlMap(resources);
        const manager = new THREE.LoadingManager();
        manager.setURLModifier(createDigestUrlModifier(urlMap, { allowInternalBlobUrls: true }));
        const loader = new GLTFLoader(manager);
        const ktx2 = await this._ensureKtx2(manager, resources);
        if (ktx2) loader.setKTX2Loader(ktx2);
        try {
            const gltf = await loader.parseAsync(toArrayBuffer(encodedBytes), "");
            const textures = gltf.parser?.json?.textures?.length
                ? await gltf.parser.getDependencies("texture")
                : [];
            if (textures.some((texture) => !texture)) {
                throw new VisualPreviewError(
                    VISUAL_PREVIEW_ERROR_CODES.DECODER_FAILED,
                    "A validated glTF texture failed to decode.",
                );
            }
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
        } finally {
            revokeUrlSet(new Set([...urlMap.values()].map((entry) => entry.objectUrl)));
            for (const resource of resources.values()) resource.lease?.release?.();
        }
    }

    async _dependencyResourceMap(use, signal) {
        const resources = new Map();
        if (!use) return resources;
        resources.set(use.asset.sha256, {
            bytes: null,
            mediaType: use.asset.mediaType,
            useHash: hashKey(use),
        });
        for (const [uri, useHash] of Object.entries(use.dependencies)) {
            const digest = sha256FromUri(uri);
            const encoded = await this._acquireEncoded(digest, this._generation, signal);
            resources.set(digest, {
                bytes: encoded.value,
                mediaType: this._uses.get(useHash)?.asset?.mediaType,
                useHash,
                lease: encoded,
            });
        }
        return resources;
    }

    async _texturesForInstance(instance, leases, generation, signal) {
        const textures = new Map();
        const materialsById = new Map(this._documents.descriptor.materials.map((material) => [material.id, material]));
        for (const materialId of instance.materialIds) {
            const material = materialsById.get(materialId);
            for (const texture of material.textures) {
                if (textures.has(texture.slot)) continue;
                const digest = sha256FromUri(texture.assetUri);
                const handle = await this._decodeTexture(digest, texture.slot, generation, signal);
                leases.push(handle);
                textures.set(texture.slot, handle.value);
            }
        }
        return textures;
    }

    async _decodeTexture(digest, slot, generation, signal) {
        const encoded = await this._acquireEncoded(digest, generation, signal);
        try {
            const handle = await this.cache.acquireTexture({
                digest,
                useHash: encoded.entry?.useHash,
                bytes: encoded.value?.byteLength ?? 0,
                signal,
                loader: async () => {
                    const decoded = await this._decodeTextureBytes(encoded.value, this._uses.get(encoded.entry.useHash)?.asset?.mediaType, slot, signal);
                    return { value: decoded, bytes: estimateTextureBytes(decoded, encoded.value) };
                },
            });
            encoded.release();
            return handle;
        } catch (error) {
            encoded.release();
            throw error;
        }
    }

    async _decodeTextureBytes(bytes, mediaType, slot, signal) {
        this._throwIfStale(this._generation, signal);
        try {
            if (this.decodeTexture) return await this.decodeTexture(bytes, mediaType, slot);
            const THREE = await this._three();
            if (mediaType === "image/ktx2") {
                const ktx2 = await this._ensureKtx2(null, new Map([["ktx2", { bytes, mediaType }]]));
                if (!ktx2) {
                    throw new VisualPreviewError(
                        VISUAL_PREVIEW_ERROR_CODES.UNSUPPORTED_RENDERER,
                        "KTX2 textures require a supported GPU transcoder.",
                    );
                }
                return await ktx2.parse(toArrayBuffer(bytes));
            }
            const blob = new Blob([bytes], { type: mediaType });
            const objectUrl = URL.createObjectURL(blob);
            try {
                const loader = new THREE.TextureLoader();
                return await loader.loadAsync(objectUrl);
            } finally {
                URL.revokeObjectURL(objectUrl);
            }
        } catch (error) {
            if (error instanceof VisualPreviewError) throw error;
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.DECODER_FAILED,
                error.message || `Failed to decode ${mediaType} texture.`,
            );
        }
    }

    _objectUrlMap(resources) {
        const map = new Map();
        for (const [digest, resource] of resources) {
            if (!resource?.bytes) continue;
            const blob = new Blob([resource.bytes], { type: resource.mediaType });
            map.set(digest, { objectUrl: URL.createObjectURL(blob), ...resource });
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

    _commitChunk(loaded) {
        this.previewRoot.add(loaded.group);
        loaded.group.name = `cev-sim.visual-layer:${loaded.chunkId}`;
        this._resident.set(loaded.chunkId, loaded);
        this._queued.delete(loaded.chunkId);
    }

    async _disposeStagedChunk(loaded) {
        this.previewRoot?.remove?.(loaded.group);
        disposeInstanceTree(loaded.group);
        for (const lease of loaded.leases ?? []) lease.release?.();
    }

    _evictChunk(chunkId) {
        const resident = this._resident.get(chunkId);
        if (!resident) return;
        this.previewRoot?.remove?.(resident.group);
        disposeInstanceTree(resident.group);
        for (const lease of resident.leases ?? []) lease.release?.();
        this._resident.delete(chunkId);
        this.residency.recordEviction(1);
    }

    _releaseAllResident({ skipCacheRelease = false } = {}) {
        for (const chunkId of [...this._resident.keys()]) {
            const resident = this._resident.get(chunkId);
            this.previewRoot?.remove?.(resident.group);
            disposeInstanceTree(resident.group);
            if (!skipCacheRelease) {
                for (const lease of resident.leases ?? []) lease.release?.();
            }
            this._resident.delete(chunkId);
        }
        this._bindings = new Map();
        this._queued.clear();
    }

    _rebuildBindings() {
        const bindings = new Map();
        for (const resident of this._resident.values()) {
            for (const [instanceId, binding] of resident.bindings ?? []) {
                bindings.set(instanceId, binding);
            }
        }
        this._bindings = bindings;
    }

    _useHashForDigest(digest) {
        return this._documents.access.assets.find((entry) => entry.sha256 === digest)?.useHash;
    }

    _disposeKtx2() {
        if (!this._ktx2Loader) return;
        this._ktx2Loader.dispose?.();
        this._ktx2Loader = null;
    }

    _residencyMetrics(plan = null, retainCommittedAoi = false) {
        let computed = plan;
        if (!computed && this._documents) {
            try {
                computed = this.residency.plan(this._documents.descriptor, this._interest);
            } catch {
                computed = null;
            }
        }
        return this.residency.snapshot({
            plan: computed,
            residentChunkIds: [...this._resident.keys()],
            queuedChunkIds: [...this._queued],
            memory: this.cache?.snapshot?.().memory ?? null,
            retainCommittedAoi,
        });
    }

    _setStatus(status, error = null, { plan = null, retainCommittedAoi = false } = {}) {
        this.status = {
            status,
            error: error ? {
                code: error.code ?? VISUAL_PREVIEW_ERROR_CODES.DECODER_FAILED,
                message: error.message,
            } : null,
            residency: this._residencyMetrics(plan, retainCommittedAoi),
        };
        for (const listener of this._listeners) listener(this.status);
    }
}

function cacheOptions(materializer) {
    return {
        renderer: materializer.renderer,
        profile: materializer.profile,
        rightsChecker: async ({ useHash, operations }) => {
            if (typeof materializer.assetClient.validateClosure === "function") {
                await materializer.assetClient.validateClosure({ useHash, operations });
            }
        },
    };
}

function idleStatus(residency = emptyResidencySnapshot()) {
    return { status: VISUAL_PREVIEW_STATUS.idle, error: null, residency };
}

function lodSignatureForChunk(chunkId, descriptor, plan) {
    const instances = (descriptor.instances ?? [])
        .filter((instance) => instance.chunkIds.includes(chunkId))
        .map((instance) => `${instance.id}:${plan.selectedLods[instance.id]?.uri ?? ""}`);
    instances.sort();
    return instances.join("|");
}

function estimateParsedBytes(bytes) {
    return Math.max(64, (bytes?.byteLength ?? 0) * 4);
}

function estimateTextureBytes(texture, encoded) {
    const image = texture?.image;
    const width = Number(image?.width ?? texture?.source?.data?.width ?? 0);
    const height = Number(image?.height ?? texture?.source?.data?.height ?? 0);
    if (width > 0 && height > 0) return width * height * 4;
    return encoded?.byteLength ?? 0;
}

function hashKey(use) {
    return use?.asset?.sha256 ?? null;
}

function revokeUrlSet(urls) {
    for (const url of urls) {
        try {
            URL.revokeObjectURL(url);
        } catch {
            // already revoked
        }
    }
    urls.clear?.();
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

function disposeInstanceTree(root) {
    if (!root) return;
    root.removeFromParent?.();
    root.traverse?.((object) => {
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

function isBudgetError(error) {
    return error instanceof VisualBudgetError
        || error?.code === VISUAL_PREVIEW_ERROR_CODES.BUDGET_EXCEEDED;
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
