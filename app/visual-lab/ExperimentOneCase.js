import { createWorldResource } from "../simulation/world/WorldDescription.js";
import {
    EXPERIMENT_ONE_FIXTURE_SOURCE,
    createExperimentOneMetricFixtures,
} from "./ExperimentOneScene.js";
import { EXPERIMENT_ONE_ASSET_MANIFEST } from "./ExperimentOneAssetManifest.js";

export const EXPERIMENT_ONE_CASE_ID = "experiment-1-room";
export const EXPERIMENT_ONE_FIXTURE_ID = "experiment-1-room@1";
export const EXPERIMENT_ONE_FPS = 24;
export const EXPERIMENT_ONE_DURATION_NS = 24_000_000_000;
export const EXPERIMENT_ONE_SAMPLE_COUNT = EXPERIMENT_ONE_FPS * 24 + 1;

export const EXPERIMENT_ONE_VIEWPOINTS = Object.freeze([
    view("room-north-west", "Room from north-west", [-2.55, 2.15, -2.05], [0, 1.05, 0]),
    view("room-south-east", "Room from south-east", [2.55, 2.05, 2.05], [0, 1, 0]),
    view("room-window", "Window and table", [2.45, 1.7, -2.1], [0.6, 1, 0.2]),
    view("room-door", "Door return", [-2.45, 1.75, 2.05], [-0.2, 1, 0.1]),
    view("table-edge", "Table edge and bevel", [1.65, 1.12, -1.25], [0.35, 0.78, -0.18]),
    view("chair-contact", "Chair contact points", [-1.85, 0.58, -1.12], [-1.12, 0.28, -0.15]),
    view("chair-underside", "Chair underside", [-0.72, 0.42, 0.78], [-1.12, 0.66, -0.15], true),
    view("cabinet-seams", "Cabinet seams", [1.82, 1.05, 0.72], [1.78, 0.68, 1.88]),
    view("fabric-folds", "Fabric folds", [-0.38, 1.08, -0.82], [0.28, 0.9, -0.15]),
    view("metal-response", "Metal response", [-1.35, 1.25, 0.82], [-2.12, 0.75, 1.58]),
    view("window-recess", "Window recess", [0.2, 1.78, 0.62], [1.2, 1.62, 2.4], true),
    view("clutter-scale", "Clutter and texture scale", [2.7, 1.35, 1], [1.72, 0.92, 1.88], true),
]);

function view(id, name, position, target, withheld = false) {
    return Object.freeze({
        id,
        name,
        generationInput: !withheld,
        withheld,
        pose: Object.freeze({ position: Object.freeze(position), target: Object.freeze(target) }),
    });
}

function interpolatePath(controlPoints) {
    const samples = [];
    const segmentCount = controlPoints.length - 1;
    for (let index = 0; index < EXPERIMENT_ONE_SAMPLE_COUNT; index += 1) {
        const progress = index / (EXPERIMENT_ONE_SAMPLE_COUNT - 1);
        const scaled = progress * segmentCount;
        const segment = Math.min(segmentCount - 1, Math.floor(scaled));
        const local = scaled - segment;
        const left = controlPoints[segment];
        const right = controlPoints[segment + 1];
        const mix = (offset) => left[offset] + (right[offset] - left[offset]) * local;
        samples.push(Object.freeze({
            sampleIndex: index,
            captureTimeNs: Math.round(index * 1_000_000_000 / EXPERIMENT_ONE_FPS),
            pose: Object.freeze({
                position: Object.freeze([mix(0), mix(1), mix(2)]),
                target: Object.freeze([
                    mix(0) + (right[0] - left[0]) * 0.22,
                    Math.max(0.45, mix(1) - 0.2),
                    mix(2) + (right[2] - left[2]) * 0.22,
                ]),
            }),
        }));
    }
    return Object.freeze(samples);
}

export const EXPERIMENT_ONE_PATHS = Object.freeze([
    path("normal-walkthrough", "Normal walk-through", "forward", false, [
        [-2.55, 1.62, -1.85], [-0.65, 1.62, -1.45], [1.85, 1.62, -0.65], [2.45, 1.62, 1.65], [0.1, 1.62, 2],
    ]),
    path("reverse-return", "Reverse traversal and return", "independent-reverse", false, [
        [0.1, 1.62, 2], [2.45, 1.62, 1.65], [1.85, 1.62, -0.65], [-0.65, 1.62, -1.45], [-2.55, 1.62, -1.85],
    ]),
    path("withheld-height-path", "Withheld close path", "forward", true, [
        [-2.15, 0.72, 0.95], [-0.9, 0.55, 0.55], [0.2, 1.08, 0.45], [1.5, 0.82, 1.45], [2.35, 1.9, 0.5],
    ]),
]);

function path(id, name, captureDirection, withheld, controlPoints) {
    return Object.freeze({
        id,
        name,
        durationNs: EXPERIMENT_ONE_DURATION_NS,
        nominalFps: EXPERIMENT_ONE_FPS,
        generationInput: !withheld,
        withheld,
        captureDirection,
        samples: interpolatePath(controlPoints),
    });
}

export function experimentOneEnvironmentManifest() {
    const staticMetricFixtures = createExperimentOneMetricFixtures({ detail: "detailed" });
    return {
        environmentId: "visual-lab-experiment-1-room",
        name: "Visual Lab Experiment 1 room",
        schemaVersion: 3,
        revision: 0,
        templateId: "blank",
        roadStylePreset: "default",
        roadsAuthored: true,
        buildingsAuthored: true,
        featuresAuthored: true,
        staticMetricFixturesAuthored: true,
        document: {
            environmentId: "visual-lab-experiment-1-room",
            chunkSize: 20,
            roads: { nodes: [], edges: [] },
            buildings: [],
            features: [],
            staticMetricFixtures,
            roadsAuthored: true,
            buildingsAuthored: true,
            featuresAuthored: true,
            staticMetricFixturesAuthored: true,
            earth: null,
        },
    };
}

export const EXPERIMENT_ONE_WORLD = Object.freeze(createWorldResource(experimentOneEnvironmentManifest()));

export function experimentOneCaseInput() {
    const objects = EXPERIMENT_ONE_FIXTURE_SOURCE.objects.map((raw) => {
        const source = raw.copyOf
            ? { ...EXPERIMENT_ONE_FIXTURE_SOURCE.objects.find((entry) => entry.id === raw.copyOf), ...raw }
            : raw;
        return {
            id: source.id,
            label: source.label,
            category: source.category,
            position: [...source.position],
            rotationRadians: [0, 0, 0],
            dimensionsMeters: [...source.dimensionsMeters],
            editable: source.editable,
            metricBinding: { status: "available", truthEntityId: source.id },
        };
    });
    return {
        kind: "cev-sim.visual-lab-case",
        version: 1,
        id: EXPERIMENT_ONE_CASE_ID,
        name: "Experiment 1 / Rendering bottleneck",
        description: "A fully bound room comparing geometry, physical materials, reference rendering, and the opt-in PBR renderer.",
        sourceEnvironment: {
            id: "visual-lab-experiment-1-room",
            revision: 0,
            worldHash: EXPERIMENT_ONE_WORLD.hash,
            visualOnly: false,
        },
        scene: {
            fixtureId: EXPERIMENT_ONE_FIXTURE_ID,
            dimensionsMeters: { width: 6, depth: 5, height: 2.8 },
            objects,
            assetReferences: [{
                id: "experiment-1-fixture-source",
                source: "repository-fixture",
                locator: "app/visual-lab/experiment-one-fixture.json",
                sha256: "b782b26e179d6c7a75841fa80272d05402e9147401525eebe7f5693b08f4e5fb",
                license: "Apache-2.0",
            }, ...EXPERIMENT_ONE_ASSET_MANIFEST.files.map((asset, index) => ({
                id: `experiment-1-derived-${String(index).padStart(2, "0")}`,
                source: "repository-owned-blender-build",
                locator: asset.path,
                sha256: asset.sha256,
                sizeBytes: asset.sizeBytes,
                blender: EXPERIMENT_ONE_ASSET_MANIFEST.blender,
                license: "Apache-2.0",
            }))],
            worldResource: EXPERIMENT_ONE_WORLD,
        },
        calibrations: [{
            id: "review-camera-1280x720",
            image: { width: 1280, height: 720 },
            intrinsics: { fx: 910, fy: 910, cx: 639.5, cy: 359.5 },
            near: 0.05,
            far: 50,
            distortion: { model: "none", coefficients: [] },
            projectionContract: "cev-sim.visual-camera-calibration@1",
        }],
        viewpoints: EXPERIMENT_ONE_VIEWPOINTS,
        paths: EXPERIMENT_ONE_PATHS,
        conditions: [
            {
                id: "ordinary-environment",
                name: "Ordinary environment lighting",
                rendererSupport: "measured-and-reference",
                recipe: { environment: "neutral-interior", exposure: 1, shadows: false, toneMapping: "none" },
            },
            {
                id: "directional-challenge",
                name: "Directional relighting challenge",
                rendererSupport: "measured-and-reference",
                recipe: { keyDirection: [-0.55, -1, -0.35], intensity: 2.2, shadows: true, toneMapping: "AgX" },
            },
        ],
        editVariants: [
            { id: "base", name: "Frozen base arrangement", transforms: [], lights: [] },
            { id: "chair-translated", name: "Chair translated", transforms: [{ objectId: "chair-a", position: [-0.8, 0, 0.2] }], lights: [] },
            { id: "chair-rotated", name: "Chair rotated", transforms: [{ objectId: "chair-a", rotationRadians: [0, 0.7, 0] }], lights: [] },
            { id: "light-moved", name: "Independent light moved", transforms: [], lights: [{ lightId: "room-key", position: [2.4, 2.5, -1.8] }] },
        ],
        comparisonVariables: [
            { id: "asset-detail", values: ["simple", "detailed"], affects: ["geometryHash", "materialHash"] },
            { id: "appearance-method", values: ["incumbent", "compatible", "physical-reference"], affects: ["materialHash", "rendererProfileHash", "rasterizationHash", "backgroundHash", "lightingHash", "colorPipelineHash"] },
            { id: "renderer-revision", values: ["pbr-mesh@1", "cycles@4.5.4", "pbr-mesh@2"], affects: ["rendererProfileHash", "rasterizationHash", "backgroundHash", "lightingHash", "colorPipelineHash"] },
            { id: "controlled-correction", values: ["none", "lighting", "shadows", "color", "combined"], affects: ["lightingHash", "colorPipelineHash"] },
        ],
        referenceBoard: [{
            id: "repository-owned-procedural-materials",
            label: "Repository-owned physically scaled procedural material set",
            url: "https://docs.blender.org/manual/en/4.5/render/shader_nodes/shader/principled.html",
            license: "Fixture source Apache-2.0; Blender documentation is reference material only",
            acquiredAt: "2026-09-09",
        }],
        measuredCapture: {
            status: "ready-complete-bindings",
            missingObjectIds: [],
            worldHash: EXPERIMENT_ONE_WORLD.hash,
            message: "Every visible fixture object resolves to explicit static metric primitives.",
        },
    };
}
