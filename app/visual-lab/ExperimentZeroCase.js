export const EXPERIMENT_ZERO_CASE_ID = "experiment-0-room";

export const EXPERIMENT_ZERO_ROOM = Object.freeze({
    dimensionsMeters: Object.freeze({ width: 6, depth: 5, height: 2.8 }),
    objects: Object.freeze([
        fixtureObject("room-shell", "Room shell", "architecture", [0, 0, 0], [6, 5, 2.8], false, true),
        fixtureObject("table", "Oak table", "furniture", [0.25, 0, -0.2], [1.8, 0.82, 0.9], true, true),
        fixtureObject("chair-a", "Chair A", "furniture", [-1.15, 0, -0.15], [0.55, 0.92, 0.58], true, true),
        fixtureObject("chair-b", "Chair B", "furniture", [1.55, 0, -0.2], [0.55, 0.92, 0.58], true, true),
        fixtureObject("cabinet", "Low cabinet", "furniture", [1.75, 0, 1.9], [1.65, 0.92, 0.45], true, true),
        fixtureObject("fabric", "Folded fabric", "soft-goods", [0.3, 0.84, -0.15], [0.72, 0.12, 0.52], true, false),
        fixtureObject("metal-lamp", "Metal task lamp", "metal", [-2.15, 0, 1.6], [0.42, 1.45, 0.42], true, false),
        fixtureObject("clutter-books", "Book stack", "clutter", [1.75, 0.94, 1.88], [0.48, 0.16, 0.3], true, false),
        fixtureObject("clutter-box", "Storage box", "clutter", [-2.1, 0, -1.85], [0.62, 0.42, 0.5], true, true),
    ]),
});

function fixtureObject(id, label, category, position, dimensions, editable, metricBound) {
    return Object.freeze({
        id,
        label,
        category,
        position: Object.freeze([...position]),
        rotationRadians: Object.freeze([0, 0, 0]),
        dimensionsMeters: Object.freeze([...dimensions]),
        editable,
        metricBinding: metricBound ? Object.freeze({ status: "available", truthEntityId: id }) : Object.freeze({
            status: "missing",
            reason: "No corresponding metric fixture geometry is registered.",
        }),
    });
}

export const EXPERIMENT_ZERO_VIEWPOINTS = Object.freeze([
    view("room-north-west", "Room from north-west", [-2.55, 2.15, -2.05], [0, 1.05, 0]),
    view("room-south-east", "Room from south-east", [2.55, 2.05, 2.05], [0, 1.0, 0]),
    view("room-window", "Window and table", [2.45, 1.7, -2.1], [0.6, 1.0, 0.2]),
    view("room-door", "Door return", [-2.45, 1.75, 2.05], [-0.2, 1.0, 0.1]),
    view("table-edge", "Table edge and bevel", [1.65, 1.12, -1.25], [0.35, 0.78, -0.18]),
    view("chair-contact", "Chair contact points", [-1.85, 0.58, -1.12], [-1.12, 0.28, -0.15]),
    view("chair-underside", "Chair underside", [-0.72, 0.42, 0.78], [-1.12, 0.66, -0.15]),
    view("cabinet-seams", "Cabinet seams", [1.82, 1.05, 0.72], [1.78, 0.68, 1.88]),
    view("fabric-folds", "Fabric folds", [-0.38, 1.08, -0.82], [0.28, 0.9, -0.15]),
    view("metal-response", "Metal response", [-1.35, 1.25, 0.82], [-2.12, 0.75, 1.58]),
    view("window-recess", "Window recess", [0.2, 1.78, -0.62], [1.25, 1.62, -2.48]),
    view("clutter-scale", "Clutter and texture scale", [2.7, 1.35, 1.0], [1.72, 0.92, 1.88]),
]);

function view(id, name, position, target) {
    return Object.freeze({
        id,
        name,
        generationInput: !["chair-underside", "window-recess", "clutter-scale"].includes(id),
        withheld: ["chair-underside", "window-recess", "clutter-scale"].includes(id),
        pose: Object.freeze({ position: Object.freeze(position), target: Object.freeze(target) }),
    });
}

const SECOND_NS = 1_000_000_000;

function interpolatePath(controlPoints, sampleCount = 25) {
    const samples = [];
    const segmentCount = controlPoints.length - 1;
    for (let index = 0; index < sampleCount; index += 1) {
        const progress = index / (sampleCount - 1);
        const scaled = progress * segmentCount;
        const segment = Math.min(segmentCount - 1, Math.floor(scaled));
        const local = scaled - segment;
        const left = controlPoints[segment];
        const right = controlPoints[segment + 1];
        const mix = (offset) => left[offset] + ((right[offset] - left[offset]) * local);
        const target = [
            mix(0) + ((right[0] - left[0]) * 0.22),
            Math.max(0.45, mix(1) - 0.2),
            mix(2) + ((right[2] - left[2]) * 0.22),
        ];
        samples.push(Object.freeze({
            sampleIndex: index,
            captureTimeNs: index * SECOND_NS,
            pose: Object.freeze({
                position: Object.freeze([mix(0), mix(1), mix(2)]),
                target: Object.freeze(target),
            }),
        }));
    }
    return Object.freeze(samples);
}

export const EXPERIMENT_ZERO_PATHS = Object.freeze([
    Object.freeze({
        id: "normal-walkthrough",
        name: "Normal walk-through",
        durationNs: 24 * SECOND_NS,
        nominalFps: 1,
        generationInput: true,
        withheld: false,
        captureDirection: "forward",
        samples: interpolatePath([
            [-2.55, 1.62, -1.85], [-0.65, 1.62, -1.45], [1.85, 1.62, -0.65], [2.45, 1.62, 1.65], [0.1, 1.62, 2.0],
        ]),
    }),
    Object.freeze({
        id: "reverse-return",
        name: "Reverse traversal and return",
        durationNs: 24 * SECOND_NS,
        nominalFps: 1,
        generationInput: true,
        withheld: false,
        captureDirection: "independent-reverse",
        samples: interpolatePath([
            [0.1, 1.62, 2.0], [2.45, 1.62, 1.65], [1.85, 1.62, -0.65], [-0.65, 1.62, -1.45], [-2.55, 1.62, -1.85],
        ]),
    }),
    Object.freeze({
        id: "withheld-height-path",
        name: "Withheld close path",
        durationNs: 24 * SECOND_NS,
        nominalFps: 1,
        generationInput: false,
        withheld: true,
        captureDirection: "forward",
        samples: interpolatePath([
            [-2.3, 0.72, 0.85], [-1.25, 0.62, 0.2], [0.2, 0.82, -0.55], [1.35, 1.05, 0.1], [2.25, 0.76, 1.55],
        ]),
    }),
]);

export function experimentZeroCaseInput() {
    return {
        kind: "cev-sim.visual-lab-case",
        version: 1,
        id: EXPERIMENT_ZERO_CASE_ID,
        name: "Experiment 0 / Shared room",
        description: "A frozen localized room for comparing source imagery with retained scene appearance.",
        sourceEnvironment: {
            id: "visual-lab-room",
            revision: 0,
            worldHash: null,
            visualOnly: true,
        },
        scene: {
            fixtureId: "experiment-0-room@1",
            dimensionsMeters: { ...EXPERIMENT_ZERO_ROOM.dimensionsMeters },
            objects: EXPERIMENT_ZERO_ROOM.objects.map((object) => ({
                ...object,
                position: [...object.position],
                rotationRadians: [...object.rotationRadians],
                dimensionsMeters: [...object.dimensionsMeters],
                metricBinding: { ...object.metricBinding },
            })),
            assetReferences: [
                {
                    id: "experiment-0-procedural-room",
                    source: "repository-fixture",
                    locator: "app/visual-lab/ExperimentZeroScene.js",
                    sha256: "6da7d334df3b9a74c4ba24dcfc2a31d4581508095ad4f042a16e6807c9a69089",
                    license: "Apache-2.0",
                },
                {
                    id: "experiment-0-capture-manifest",
                    source: "repository-fixture",
                    locator: "public/visual-lab/experiment-0/manifest.json",
                    sha256: "266c84802a7108f4eab8e7d7dce13410478689842f9cfb4356c151d02a2457d8",
                    license: "Apache-2.0",
                },
            ],
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
        viewpoints: EXPERIMENT_ZERO_VIEWPOINTS.map((entry) => structuredClone(entry)),
        paths: EXPERIMENT_ZERO_PATHS.map((entry) => structuredClone(entry)),
        conditions: [
            {
                id: "ordinary-environment",
                name: "Ordinary environment lighting",
                rendererSupport: "measured-and-reference",
                recipe: { environment: "neutral-studio", exposure: 1, shadows: false, toneMapping: "none" },
            },
            {
                id: "directional-reference",
                name: "Directional reference lighting",
                rendererSupport: "reference-only",
                recipe: { keyDirection: [-0.55, -1, -0.35], intensity: 2.2, shadows: true, toneMapping: "AgX" },
            },
        ],
        editVariants: [
            { id: "base", name: "Frozen base arrangement", transforms: [] },
            { id: "chair-translated", name: "Chair translated", transforms: [{ objectId: "chair-a", position: [-0.8, 0, 0.2] }] },
            { id: "chair-rotated", name: "Chair rotated", transforms: [{ objectId: "chair-a", rotationRadians: [0, 0.7, 0] }] },
            { id: "light-moved", name: "Light moved", transforms: [{ objectId: "metal-lamp", position: [-1.5, 0, 1.2] }] },
        ],
        comparisonVariables: [
            { id: "asset-detail", values: ["simple", "detailed"] },
            { id: "appearance-method", values: ["incumbent", "physical-reference", "generated"] },
        ],
        referenceBoard: [
            {
                id: "poly-haven-wood-table",
                label: "Poly Haven Wood Table material, 1 m reference width",
                url: "https://polyhaven.com/a/wood_table",
                license: "CC0 asset; website and API terms are separate",
                acquiredAt: "2026-09-09",
            },
            {
                id: "poly-haven-bi-stretch",
                label: "Poly Haven Bi Stretch fabric, 0.3 m reference width",
                url: "https://polyhaven.com/a/bi_stretch",
                license: "CC0 asset; website and API terms are separate",
                acquiredAt: "2026-09-09",
            },
            {
                id: "poly-haven-metal-plate-02",
                label: "Poly Haven Metal Plate 02, 2 m reference width",
                url: "https://polyhaven.com/a/metal_plate_02",
                license: "CC0 assets; website and API terms are separate",
                acquiredAt: "2026-09-09",
            },
            {
                id: "openrv-review-controls",
                label: "OpenRV comparison and sequence review",
                url: "https://openrv.readthedocs.io/en/latest/rv-manuals/rv-user-manual/rv-user-manual-chapter-four.html",
                license: "Reference documentation only",
                acquiredAt: "2026-09-09",
            },
        ],
        measuredCapture: {
            status: "blocked-partial-bindings",
            missingObjectIds: EXPERIMENT_ZERO_ROOM.objects
                .filter((entry) => entry.metricBinding.status !== "available")
                .map((entry) => entry.id),
            message: "Measured-camera capture is unavailable until every visible room object has valid metric correspondence.",
        },
    };
}
