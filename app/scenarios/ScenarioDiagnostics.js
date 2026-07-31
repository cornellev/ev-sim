import * as THREE from "three";
import { getRoutePolyline } from "./route/index.js";

const COLORS = Object.freeze({
    zone: 0x50a7ff,
    zoneActive: 0xffb454,
    route: 0x63d7a4,
    ego: 0xffffff,
    actor: 0xaab4c3,
});
export const SCENARIO_DIAGNOSTIC_LAYER = 31;

function disableRaycast(object) {
    object.raycast = () => {};
    object.userData.scenarioDiagnostic = true;
    object.layers.set(SCENARIO_DIAGNOSTIC_LAYER);
    return object;
}

function disposeObject(object) {
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
        material?.map?.dispose?.();
        material?.dispose?.();
    }
}

function roleLabel(text, color) {
    const anchor = new THREE.Object3D();
    anchor.userData.label = text;
    if (typeof document === "undefined") return anchor;
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) return anchor;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(8, 12, 18, .82)";
    context.fillRect(2, 2, canvas.width - 4, canvas.height - 4);
    context.strokeStyle = `#${color.toString(16).padStart(6, "0")}`;
    context.lineWidth = 3;
    context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
    context.fillStyle = "#f5f7fa";
    context.font = "600 26px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, canvas.width / 2, canvas.height / 2);
    const material = new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        transparent: true,
        depthTest: false,
        depthWrite: false,
    });
    const sprite = disableRaycast(new THREE.Sprite(material));
    sprite.scale.set(3.2, 0.8, 1);
    anchor.add(sprite);
    return anchor;
}

/** Render-only scenario overlays. Nothing is registered with physics or sensors. */
export class ScenarioDiagnostics {
    constructor() {
        this.group = new THREE.Group();
        this.group.name = "scenario-diagnostics";
        this.group.layers.set(SCENARIO_DIAGNOSTIC_LAYER);
        this.group.visible = false;
        this.group.userData.nonColliding = true;
        this.enabled = false;
        this.scenario = null;
        this.zoneObjects = new Map();
    }

    attach(scene, operatorCamera = null) {
        if (!scene) return;
        operatorCamera?.layers?.enable?.(SCENARIO_DIAGNOSTIC_LAYER);
        if (this.group.parent === scene) return;
        this.group.removeFromParent();
        scene.add(this.group);
        // Sensor cameras retain the default layer 0. Only the operator camera
        // can see this render-only layer, keeping diagnostics out of captures.
    }

    setEnabled(enabled) {
        this.enabled = Boolean(enabled);
        this.group.visible = this.enabled;
        return this.enabled;
    }

    configure(scenario) {
        this.scenario = scenario ?? null;
        this.clear();
        if (!scenario) return;
        for (const zone of scenario.zones ?? []) this._addZone(zone);
        for (const route of scenario.routes ?? []) this._addRoute(route);
        for (const actor of scenario.actors ?? []) this._addRole(actor);
        this.group.visible = this.enabled;
    }

    _addZone(zone) {
        const box = new THREE.BoxGeometry(
            Math.max(0.001, Number(zone.size?.x || 0)),
            Math.max(0.001, Number(zone.size?.y || 0)),
            Math.max(0.001, Number(zone.size?.z || 0)),
        );
        const geometry = new THREE.EdgesGeometry(box);
        box.dispose();
        const material = new THREE.LineBasicMaterial({ color: COLORS.zone, transparent: true, opacity: 0.72, depthTest: false });
        const wire = disableRaycast(new THREE.LineSegments(geometry, material));
        wire.name = `scenario-zone:${zone.id}`;
        wire.position.set(Number(zone.center?.x || 0), Number(zone.center?.y || 0), Number(zone.center?.z || 0));
        wire.renderOrder = 1000;
        this.zoneObjects.set(zone.id, wire);
        this.group.add(wire);
    }

    _addRoute(route) {
        const points = getRoutePolyline(route).map((entry) => new THREE.Vector3(
            Number(entry.x || 0),
            Number(entry.y || 0) + 0.08,
            Number(entry.z || 0),
        ));
        if (points.length < 2) return;
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({ color: COLORS.route, transparent: true, opacity: 0.9, depthTest: false });
        const line = disableRaycast(new THREE.Line(geometry, material));
        line.name = `scenario-route:${route.id}`;
        line.renderOrder = 1000;
        this.group.add(line);
    }

    _addRole(actor) {
        const route = this.scenario?.routes?.find((entry) => entry.actorId === actor.id);
        const start = route?.waypoints?.[0]?.position ?? getRoutePolyline(route)[0];
        if (!start) return;
        const label = roleLabel(actor.name || actor.id, actor.id === "ego" ? COLORS.ego : COLORS.actor);
        label.name = `scenario-role:${actor.id}`;
        label.position.set(Number(start.x || 0), Number(start.y || 0) + 1.8, Number(start.z || 0));
        this.group.add(label);
    }

    update(snapshot = {}) {
        if (!this.scenario) return;
        const latestId = snapshot.latestTrigger?.id;
        const activeZone = this.scenario.triggers?.find((entry) => entry.id === latestId)?.condition?.zoneId ?? null;
        for (const [zoneId, object] of this.zoneObjects) {
            object.material.color.setHex(zoneId === activeZone ? COLORS.zoneActive : COLORS.zone);
            object.material.opacity = zoneId === activeZone ? 1 : 0.72;
        }
    }

    clear() {
        this.zoneObjects.clear();
        for (const child of [...this.group.children]) {
            child.traverse(disposeObject);
            child.removeFromParent();
        }
    }

    dispose() {
        this.clear();
        this.group.removeFromParent();
    }
}
