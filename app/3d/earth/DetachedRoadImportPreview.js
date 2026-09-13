import * as THREE from "three";

import { materializeCompiledRoadNetwork, disposeRoadRuntimeObject } from "../city/RoadNetwork.js";
import { EnvironmentRegistry } from "../editor/EnvironmentRegistry.js";
import { SceneProjector } from "../editor/projection/SceneProjector.js";
import { roadNetworkOptions } from "../editor/projection/roadRuntimeEntities.js";
import { planRoadNetworkGeometry } from "../../roads/RoadNetworkGeometry.js";

function tagPreviewTree(root) {
    root?.traverse?.((object) => {
        object.userData.earthImportLayer = true;
        object.userData.earthImportPreview = true;
        object.userData.bakeIgnore = true;
        object.userData.skipEnvironmentSelection = true;
    });
}

/**
 * Project a staged import document into an isolated scene group. The active
 * EnvironmentDocument, registry, city, collision set, and LiDAR truth remain
 * untouched while the user reviews the command result.
 */
export function createDetachedRoadImportPreview({ data, scene, document } = {}) {
    if (!scene?.add) throw new TypeError("A scene is required for an Earth import preview.");
    const group = new THREE.Group();
    group.name = "EarthRoadImportPreview";
    tagPreviewTree(group);
    scene.add(group);

    const registry = new EnvironmentRegistry();
    let materialized = { roads: [], intersections: [], roadByEdge: new Map() };

    const clear = () => {
        for (const value of [...materialized.roads, ...materialized.intersections]) {
            value.root?.parent?.remove?.(value.root);
            disposeRoadRuntimeObject(value);
        }
        for (const entity of registry.listEntities()) registry.unregisterEntity(entity.id, { affectsPersistence: false });
        materialized = { roads: [], intersections: [], roadByEdge: new Map() };
    };

    const roadProjector = {
        id: "detached-road-import-preview",
        apply({ changeSet }) {
            const edgeChanges = changeSet.domains?.["roads.edges"];
            const versionChanged = Boolean(changeSet.scalars?.roadGeometryVersion);
            if (!edgeChanges && !versionChanged) return;
            clear();

            const edgeIds = edgeChanges
                ? [...edgeChanges.after.entries()].filter(([, record]) => record).map(([id]) => String(id))
                : document.roads.edges.map((edge) => String(edge.id));
            if (edgeIds.length === 0) return;
            const selected = new Set(edgeIds);
            const nodeIds = new Set();
            for (const edge of document.roads.edges) {
                if (!selected.has(String(edge.id))) continue;
                nodeIds.add(String(edge.startNodeId));
                nodeIds.add(String(edge.endNodeId));
            }
            const options = roadNetworkOptions(data);
            materialized = materializeCompiledRoadNetwork(group, planRoadNetworkGeometry(document.roads), {
                edgeIds,
                nodeIds,
                roadOptions: options.roadOptions,
            });
            for (const road of materialized.roads) {
                tagPreviewTree(road.root);
                const sourceId = String(road.network?.edgeId ?? road.root.uuid);
                registry.registerEntity({
                    id: `preview:road:${sourceId}`,
                    sourceId,
                    kind: "road",
                    label: `Imported road ${sourceId}`,
                    object3D: road.root,
                    road,
                    editorOnly: true,
                }, { affectsPersistence: false });
            }
            for (const intersection of materialized.intersections) {
                tagPreviewTree(intersection.root);
                const sourceId = String(intersection.networkNodeId ?? intersection.root.uuid);
                registry.registerEntity({
                    id: `preview:intersection:${sourceId}`,
                    sourceId,
                    kind: "intersection",
                    label: `Imported intersection ${sourceId}`,
                    object3D: intersection.root,
                    intersection,
                    editorOnly: true,
                }, { affectsPersistence: false });
            }
        },
    };

    const projector = new SceneProjector({
        data,
        scene: group,
        document,
        registry,
        projectors: [roadProjector],
    }).attach();

    return {
        group,
        registry,
        projector,
        dispose() {
            projector.dispose();
            clear();
            group.parent?.remove?.(group);
        },
    };
}
