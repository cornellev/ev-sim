import * as THREE from "three";

function toneMapping(value) {
    return value === "AgX" ? THREE.AgXToneMapping : THREE.NoToneMapping;
}

function configureShadow(light, shadows) {
    light.castShadow = shadows.enabled && light.castShadow;
    if (!light.castShadow) return;
    light.shadow.mapSize.set(shadows.mapSize, shadows.mapSize);
    light.shadow.bias = shadows.bias;
    light.shadow.normalBias = shadows.normalBias;
    light.shadow.camera.near = 0.1;
    light.shadow.camera.far = 40;
    if (light.isDirectionalLight) {
        light.shadow.camera.left = -10;
        light.shadow.camera.right = 10;
        light.shadow.camera.top = 10;
        light.shadow.camera.bottom = -10;
    }
}

/** Apply the immutable recipe's beauty-only scene state and return capture policy plus disposal. */
export function applyPbrRenderRecipeToScene(scene, recipe) {
    const owned = [];
    const add = (object) => {
        scene.add(object);
        owned.push(object);
        return object;
    };
    const ambient = recipe.lighting.ambient;
    add(new THREE.AmbientLight(new THREE.Color(...ambient.colorRgb), ambient.intensity));
    for (const definition of recipe.lighting.directional ?? []) {
        const direction = new THREE.Vector3(...definition.direction).normalize();
        const light = new THREE.DirectionalLight(new THREE.Color(...definition.colorRgb), definition.intensity);
        light.name = `cev-sim.recipe-light:${definition.id}`;
        light.position.copy(direction).multiplyScalar(-10);
        light.castShadow = definition.castShadow;
        const target = new THREE.Object3D();
        target.name = `cev-sim.recipe-light-target:${definition.id}`;
        add(target);
        light.target = target;
        configureShadow(light, recipe.shadows);
        add(light);
    }
    for (const definition of recipe.lighting.point ?? []) {
        const light = new THREE.PointLight(
            new THREE.Color(...definition.colorRgb),
            definition.intensity,
            definition.range,
            definition.decay,
        );
        light.name = `cev-sim.recipe-light:${definition.id}`;
        light.position.fromArray(definition.position);
        light.castShadow = definition.castShadow;
        configureShadow(light, recipe.shadows);
        add(light);
    }
    return {
        renderPolicy: Object.freeze({
            recipeVersion: recipe.version,
            exposure: recipe.colorPipeline.exposure,
            outputColorSpace: recipe.colorPipeline.outputColorSpace,
            toneMapping: recipe.colorPipeline.toneMapping,
            threeToneMapping: toneMapping(recipe.colorPipeline.toneMapping),
            shadows: Object.freeze({ ...recipe.shadows }),
            backgroundColorRgba: Object.freeze([...recipe.background.colorRgba]),
        }),
        dispose() {
            for (const object of owned) {
                object.shadow?.map?.dispose?.();
                scene.remove(object);
            }
            owned.length = 0;
        },
    };
}

export function applyPbrBeautyRendererPolicy(renderer, policy) {
    renderer.toneMapping = policy.threeToneMapping ?? toneMapping(policy.toneMapping);
    renderer.toneMappingExposure = Number(policy.exposure ?? 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    if (renderer.shadowMap) {
        renderer.shadowMap.enabled = policy.shadows?.enabled === true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
}
