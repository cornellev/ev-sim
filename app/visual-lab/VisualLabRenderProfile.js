import * as THREE from "three";

import {
    applyProjectionToThreeCamera,
    createVisualCameraCalibration,
} from "../3d/environment/visual/VisualCapturePipeline.js";

/** The immutable renderer profile used to create the Experiment 0 media. */
export const VISUAL_LAB_LEGACY_PROFILE = Object.freeze({
    id: "cev-sim.visual-lab-fixture@1",
    background: 0x171a1e,
    colorSpace: "srgb",
    toneMapping: "none",
    exposure: 1,
    shadows: false,
    lights: Object.freeze([
        Object.freeze({ type: "hemisphere", skyColor: 0xe8eef5, groundColor: 0x2a241f, intensity: 1.55 }),
        Object.freeze({ type: "directional", color: 0xfff3df, intensity: 1.45, position: Object.freeze([-3.2, 5.4, -2.6]) }),
        Object.freeze({ type: "directional", color: 0xc8d8ed, intensity: 0.38, position: Object.freeze([4, 3, 3]) }),
    ]),
});

export function visualLabCalibration(value) {
    return createVisualCameraCalibration({
        width: value.image.width,
        height: value.image.height,
        intrinsics: value.intrinsics,
        near: value.near,
        far: value.far,
        distortionSpec: value.distortion,
    });
}

export function configureVisualLabRenderer(renderer, profile = VISUAL_LAB_LEGACY_PROFILE) {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = profile.exposure;
    if (renderer.shadowMap) {
        renderer.shadowMap.enabled = profile.shadows;
        renderer.shadowMap.autoUpdate = true;
    }
}

export function addVisualLabLights(scene, profile = VISUAL_LAB_LEGACY_PROFILE) {
    const lights = profile.lights.map((entry) => {
        if (entry.type === "hemisphere") {
            return new THREE.HemisphereLight(entry.skyColor, entry.groundColor, entry.intensity);
        }
        const light = new THREE.DirectionalLight(entry.color, entry.intensity);
        light.position.set(...entry.position);
        return light;
    });
    lights.forEach((light) => scene.add(light));
    return lights;
}

export function applyVisualLabCamera(camera, calibration, pose) {
    applyProjectionToThreeCamera(camera, visualLabCalibration(calibration));
    camera.position.set(...pose.position);
    camera.lookAt(...pose.target);
    camera.updateMatrixWorld(true);
}

export function visualLabRendererMetadata(profile = VISUAL_LAB_LEGACY_PROFILE) {
    return {
        renderer: "three-webgl",
        version: "0.182.0",
        profileId: profile.id,
        colorSpace: profile.colorSpace,
        toneMapping: profile.toneMapping,
        exposure: profile.exposure,
        shadows: profile.shadows,
        lights: profile.lights.map((entry) => ({ ...entry })),
    };
}
