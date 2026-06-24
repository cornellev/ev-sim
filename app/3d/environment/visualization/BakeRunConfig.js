import * as THREE from "three";
import { SeededRNG } from "../../util/SeededRNG.js";

/**
 * @typedef {Object} BuildingRecord
 * @property {string} buildingId
 * @property {{ x: number, y: number, z: number }[]} footprint
 * @property {number} height
 * @property {number} textureId
 * @property {string[]} tags
 * @property {string} meshName
 */

/**
 * @typedef {Object} BakeRunManifest
 * @property {string} runId
 * @property {string} environmentId
 * @property {number} seed
 * @property {string} createdAt
 * @property {BuildingRecord[]} buildings
 * @property {Object} passPolicy
 * @property {Object} modelSettings
 */

const DEFAULT_SAMPLE_PATH = [
    {
        position: new THREE.Vector3(-25.120153743222073, 0.5, 1.1525929487085005),
        rotation: new THREE.Euler(0, Math.PI / 4, 0),
    },
    {
        position: new THREE.Vector3(-24.40545504348329, 0.5, 50.754401939102294),
        rotation: new THREE.Euler(0, Math.PI / 4, 0),
    },
];

/**
 * Central bake-run configuration and manifest for deterministic captures.
 */
export class BakeRunConfig {
    /**
     * @param {Object} [options]
     */
    constructor(options = {}) {
        this.runId = options.runId || `bake-${options.seed ?? 42}`;
        this.environmentId = options.environmentId || "igvc";
        this.seed = options.seed ?? 42;
        this.host = options.host ?? "http://localhost:8000";
        this.deltaDistance = options.deltaDistance ?? 2.0;
        this.maskMinPixels = options.maskMinPixels ?? 64;
        this.passPolicy = {
            beautyAlways: true,
            activeBuildingMask: true,
            contextMask: false,
            skipEmptyMasks: true,
            ...options.passPolicy,
        };
        this.modelSettings = {
            steps: 36,
            guidance: 14,
            ...options.modelSettings,
        };
        /** @type {BuildingRecord[]} */
        this.buildings = Array.isArray(options.buildings) ? options.buildings : [];
        this.views = options.views ?? BakeRunConfig.defaultViews();
        this.pathVertices = options.pathVertices ?? DEFAULT_SAMPLE_PATH;
        this.createdAt = options.createdAt || new Date().toISOString();
    }

    /**
     * @returns {SeededRNG}
     */
    rng() {
        return new SeededRNG(this.seed);
    }

    /**
     * @returns {Object[]}
     */
    static defaultViews() {
        return [
            {
                name: "bake/view/main",
                position: new THREE.Vector3(0, 1.6, 0),
                rotation: new THREE.Euler(0, 0, 0),
                excludeTags: ["sign", "vehicle"],
                camera: {
                    width: 1920,
                    height: 1080,
                    fov: 75,
                },
                passes: [
                    {
                        id: "beauty",
                        kind: "render",
                        excludeTags: ["sign", "vehicle"],
                    },
                ],
            },
        ];
    }

    /**
     * @param {BuildingRecord[]} records
     */
    setBuildings(records) {
        this.buildings = records.map((record) => ({ ...record }));
    }

    /**
     * @returns {BakeRunManifest}
     */
    toManifest() {
        return {
            runId: this.runId,
            environmentId: this.environmentId,
            seed: this.seed,
            createdAt: this.createdAt,
            buildings: this.buildings.map((building) => ({
                ...building,
                footprint: building.footprint.map((point) => ({ ...point })),
            })),
            passPolicy: { ...this.passPolicy },
            modelSettings: { ...this.modelSettings },
            deltaDistance: this.deltaDistance,
            maskMinPixels: this.maskMinPixels,
        };
    }
}

/**
 * @param {Object} [overrides]
 * @returns {BakeRunConfig}
 */
export function createDefaultBakeRunConfig(overrides = {}) {
    return new BakeRunConfig(overrides);
}
