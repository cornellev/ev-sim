'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { assetTransformMatrix, multiplyAssetMatrices } from "../../../editor-assets/AssetCompiler.js";
import { createEmptyAssetDefinition } from "../../../editor-assets/AssetDefinition.js";
import { createImportedAssetDefinition, extractAssetSourceGeometries } from "../../editor/assets/AssetModelLoader.js";
import { classifyAssetStudioChangeSet } from "../../editor/assets/assetStudioProjection.js";
import { assetStudioCommands } from "../../editor/commands/assetStudioCommands.js";
import { SceneProjector } from "../../editor/projection/SceneProjector.js";
import { createDescriptorMaterial } from "../../environment/visual/VisualMaterialFactory.js";
import { parseNumberDraft } from "../../editor/presentation/fieldModel.js";
import { useNumberInput } from "../fields/NumberField.js";
import { cn } from "../ui/cn";

function assetsRuntime(data) {
    return data?.environment?.()?.assets?.();
}

export function useAssetStudioSession(data, tab) {
    const sessions = assetsRuntime(data)?.sessions;
    const tabId = tab?.id;
    const subscribe = useCallback((notify) => sessions?.subscribe(notify) ?? (() => {}), [sessions]);
    const getSnapshot = useCallback(() => sessions?.get(tabId) ?? null, [sessions, tabId]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function rootNormalizationMatrix(normalization) {
    const scale = normalization.metersPerUnit;
    const rotationScale = assetTransformMatrix({ position: [0, 0, 0], quaternion: normalization.orientation, scale: [scale, scale, scale] });
    const pivot = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -normalization.pivot[0], -normalization.pivot[1], -normalization.pivot[2], 1];
    return multiplyAssetMatrices(rotationScale, pivot);
}

function mappingForObject(lease, object) {
    let cursor = object;
    while (cursor) {
        const mapping = lease.nodeMappings?.get(cursor);
        if (Number.isInteger(mapping?.nodes)) return { object: cursor, nodeIndex: mapping.nodes };
        cursor = cursor.parent;
    }
    return null;
}

function commandAccepted(result) {
    return result !== false && result?.ok !== false;
}

/** Interactive asset authoring viewport with an isolated renderer and history. */
export function AssetPreviewTab({ data, tab }) {
    const canvasRef = useRef(null);
    const [state, setState] = useState({ status: "loading", error: null });

    useEffect(() => {
        const controller = new AbortController();
        const leases = [];
        let disposeScene = null;
        let unsubscribe = null;
        let unsubscribeSelection = null;
        void (async () => {
            const runtime = assetsRuntime(data);
            if (!runtime) throw new Error("Asset studio runtime is unavailable.");
            const revision = await runtime.repository.getRevision(tab.assetId, tab.revision, { signal: controller.signal });
            let definition = revision.version === 2 ? revision.definition : null;
            const sourceGeometries = {};
            const sourceLeases = new Map();
            const childAppearanceLeases = new Map();
            if (!definition) {
                const lease = await runtime.models.acquire(revision.modelUseHash, { signal: controller.signal });
                leases.push(lease);
                definition = createImportedAssetDefinition({ lease, modelUseHash: revision.modelUseHash, name: tab.name });
                sourceGeometries.source = Object.fromEntries(extractAssetSourceGeometries(lease));
                sourceLeases.set("source", lease);
            }
            for (const source of definition.sources) {
                if (sourceGeometries[source.id]) continue;
                const lease = await runtime.models.acquire(source.modelUseHash, { signal: controller.signal });
                leases.push(lease);
                sourceGeometries[source.id] = Object.fromEntries(extractAssetSourceGeometries(lease));
                sourceLeases.set(source.id, lease);
            }
            const resolvedChildren = {};
            for (const part of definition.parts.filter((entry) => entry.content.kind === "asset-reference")) {
                const child = await runtime.repository.getRevision(part.content.assetId, part.content.revision, { signal: controller.signal });
                const childLease = await runtime.models.acquire(child.modelUseHash, { signal: controller.signal });
                leases.push(childLease);
                resolvedChildren[`${part.content.assetId}@${part.content.revision}`] = {
                    ...child,
                    geometry: Object.fromEntries(extractAssetSourceGeometries(childLease)),
                };
                childAppearanceLeases.set(part.id, { lease: childLease, modelUseHash: child.modelUseHash });
            }
            const session = runtime.sessions.open(tab.id, {
                assetId: tab.assetId,
                revision: tab.revision,
                modelUseHash: revision.modelUseHash,
                definition,
                sourceGeometries,
                resolvedChildren,
                publish: (draft) => runtime.repository.publishRevision(tab.assetId, draft, runtime.repository.catalogRevision),
                publishAs: (draft) => runtime.repository.publish(draft, runtime.repository.catalogRevision),
            });
            const THREE = await import("three");
            const [{ OrbitControls }, { TransformControls }] = await Promise.all([
                import("three/examples/jsm/controls/OrbitControls.js"),
                import("three/examples/jsm/controls/TransformControls.js"),
            ]);
            if (controller.signal.aborted) return;
            const canvas = canvasRef.current;
            const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
            renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio ?? 1));
            renderer.outputColorSpace = THREE.SRGBColorSpace;
            const scene = new THREE.Scene();
            scene.background = new THREE.Color(0x09090b);
            scene.add(new THREE.HemisphereLight(0xffffff, 0x202030, 2.5));
            const key = new THREE.DirectionalLight(0xffffff, 3); key.position.set(4, 6, 3); scene.add(key);
            scene.add(new THREE.GridHelper(20, 20, 0x3f3f46, 0x27272a));
            const root = new THREE.Group(); scene.add(root);
            const collisionOverlayGroup = new THREE.Group(); collisionOverlayGroup.name = "asset-studio-collision"; scene.add(collisionOverlayGroup);
            const lidarOverlayGroup = new THREE.Group(); lidarOverlayGroup.name = "asset-studio-lidar"; scene.add(lidarOverlayGroup);
            const projectedMaterials = new Set();
            const childOriginalMaterials = new Map();
            const meshOriginalMaterials = new Map();
            const pendingChildLeases = new Map();
            const pendingSourceLeases = new Map();
            const projection = {
                partGroups: new Map(),
                meshesByPart: new Map(),
                partIdByObject: new WeakMap(),
                sourceLeases,
                childAppearanceLeases,
                collisionOverlayGroup,
                lidarOverlayGroup,
            };
            let appearanceRebuilds = 0;
            let renderFrame = 0;
            let camera = null;

            const requestRender = () => {
                if (renderFrame || controller.signal.aborted || !camera) return;
                renderFrame = requestAnimationFrame(() => {
                    renderFrame = 0;
                    if (controller.signal.aborted) return;
                    renderer.render(scene, camera);
                });
            };
            const cancelRender = () => {
                if (!renderFrame) return;
                cancelAnimationFrame(renderFrame);
                renderFrame = 0;
            };
            const markRebuild = () => {
                appearanceRebuilds += 1;
                if (canvas) canvas.dataset.appearanceRebuilds = String(appearanceRebuilds);
            };

            const rememberChildMaterials = (lease) => {
                if (childOriginalMaterials.has(lease)) return;
                const originals = new Map();
                lease.root.traverse((object) => { if (object.isMesh) originals.set(object, object.material); });
                childOriginalMaterials.set(lease, originals);
            };
            childAppearanceLeases.forEach(({ lease }) => rememberChildMaterials(lease));

            const applyMaterialsToMeshes = (meshes, part, snapshot) => {
                for (const object of meshes) {
                    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
                    const originals = meshOriginalMaterials.get(object);
                    const bases = originals ?? sourceMaterials;
                    const replacements = (Array.isArray(bases) ? bases : [bases]).map((sourceMaterial, index) => {
                        const materialId = part.materialBindings[sourceMaterial?.name] ?? part.materialBindings[String(index)] ?? part.materialBindings.default;
                        const descriptor = snapshot.materials.find((entry) => entry.id === materialId);
                        if (!descriptor) return sourceMaterial;
                        const material = createDescriptorMaterial(THREE, descriptor);
                        projectedMaterials.add(material);
                        return material;
                    });
                    object.material = Array.isArray(object.material) ? replacements : replacements[0];
                }
            };

            const applyChildMaterials = (part, snapshot) => {
                const entry = childAppearanceLeases.get(part.id);
                if (!entry) return;
                const child = session.resolvedChildren[`${part.content.assetId}@${part.content.revision}`];
                const descriptors = new Map((child?.appearance ?? []).map((material) => [material.id, material]));
                const originals = childOriginalMaterials.get(entry.lease);
                entry.lease.root.traverse((object) => {
                    if (!object.isMesh) return;
                    const sourceMaterials = originals?.get(object);
                    const bases = sourceMaterials === undefined ? (Array.isArray(object.material) ? object.material : [object.material]) : (Array.isArray(sourceMaterials) ? sourceMaterials : [sourceMaterials]);
                    const replacements = bases.map((sourceMaterial) => {
                        const descriptor = descriptors.get(sourceMaterial?.name);
                        if (!descriptor) return sourceMaterial;
                        const material = createDescriptorMaterial(THREE, descriptor);
                        projectedMaterials.add(material);
                        return material;
                    });
                    object.material = Array.isArray(object.material) ? replacements : replacements[0];
                });
            };

            const ensureChildLeases = (snapshot) => {
                const expected = new Map(snapshot.parts
                    .filter((part) => part.content.kind === "asset-reference")
                    .map((part) => {
                        const child = session.resolvedChildren[`${part.content.assetId}@${part.content.revision}`];
                        return [part.id, { part, child }];
                    }));
                for (const [partId, entry] of childAppearanceLeases) {
                    const current = expected.get(partId)?.child;
                    if (current?.modelUseHash === entry.modelUseHash) continue;
                    entry.lease.release();
                    childAppearanceLeases.delete(partId);
                    childOriginalMaterials.delete(entry.lease);
                }
                for (const [partId, { child }] of expected) {
                    if (!child?.modelUseHash || childAppearanceLeases.has(partId)) continue;
                    const pending = pendingChildLeases.get(partId);
                    if (pending === child.modelUseHash) continue;
                    pendingChildLeases.set(partId, child.modelUseHash);
                    void runtime.models.acquire(child.modelUseHash, { signal: controller.signal }).then((lease) => {
                        leases.push(lease);
                        pendingChildLeases.delete(partId);
                        const currentPart = session.document.getPart(partId);
                        const current = currentPart?.content.kind === "asset-reference"
                            ? session.resolvedChildren[`${currentPart.content.assetId}@${currentPart.content.revision}`]
                            : null;
                        if (controller.signal.aborted || current?.modelUseHash !== child.modelUseHash) {
                            lease.release();
                            return;
                        }
                        childAppearanceLeases.set(partId, { lease, modelUseHash: child.modelUseHash });
                        rememberChildMaterials(lease);
                        rebuildAppearance(session.document.snapshot());
                        requestRender();
                    }).catch((error) => {
                        pendingChildLeases.delete(partId);
                        if (!controller.signal.aborted) {
                            session.error = error;
                            session.notify();
                        }
                    });
                }
            };

            const reconcileSourceLeases = (snapshot) => {
                const expected = new Map((snapshot.sources ?? []).map((source) => [source.id, source]));
                for (const [sourceId, lease] of sourceLeases) {
                    if (expected.has(sourceId)) continue;
                    lease.release();
                    sourceLeases.delete(sourceId);
                }
                for (const source of expected.values()) {
                    if (sourceLeases.has(source.id) || pendingSourceLeases.get(source.id) === source.modelUseHash) continue;
                    pendingSourceLeases.set(source.id, source.modelUseHash);
                    void runtime.models.acquire(source.modelUseHash, { signal: controller.signal }).then((lease) => {
                        leases.push(lease);
                        pendingSourceLeases.delete(source.id);
                        const current = session.document.snapshot().sources.find((entry) => entry.id === source.id);
                        if (controller.signal.aborted || current?.modelUseHash !== source.modelUseHash) {
                            lease.release();
                            return;
                        }
                        sourceLeases.set(source.id, lease);
                        rebuildAppearance(session.document.snapshot());
                        requestRender();
                    }).catch((error) => {
                        pendingSourceLeases.delete(source.id);
                        if (!controller.signal.aborted) {
                            session.error = error;
                            session.notify();
                        }
                    });
                }
            };

            const rebuildAppearance = (snapshot) => {
                markRebuild();
                projectedMaterials.forEach((material) => material.dispose?.());
                projectedMaterials.clear();
                childOriginalMaterials.forEach((originals) => originals.forEach((material, object) => { object.material = material; }));
                meshOriginalMaterials.clear();
                root.clear();
                projection.partGroups = new Map();
                projection.meshesByPart = new Map();
                projection.partIdByObject = new WeakMap();
                for (const part of snapshot.parts) {
                    const group = new THREE.Group();
                    group.name = `asset-part:${part.id}`;
                    group.position.fromArray(part.transform.position);
                    group.quaternion.fromArray(part.transform.quaternion);
                    group.scale.fromArray(part.transform.scale);
                    projection.partGroups.set(part.id, group);
                    projection.partIdByObject.set(group, part.id);
                }
                for (const part of snapshot.parts) {
                    const group = projection.partGroups.get(part.id);
                    (part.parentId ? projection.partGroups.get(part.parentId) : root).add(group);
                }
                const partsByNode = new Map();
                for (const part of snapshot.parts) {
                    if (part.content.kind !== "model-node") continue;
                    const key = `${part.content.sourceId}:${part.content.nodeIndex}`;
                    const list = partsByNode.get(key) ?? [];
                    list.push(part);
                    partsByNode.set(key, list);
                }
                for (const [sourceId, lease] of sourceLeases) {
                    lease.root.updateMatrixWorld(true);
                    lease.root.traverse((object) => {
                        if (!object.isMesh) return;
                        const mapping = mappingForObject(lease, object);
                        if (!mapping) return;
                        const parts = partsByNode.get(`${sourceId}:${mapping.nodeIndex}`) ?? [];
                        if (parts.length === 0) return;
                        const relative = new THREE.Matrix4().copy(mapping.object.matrixWorld).invert().multiply(object.matrixWorld);
                        for (const part of parts) {
                            const mesh = object.clone(false);
                            relative.decompose(mesh.position, mesh.quaternion, mesh.scale);
                            mesh.visible = part.appearanceVisible;
                            meshOriginalMaterials.set(mesh, object.material);
                            projection.partGroups.get(part.id).add(mesh);
                            projection.partIdByObject.set(mesh, part.id);
                            const meshes = projection.meshesByPart.get(part.id) ?? [];
                            meshes.push(mesh);
                            projection.meshesByPart.set(part.id, meshes);
                        }
                    });
                }
                for (const part of snapshot.parts.filter((entry) => entry.content.kind === "asset-reference")) {
                    const entry = childAppearanceLeases.get(part.id);
                    if (!entry) continue;
                    entry.lease.root.visible = part.appearanceVisible;
                    entry.lease.root.traverse((object) => projection.partIdByObject.set(object, part.id));
                    projection.partGroups.get(part.id).add(entry.lease.root);
                    applyChildMaterials(part, snapshot);
                }
                for (const part of snapshot.parts.filter((entry) => entry.content.kind === "model-node")) {
                    applyMaterialsToMeshes(projection.meshesByPart.get(part.id) ?? [], part, snapshot);
                }
                applyNormalization(snapshot);
            };

            const refreshProjectedMaterials = (snapshot) => {
                projectedMaterials.forEach((material) => material.dispose?.());
                projectedMaterials.clear();
                childOriginalMaterials.forEach((originals) => originals.forEach((material, object) => { object.material = material; }));
                for (const [mesh, original] of meshOriginalMaterials) mesh.material = original;
                for (const part of snapshot.parts.filter((entry) => entry.content.kind === "model-node")) {
                    applyMaterialsToMeshes(projection.meshesByPart.get(part.id) ?? [], part, snapshot);
                }
                for (const part of snapshot.parts.filter((entry) => entry.content.kind === "asset-reference")) {
                    applyChildMaterials(part, snapshot);
                }
            };

            const applyPartTransforms = (snapshot, ids) => {
                for (const id of ids) {
                    const part = snapshot.parts.find((entry) => entry.id === id);
                    const group = projection.partGroups.get(id);
                    if (!part || !group) continue;
                    group.position.fromArray(part.transform.position);
                    group.quaternion.fromArray(part.transform.quaternion);
                    group.scale.fromArray(part.transform.scale);
                }
            };

            const applyPartVisibility = (snapshot, ids) => {
                for (const id of ids) {
                    const part = snapshot.parts.find((entry) => entry.id === id);
                    const group = projection.partGroups.get(id);
                    if (!part || !group) continue;
                    group.visible = part.appearanceVisible;
                    for (const mesh of projection.meshesByPart.get(id) ?? []) mesh.visible = part.appearanceVisible;
                    const childLease = childAppearanceLeases.get(id);
                    if (childLease) childLease.lease.root.visible = part.appearanceVisible;
                }
            };

            const applyNormalization = (snapshot) => {
                root.matrixAutoUpdate = false;
                root.matrix.fromArray(rootNormalizationMatrix(snapshot.normalization));
                root.matrixWorldNeedsUpdate = true;
                root.updateMatrixWorld(true);
            };

            const rebuildMetricOverlay = (channel, compiled) => {
                const group = channel === "collision" ? collisionOverlayGroup : lidarOverlayGroup;
                while (group.children.length) {
                    const child = group.children.at(-1);
                    group.remove(child);
                    child.geometry?.dispose?.();
                    child.material?.dispose?.();
                }
                const color = channel === "collision" ? 0xf97316 : 0x22d3ee;
                for (const proxy of compiled.metric[channel] ?? []) {
                    const geometry = new THREE.BufferGeometry();
                    geometry.setAttribute("position", new THREE.Float32BufferAttribute(proxy.vertices.flat(), 3));
                    geometry.setIndex(proxy.triangles.flat());
                    geometry.computeVertexNormals();
                    const material = new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.8, depthTest: false });
                    const mesh = new THREE.Mesh(geometry, material);
                    mesh.name = `${channel}:${proxy.id}`;
                    mesh.renderOrder = 10;
                    group.add(mesh);
                }
                group.visible = channel === "collision" ? session.view.showCollision !== false : session.view.showLidar !== false;
            };

            const syncSelection = () => {
                const selected = session.selection.primary;
                const group = selected ? projection.partGroups.get(selected) : null;
                if (group) transform.attach(group);
                else transform.detach();
            };

            const applyAssetProjection = ({ changeSet }) => {
                const snapshot = session.document.snapshot();
                const plan = classifyAssetStudioChangeSet(changeSet);
                if (plan.reconcileSourceLeases) reconcileSourceLeases(snapshot);
                if (plan.reconcileChildLeases) ensureChildLeases(snapshot);
                if (plan.rebuildAppearance) rebuildAppearance(snapshot);
                else {
                    if (plan.refreshMaterials) refreshProjectedMaterials(snapshot);
                    if (plan.transformPartIds.size) applyPartTransforms(snapshot, plan.transformPartIds);
                    if (plan.visibilityPartIds.size) applyPartVisibility(snapshot, plan.visibilityPartIds);
                }
                if (plan.applyNormalization) applyNormalization(snapshot);
                const needsCompile = plan.applyNormalization || plan.rebuildCollision || plan.rebuildLidar;
                if (needsCompile) {
                    const compiled = session.compile();
                    if (plan.applyNormalization || plan.rebuildCollision) rebuildMetricOverlay("collision", compiled);
                    if (plan.applyNormalization || plan.rebuildLidar) rebuildMetricOverlay("lidar", compiled);
                }
                syncSelection();
                requestRender();
            };

            const initialSnapshot = session.document.snapshot();
            rebuildAppearance(initialSnapshot);
            camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
            const initialBounds = new THREE.Box3().setFromObject(root);
            const center = initialBounds.isEmpty() ? new THREE.Vector3() : initialBounds.getCenter(new THREE.Vector3());
            const radius = initialBounds.isEmpty() ? 1 : Math.max(1, initialBounds.getSize(new THREE.Vector3()).length());
            camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.7, radius));
            const orbit = new OrbitControls(camera, canvas);
            if (session.view.camera) {
                camera.position.fromArray(session.view.camera.position);
                orbit.target.fromArray(session.view.camera.target);
            } else orbit.target.copy(center);
            orbit.update();
            const transform = new TransformControls(camera, canvas);
            transform.addEventListener("dragging-changed", (event) => { orbit.enabled = !event.value; });
            transform.addEventListener("objectChange", () => requestRender());
            transform.addEventListener("mouseUp", () => {
                const object = transform.object;
                const part = object && session.document.getPart(session.selection.primary);
                if (!part || object !== projection.partGroups.get(part.id)) return;
                const result = session.bus.execute(assetStudioCommands.transformPart(part.id, {
                    position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray(),
                }));
                if (!result.ok) applyPartTransforms(session.document.snapshot(), [part.id]);
            });
            scene.add(transform.getHelper?.() ?? transform);

            const compiled = session.compile();
            rebuildMetricOverlay("collision", compiled);
            rebuildMetricOverlay("lidar", compiled);
            const projector = new SceneProjector({
                data: null,
                scene,
                document: session.document,
                registry: null,
                projectors: [{ id: "asset-studio", apply: (ctx) => applyAssetProjection({ changeSet: ctx.changeSet }) }],
            }).attach();
            syncSelection();
            requestRender();
            unsubscribe = session.subscribe((snapshot) => {
                data?.editor?.()?.setAssetTabDirty?.(tab.id, snapshot.dirty);
                collisionOverlayGroup.visible = snapshot.view.showCollision !== false;
                lidarOverlayGroup.visible = snapshot.view.showLidar !== false;
                requestRender();
            });
            unsubscribeSelection = session.selection.subscribe(() => {
                syncSelection();
                requestRender();
            });

            const raycaster = new THREE.Raycaster();
            const pointer = new THREE.Vector2();
            const pick = (event) => {
                const rect = canvas.getBoundingClientRect();
                pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
                raycaster.setFromCamera(pointer, camera);
                const hit = raycaster.intersectObject(root, true)[0];
                let cursor = hit?.object ?? null;
                let partId = null;
                while (cursor && !partId) { partId = projection.partIdByObject.get(cursor) ?? null; cursor = cursor.parent; }
                if (partId) session.selection.select(partId);
                else { session.selection.clear(); transform.detach(); }
                requestRender();
            };
            canvas.addEventListener("pointerdown", pick);
            const resize = new ResizeObserver(() => {
                const rect = canvas.getBoundingClientRect();
                renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
                camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
                camera.updateProjectionMatrix();
                requestRender();
            });
            resize.observe(canvas);
            orbit.addEventListener("change", () => requestRender());
            orbit.addEventListener("end", () => session.setView({ camera: { position: camera.position.toArray(), target: orbit.target.toArray() } }));
            canvas.dataset.appearanceRebuilds = String(appearanceRebuilds);
            disposeScene = () => {
                cancelRender();
                resize.disconnect();
                canvas.removeEventListener("pointerdown", pick);
                projector.dispose();
                orbit.dispose();
                transform.dispose();
                projectedMaterials.forEach((material) => material.dispose?.());
                renderer.dispose();
            };
            setState({ status: "ready", error: null });
        })().catch((error) => { if (!controller.signal.aborted) setState({ status: "error", error: error.message }); });
        return () => { controller.abort(); unsubscribe?.(); unsubscribeSelection?.(); disposeScene?.(); leases.forEach((lease) => lease.release?.()); };
    }, [data, tab.assetId, tab.id, tab.name, tab.revision]);

    return <div className="pointer-events-auto absolute inset-0 bg-zinc-950" data-asset-preview-tab={tab.id}>
        <canvas ref={canvasRef} aria-label={`${tab.name} asset studio viewport`} className="h-full w-full touch-none" />
        {state.status === "loading" && <p role="status" className="absolute left-1/2 top-1/2 -translate-x-1/2 text-sm text-zinc-400">Loading asset studio…</p>}
        {state.status === "error" && <p role="alert" className="absolute left-1/2 top-1/2 max-w-md -translate-x-1/2 text-sm text-red-300">{state.error}</p>}
    </div>;
}

export function AssetStudioHierarchy({ data, tab }) {
    const session = useAssetStudioSession(data, tab);
    const [snapshot, setSnapshot] = useState(null);
    const [selection, setSelection] = useState(null);
    const rowRefs = useRef(new Map());
    useEffect(() => session?.document.subscribe(setSnapshot), [session]);
    useEffect(() => session?.selection.subscribe(setSelection), [session]);
    useEffect(() => {
        const id = selection?.primary;
        if (!id) return;
        rowRefs.current.get(id)?.scrollIntoView({ block: "nearest" });
    }, [selection?.primary]);
    if (!session) return <p role="status" className="p-3 text-xs text-zinc-400">Loading parts…</p>;
    return (
        <div role="tree" aria-label="Asset parts" className="h-full min-h-0 overflow-y-auto p-2 text-xs">
            {(snapshot?.parts ?? []).map((part) => {
                const selected = selection?.primary === part.id;
                return (
                    <button
                        key={part.id}
                        ref={(element) => {
                            if (element) rowRefs.current.set(part.id, element);
                            else rowRefs.current.delete(part.id);
                        }}
                        role="treeitem"
                        type="button"
                        aria-selected={selected}
                        aria-current={selected || undefined}
                        data-selected={selected || undefined}
                        onClick={() => session.selection.select(part.id)}
                        className={cn(
                            "block w-full truncate rounded border px-2 py-1 text-left",
                            selected
                                ? "border-[var(--slate-border)] bg-[var(--slate-surface-3)] text-[var(--slate-fg)] ring-1 ring-inset ring-[var(--slate-ring)]"
                                : "border-transparent text-[var(--slate-fg-2)] hover:bg-[var(--slate-surface-hover)]",
                        )}
                        style={{ paddingLeft: `${8 + (part.parentId ? 16 : 0)}px` }}
                    >
                        {part.name}
                    </button>
                );
            })}
        </div>
    );
}

function AssetNumberField({ label, value, onCommit, step = 0.01 }) {
    const id = useId();
    const [issues, setIssues] = useState([]);
    const descriptor = { label, step, path: [label] };
    const { input, scrubHandlers } = useNumberInput({
        id,
        descriptor,
        value,
        issues,
        ariaLabel: label,
        onCommit: (next) => {
            const result = onCommit(next);
            if (!commandAccepted(result)) {
                setIssues(result?.issues ?? [{ message: result?.error ?? "Value was rejected.", severity: "error" }]);
                return false;
            }
            setIssues([]);
            return true;
        },
    });
    return (
        <div>
            <label className="grid grid-cols-[1fr_84px] items-center gap-2">
                <span className={scrubHandlers ? "cursor-ew-resize select-none" : undefined} {...(scrubHandlers ?? {})}>{label}</span>
                {input}
            </label>
            {issues[0] && <p role="alert" className="text-[11px] text-red-300">{issues[0].message}</p>}
        </div>
    );
}

function PinnedRevisionField({ value, onCommit }) {
    const id = useId();
    const [draft, setDraft] = useState(null);
    const [issues, setIssues] = useState([]);
    const committed = Number.isInteger(value) ? String(value) : "";
    const shown = draft ?? committed;
    const commit = async (text) => {
        const parsed = parseNumberDraft(text, { step: 1, min: 1 });
        if (!parsed.ok || !Number.isInteger(parsed.value) || parsed.value <= 0) {
            if (!String(text ?? "").trim()) {
                setDraft(null);
                setIssues([]);
                return;
            }
            setIssues([{ message: "Pinned revision must be a positive integer.", severity: "error" }]);
            return;
        }
        if (parsed.value === value) {
            setDraft(null);
            setIssues([]);
            return;
        }
        try {
            const result = await onCommit(parsed.value);
            if (!commandAccepted(result)) {
                setIssues(result?.issues ?? [{ message: result?.error ?? "Revision load failed.", severity: "error" }]);
                return;
            }
            setDraft(null);
            setIssues([]);
        } catch (error) {
            setIssues([{ message: error.message ?? String(error), severity: "error" }]);
        }
    };
    return (
        <div>
            <label className="grid grid-cols-[1fr_84px] items-center gap-2">
                <span>Pinned revision</span>
                <input
                    id={id}
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Pinned revision"
                    aria-invalid={issues.length > 0 || undefined}
                    value={shown}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={(event) => { if (draft !== null) void commit(event.target.value); }}
                    onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") {
                            event.preventDefault();
                            void commit(event.currentTarget.value);
                        } else if (event.key === "Escape") {
                            event.preventDefault();
                            setDraft(null);
                            setIssues([]);
                            event.currentTarget.blur();
                        }
                    }}
                    className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1"
                />
            </label>
            {issues[0] && <p role="alert" className="text-[11px] text-red-300">{issues[0].message}</p>}
        </div>
    );
}

function newMaterial(id) {
    return {
        id, mode: "metallic-roughness", alphaMode: "OPAQUE", alphaCutoff: 0.5, doubleSided: false,
        parameters: {
            baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1,
            emissiveFactor: [0, 0, 0], emissiveStrength: 1, normalScale: 1, occlusionStrength: 1,
            clearcoatFactor: 0, clearcoatRoughnessFactor: 0, sheenColorFactor: [0, 0, 0],
            sheenRoughnessFactor: 0, specularFactor: 1, specularColorFactor: [1, 1, 1],
        },
        textures: [], extensions: [],
    };
}

function colorHex(factor) {
    return `#${factor.slice(0, 3).map((value) => Math.round(value * 255).toString(16).padStart(2, "0")).join("")}`;
}

function colorFactor(hex, alpha) {
    return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255).concat(alpha);
}

export function AssetCatalogInspector({ data, tab }) {
    const session = useAssetStudioSession(data, tab);
    const [snapshot, setSnapshot] = useState(null);
    const [selection, setSelection] = useState(null);
    const [status, setStatus] = useState(null);
    useEffect(() => session?.document.subscribe(setSnapshot), [session]);
    useEffect(() => session?.selection.subscribe(setSelection), [session]);
    useEffect(() => session?.subscribe(setStatus), [session]);
    const part = useMemo(() => snapshot?.parts?.find((entry) => entry.id === selection?.primary) ?? null, [snapshot, selection]);
    const staleProxyIds = useMemo(() => {
        try { return session && snapshot ? session.compile().staleProxyIds : []; } catch { return []; }
    }, [session, snapshot]);
    const setNormalization = useCallback((patch) => session?.bus.execute(assetStudioCommands.setNormalization(patch)), [session]);
    const updateChildRevision = useCallback(async (selectedPart, revision) => {
        const runtime = assetsRuntime(data);
        const child = await runtime.repository.getRevision(selectedPart.content.assetId, revision);
        const lease = await runtime.models.acquire(child.modelUseHash);
        try {
            session.setResolvedChild(`${selectedPart.content.assetId}@${revision}`, {
                ...child, geometry: Object.fromEntries(extractAssetSourceGeometries(lease)),
            });
            return session.bus.execute(assetStudioCommands.updateChildRevision(selectedPart.id, revision));
        } finally { lease.release(); }
    }, [data, session]);
    const reloadLatest = useCallback(async () => {
        const runtime = assetsRuntime(data);
        const catalogRecord = await runtime.repository.get(session.assetId);
        const revision = await runtime.repository.getRevision(session.assetId, catalogRecord.asset.latestRevision);
        const definition = revision.version === 2 ? revision.definition : createEmptyAssetDefinition({ modelUseHash: revision.modelUseHash, name: catalogRecord.asset.name });
        const sourceGeometries = {};
        for (const source of definition.sources) {
            const lease = await runtime.models.acquire(source.modelUseHash);
            try { sourceGeometries[source.id] = Object.fromEntries(extractAssetSourceGeometries(lease)); } finally { lease.release(); }
        }
        const resolvedChildren = {};
        for (const childPart of definition.parts.filter((entry) => entry.content.kind === "asset-reference")) {
            const child = await runtime.repository.getRevision(childPart.content.assetId, childPart.content.revision);
            const lease = await runtime.models.acquire(child.modelUseHash);
            try { resolvedChildren[`${childPart.content.assetId}@${childPart.content.revision}`] = { ...child, geometry: Object.fromEntries(extractAssetSourceGeometries(lease)) }; } finally { lease.release(); }
        }
        session.reload({ definition, revision: revision.revision, modelUseHash: revision.modelUseHash, sourceGeometries, resolvedChildren });
        data.editor?.()?.updateAssetTabRevision?.(tab.id, revision.revision);
    }, [data, session, tab.id]);
    const saveAs = useCallback(async () => {
        const assetId = globalThis.prompt?.("New asset ID")?.trim();
        if (!assetId) return;
        const name = globalThis.prompt?.("New asset name", `${tab.name} copy`)?.trim();
        if (!name) return;
        const result = await session.saveAs({ assetId, name, publicationId: globalThis.crypto?.randomUUID?.() ?? `publication-${Date.now()}` });
        data.editor?.()?.openAssetTab?.({ id: assetId, revision: result.revision.revision, name }, { pinned: true });
    }, [data, session, tab.name]);
    const save = useCallback(async () => {
        const result = await session.save({ publicationId: globalThis.crypto?.randomUUID?.() ?? `publication-${Date.now()}` });
        const revision = result.revision?.revision ?? result.asset?.latestRevision;
        if (Number.isInteger(revision)) data.editor?.()?.updateAssetTabRevision?.(tab.id, revision);
    }, [data, session, tab.id]);
    const includedPartIds = status?.view?.includedPartIds ?? [];
    const staleLidarProxy = snapshot?.lidarProxies?.find((proxy) => staleProxyIds.includes(proxy.id) && proxy.generated) ?? null;
    if (!session || !snapshot) return <p role="status" className="p-3 text-xs text-zinc-400">Loading inspector…</p>;
    return <div className="space-y-4 p-3 text-xs" data-asset-catalog-inspector>
        <header><h3 className="text-sm font-medium text-zinc-100">{tab.name}</h3><p className="text-zinc-400">Revision {status?.revision ?? tab.revision}{status?.dirty ? " · Unsaved" : ""}</p></header>
        <section className="space-y-2"><h4 className="font-medium text-zinc-200">Normalization</h4><AssetNumberField label="Meters per unit" value={snapshot.normalization.metersPerUnit} onCommit={(metersPerUnit) => setNormalization({ metersPerUnit })} />{[0, 1, 2].map((axis) => <AssetNumberField key={axis} label={`Pivot ${"XYZ"[axis]}`} value={snapshot.normalization.pivot[axis]} onCommit={(value) => { const pivot = [...snapshot.normalization.pivot]; pivot[axis] = value; return setNormalization({ pivot }); }} />)}</section>
        {part && <section className="space-y-2"><h4 className="font-medium text-zinc-200">Part · {part.name}</h4>{[0, 1, 2].map((axis) => <AssetNumberField key={axis} label={`Position ${"XYZ"[axis]}`} value={part.transform.position[axis]} onCommit={(value) => { const next = structuredClone(part.transform); next.position[axis] = value; return session.bus.execute(assetStudioCommands.transformPart(part.id, next)); }} />)}{part.content.kind === "asset-reference" && <PinnedRevisionField value={part.content.revision} onCommit={(revision) => updateChildRevision(part, revision)} />}{part.content.kind === "model-node" && <label className="grid grid-cols-[1fr_1.5fr] items-center gap-2"><span>Material</span><select value={part.materialBindings.default ?? ""} onChange={(event) => session.bus.execute(assetStudioCommands.setMaterialBinding(part.id, "default", event.target.value || null))} className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1"><option value="">Source material</option>{snapshot.materials.map((material) => <option key={material.id} value={material.id}>{material.id}</option>)}</select></label>}</section>}
        <section className="space-y-2"><div className="flex items-center justify-between"><h4 className="font-medium text-zinc-200">Materials</h4><button type="button" onClick={() => { let suffix = snapshot.materials.length + 1; while (snapshot.materials.some((entry) => entry.id === `material-${suffix}`)) suffix += 1; session.bus.execute(assetStudioCommands.upsertMaterial(newMaterial(`material-${suffix}`))); }} className="rounded border border-zinc-700 px-2 py-1">Add</button></div>{snapshot.materials.map((material) => <fieldset key={material.id} className="space-y-2 rounded border border-zinc-800 p-2"><legend className="px-1 text-zinc-300">{material.id}</legend><label className="grid grid-cols-[1fr_84px] items-center gap-2"><span>Base color</span><input type="color" value={colorHex(material.parameters.baseColorFactor)} onChange={(event) => session.bus.execute(assetStudioCommands.upsertMaterial({ ...material, parameters: { ...material.parameters, baseColorFactor: colorFactor(event.target.value, material.parameters.baseColorFactor[3]) } }))} /></label><AssetNumberField label="Metallic" value={material.parameters.metallicFactor} onCommit={(metallicFactor) => session.bus.execute(assetStudioCommands.upsertMaterial({ ...material, parameters: { ...material.parameters, metallicFactor } }))} /><AssetNumberField label="Roughness" value={material.parameters.roughnessFactor} onCommit={(roughnessFactor) => session.bus.execute(assetStudioCommands.upsertMaterial({ ...material, parameters: { ...material.parameters, roughnessFactor } }))} /><button type="button" onClick={() => { const useHash = globalThis.prompt?.("Texture use hash"); const digest = globalThis.prompt?.("Texture byte digest"); if (!useHash || !digest) return; const texture = { slot: "baseColor", useHash, assetUri: `sha256:${digest}`, texCoord: 0, transform: { offset: [0, 0], rotation: 0, scale: [1, 1] } }; session.bus.execute(assetStudioCommands.upsertMaterial({ ...material, textures: [...material.textures.filter((entry) => entry.slot !== "baseColor"), texture] })); }} className="rounded border border-zinc-700 px-2 py-1">Replace base color texture</button></fieldset>)}</section>
        <section className="space-y-2"><div className="flex items-center justify-between"><h4 className="font-medium text-zinc-200">Metric proxies</h4><button type="button" disabled={snapshot.parts.length === 0 || snapshot.parts.every((entry) => includedPartIds.includes(entry.id))} onClick={() => session.setView({ includedPartIds: snapshot.parts.map((entry) => entry.id) })} className="rounded border border-zinc-700 px-2 py-1 disabled:opacity-40">Select All</button></div><div className="flex gap-3"><label className="flex items-center gap-1"><input type="checkbox" checked={status?.view?.showCollision !== false} onChange={(event) => session.setView({ showCollision: event.target.checked })} />Collision overlay</label><label className="flex items-center gap-1"><input type="checkbox" checked={status?.view?.showLidar !== false} onChange={(event) => session.setView({ showLidar: event.target.checked })} />LiDAR overlay</label></div>{snapshot.parts.map((entry) => <label key={entry.id} className="flex items-center gap-2"><input type="checkbox" checked={includedPartIds.includes(entry.id)} onChange={(event) => session.setView({ includedPartIds: event.target.checked ? [...includedPartIds, entry.id] : includedPartIds.filter((id) => id !== entry.id) })} />Include {entry.name}</label>)}<div className="flex gap-2"><button type="button" disabled={includedPartIds.length === 0 && !staleLidarProxy} onClick={() => { const generated = staleLidarProxy?.generated; void session.generateProxy({ id: staleLidarProxy?.id ?? `lidar-generated-${snapshot.lidarProxies.length + 1}`, channel: "lidar", includedPartIds: staleLidarProxy ? generated.includedPartIds : includedPartIds, voxelSize: generated?.parameters?.voxelSize ?? 0.2, semantic: staleLidarProxy?.semantic ?? "unknown" }); }} className="rounded border border-zinc-700 px-2 py-1 disabled:opacity-40">{staleLidarProxy ? "Regenerate LiDAR" : "Generate LiDAR"}</button><button type="button" onClick={() => session.bus.execute(assetStudioCommands.upsertProxy("collision", { id: `collision-box-${snapshot.collisionProxies.length + 1}`, kind: "box", enabled: true, transform: { position: [0, 0.5, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, size: [1, 1, 1] }))} className="rounded border border-zinc-700 px-2 py-1">Add collision box</button></div>{[...snapshot.lidarProxies, ...snapshot.collisionProxies].map((proxy) => { const channel = snapshot.lidarProxies.some((entry) => entry.id === proxy.id) ? "lidar" : "collision"; return <label key={`${channel}:${proxy.id}`} className="flex items-center gap-2"><input type="checkbox" checked={proxy.enabled} onChange={(event) => session.bus.execute(assetStudioCommands.setProxyEnabled(channel, proxy.id, event.target.checked))} />{proxy.id} · {channel}{staleProxyIds.includes(proxy.id) ? " · stale" : ""}</label>; })}</section>
        <div className="flex gap-2"><button type="button" disabled={!status?.dirty || status?.saving} onClick={() => void save().catch(() => {})} className="rounded bg-blue-600 px-3 py-1.5 disabled:opacity-40">Save revision</button><button type="button" disabled={!status?.canUndo} onClick={() => session.bus.undo()} className="rounded border border-zinc-700 px-3 py-1.5 disabled:opacity-40">Undo</button></div>
        {status?.error && <div role="alert" className="space-y-2 text-red-300"><p>{status.error.message ?? String(status.error)}</p>{status.error.code === "EDITOR_ASSET_REVISION_CONFLICT" && <div className="flex gap-2"><button type="button" onClick={() => void reloadLatest()} className="rounded border border-red-700 px-2 py-1">Reload latest</button><button type="button" onClick={() => void saveAs()} className="rounded border border-red-700 px-2 py-1">Save as new asset</button></div>}</div>}
    </div>;
}
