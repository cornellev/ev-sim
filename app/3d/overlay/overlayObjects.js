import * as THREE from "three";
import { SCENARIO_DIAGNOSTIC_LAYER } from "../../scenarios/ScenarioDiagnostics.js";

const AUTONOMY_OVERLAY_LAYER = SCENARIO_DIAGNOSTIC_LAYER;
const BADGE_TEXTURE_CACHE = new Map();
const BADGE_TEXTURE_CACHE_LIMIT = 64;

export function disableRaycast(object) {
    object.raycast = () => {};
    object.userData.autonomyOverlay = true;
    object.layers.set(AUTONOMY_OVERLAY_LAYER);
    return object;
}

export function disposeObject(object) {
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
        material?.map?.dispose?.();
        material?.dispose?.();
    }
}

export function cachedStatusBadge(text, color, { cache = true } = {}) {
    const cacheKey = `${text}:${color}`;
    if (cache && BADGE_TEXTURE_CACHE.has(cacheKey)) {
        const material = BADGE_TEXTURE_CACHE.get(cacheKey).clone();
        material.map = material.map.clone();
        const sprite = disableRaycast(new THREE.Sprite(material));
        sprite.scale.set(3.4, 0.85, 1);
        sprite.position.y = 2.2;
        const anchor = disableRaycast(new THREE.Object3D());
        anchor.add(sprite);
        return anchor;
    }
    const anchor = disableRaycast(new THREE.Object3D());
    if (typeof document === "undefined") return anchor;
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) return anchor;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(8,12,18,.85)";
    context.fillRect(2, 2, canvas.width - 4, canvas.height - 4);
    context.strokeStyle = `#${color.toString(16).padStart(6, "0")}`;
    context.lineWidth = 3;
    context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
    context.fillStyle = "#f5f7fa";
    context.font = "600 22px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, canvas.width / 2, canvas.height / 2);
    const material = new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        transparent: true,
        depthTest: false,
        depthWrite: false,
    });
    if (cache) {
        BADGE_TEXTURE_CACHE.set(cacheKey, material);
        if (BADGE_TEXTURE_CACHE.size > BADGE_TEXTURE_CACHE_LIMIT) {
            const oldestKey = BADGE_TEXTURE_CACHE.keys().next().value;
            const oldest = BADGE_TEXTURE_CACHE.get(oldestKey);
            BADGE_TEXTURE_CACHE.delete(oldestKey);
            oldest.map.dispose();
            oldest.dispose();
        }
    }
    const spriteMaterial = cache ? material.clone() : material;
    if (cache) spriteMaterial.map = material.map.clone();
    const sprite = disableRaycast(new THREE.Sprite(spriteMaterial));
    sprite.scale.set(3.4, 0.85, 1);
    sprite.position.y = 2.2;
    anchor.add(sprite);
    return anchor;
}

