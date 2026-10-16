import { floorGridPlanSignature, planVehicleFloorUnitGrid } from "./vehicleFloorUnitGridPlan.js";

const MINOR_COLOR = 0x27272a;
const MAJOR_COLOR = 0x3f3f46;
const X_AXIS_COLOR = 0x9a5a5a;
const Z_AXIS_COLOR = 0x5a719a;
const LABEL_COLOR = "#e4e4e7";
const LABEL_FONT_PX = 32;
const LABEL_GLYPH_PX = 14;

function createLine(THREE, color, opacity) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    const material = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        fog: false,
    });
    const line = new THREE.LineSegments(geometry, material);
    line.renderOrder = -1;
    line.frustumCulled = false;
    line.visible = false;
    line.raycast = () => {};
    return line;
}

function setPositions(THREE, line, positions) {
    const array = positions.length >= 6 ? new Float32Array(positions) : new Float32Array(6);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(array, 3));
    line.geometry.dispose();
    line.geometry = geometry;
    line.visible = positions.length >= 6;
}

function labelTexture(THREE, cache, text) {
    if (cache.has(text)) return cache.get(text);
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.font = `600 ${LABEL_FONT_PX}px system-ui, sans-serif`;
    const width = Math.max(8, Math.ceil(context.measureText(text).width + 8));
    const height = LABEL_FONT_PX + 8;
    canvas.width = width;
    canvas.height = height;
    context.font = `600 ${LABEL_FONT_PX}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = LABEL_COLOR;
    context.fillText(text, width / 2, height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const record = { texture, aspect: width / height, fontScale: height / LABEL_FONT_PX };
    cache.set(text, record);
    return record;
}

/** Scene-space XZ meter grid on the vehicle floor. Editor-only; the group stays at the world origin. */
export class VehicleFloorUnitGrid {
    constructor(THREE) {
        this.THREE = THREE;
        this.group = new THREE.Group();
        this.group.name = "vehicle-floor-units";
        this.minor = createLine(THREE, MINOR_COLOR, 0.55);
        this.major = createLine(THREE, MAJOR_COLOR, 0.55);
        this.xAxis = createLine(THREE, X_AXIS_COLOR, 0.8);
        this.zAxis = createLine(THREE, Z_AXIS_COLOR, 0.8);
        this.minor.name = "vehicle-floor-units-minor";
        this.major.name = "vehicle-floor-units-major";
        this.xAxis.name = "vehicle-floor-units-x";
        this.zAxis.name = "vehicle-floor-units-z";
        this.labels = new THREE.Group();
        this.labels.name = "vehicle-floor-unit-labels";
        this.group.add(this.minor, this.major, this.xAxis, this.zAxis, this.labels);
        this.textures = new Map();
        this.signature = null;
        this.last = { minorMeters: 1, label: "1 m" };
    }

    setVisible(visible) {
        this.group.visible = Boolean(visible);
    }

    clearLabelSprites() {
        for (const sprite of [...this.labels.children]) {
            this.labels.remove(sprite);
            sprite.material?.dispose?.();
        }
    }

    rebuildLabels(plan) {
        this.clearLabelSprites();
        if (typeof document === "undefined") return;
        const THREE = this.THREE;
        for (const label of plan.labels ?? []) {
            const record = labelTexture(THREE, this.textures, label.text);
            if (!record) continue;
            const material = new THREE.SpriteMaterial({
                map: record.texture,
                transparent: true,
                depthTest: false,
                depthWrite: false,
                fog: false,
            });
            const sprite = new THREE.Sprite(material);
            sprite.name = `vehicle-floor-unit-label:${label.text}`;
            sprite.renderOrder = 2;
            sprite.frustumCulled = false;
            sprite.raycast = () => {};
            sprite.userData.aspect = record.aspect;
            sprite.userData.fontScale = record.fontScale;
            this.labels.add(sprite);
        }
    }

    placeLabels(plan) {
        const metersPerPixel = plan.metersPerPixel > 0 ? plan.metersPerPixel : 0;
        const glyph = LABEL_GLYPH_PX * metersPerPixel;
        const labels = plan.labels ?? [];
        for (let index = 0; index < this.labels.children.length; index += 1) {
            const sprite = this.labels.children[index];
            const label = labels[index];
            if (!label) continue;
            sprite.position.set(label.position.x, label.position.y, label.position.z);
            const height = glyph * (sprite.userData.fontScale ?? 1);
            const width = height * (sprite.userData.aspect ?? 1);
            sprite.scale.set(width, height, 1);
        }
    }

    sync({ camera, target, viewportWidth, viewportHeight } = {}) {
        if (!this.group.visible) return this.last;
        const plan = planVehicleFloorUnitGrid({
            target: { x: target?.x ?? 0, y: target?.y ?? 0, z: target?.z ?? 0 },
            distance: camera.position.distanceTo(target),
            fovDegrees: camera.fov,
            viewportWidthPx: viewportWidth,
            viewportHeightPx: viewportHeight,
        });
        const signature = floorGridPlanSignature(plan);
        if (signature !== this.signature) {
            this.signature = signature;
            const THREE = this.THREE;
            setPositions(THREE, this.minor, plan.minor);
            setPositions(THREE, this.major, plan.major);
            setPositions(THREE, this.xAxis, plan.axes.x ?? []);
            setPositions(THREE, this.zAxis, plan.axes.z ?? []);
            this.rebuildLabels(plan);
        }
        this.placeLabels(plan);
        this.last = { minorMeters: plan.minorMeters, label: plan.label };
        return this.last;
    }

    dispose() {
        this.group.parent?.remove(this.group);
        for (const line of [this.minor, this.major, this.xAxis, this.zAxis]) {
            line.geometry?.dispose?.();
            line.material?.dispose?.();
        }
        this.clearLabelSprites();
        for (const record of this.textures.values()) record.texture?.dispose?.();
        this.textures.clear();
        this.signature = null;
    }
}
