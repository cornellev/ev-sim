'use client';

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createReplayVehicleGeometry } from "./ReplayVehicleGeometry.js";
import { AutonomyOverlay } from "../3d/overlay/AutonomyOverlay.js";

function labelSprite(text) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(28,30,32,.94)";
    context.roundRect(4, 4, 248, 52, 4);
    context.fill();
    context.font = "600 22px system-ui, sans-serif";
    context.fillStyle = "#e9eaec";
    context.textAlign = "center";
    context.fillText(text, 128, 39);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
    sprite.scale.set(4, 1, 1);
    sprite.position.y = 2.2;
    return sprite;
}

export default function ReplayScene({
    dataset,
    timeUs,
    selectedEntity,
    onSelectEntity,
    exactSync = false,
    autonomyLayers = { oracle: true, candidate: true, ekf: true, lanes: true },
}) {
    const mountRef = useRef(null);
    const runtimeRef = useRef(null);

    useEffect(() => {
        const mount = mountRef.current;
        if (!mount) return undefined;
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x17181a);
        scene.fog = new THREE.FogExp2(0x17181a, 0.012);
        const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);
        camera.position.set(14, 9, 16);
        camera.layers.enable(31);
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.domElement.style.display = "block";
        renderer.domElement.style.width = "100%";
        renderer.domElement.style.height = "100%";
        mount.appendChild(renderer.domElement);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = 3;
        controls.maxDistance = 400;
        controls.minPolarAngle = 0.18;
        controls.maxPolarAngle = Math.PI / 2.03;
        controls.target.set(0, 0.6, 0);
        controls.update();
        const grid = new THREE.GridHelper(400, 200, 0x3b3e41, 0x242628);
        scene.add(grid);
        scene.add(new THREE.HemisphereLight(0xdde7ec, 0x17181a, 1.7));
        const sun = new THREE.DirectionalLight(0xffffff, 2.2);
        sun.position.set(12, 25, 8);
        scene.add(sun);
        const autonomyOverlay = new AutonomyOverlay();
        autonomyOverlay.attach(scene, camera);
        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();
        const meshes = new Map();
        const resize = () => {
            const { width, height } = mount.getBoundingClientRect();
            const nextWidth = Math.max(1, Math.round(width));
            const nextHeight = Math.max(1, Math.round(height));
            camera.aspect = nextWidth / nextHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(nextWidth, nextHeight, true);
        };
        const observer = new ResizeObserver(resize);
        observer.observe(mount);
        resize();
        let frame;
        const render = () => {
            controls.update();
            renderer.render(scene, camera);
            frame = requestAnimationFrame(render);
        };
        render();
        const click = (event) => {
            const rect = renderer.domElement.getBoundingClientRect();
            pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(pointer, camera);
            const hit = raycaster.intersectObjects([...meshes.values()], false)[0];
            if (hit?.object?.userData?.entityId) onSelectEntity?.(hit.object.userData.entityId);
        };
        renderer.domElement.addEventListener("click", click);
        runtimeRef.current = { scene, meshes, autonomyOverlay };
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            renderer.domElement.removeEventListener("click", click);
            controls.dispose();
            autonomyOverlay.dispose();
            for (const mesh of meshes.values()) {
                mesh.geometry.dispose();
                mesh.material.dispose();
                mesh.children.forEach((child) => child.material?.map?.dispose?.());
            }
            renderer.dispose();
            renderer.domElement.remove();
            runtimeRef.current = null;
        };
    }, [onSelectEntity]);

    useEffect(() => {
        const runtime = runtimeRef.current;
        if (!runtime || !dataset) return;
        const posePaths = dataset.descriptors
            .filter((item) => item.type === "pose3" && item.path.startsWith("vehicles."))
            .map((item) => item.path);
        const active = new Set();
        for (const path of posePaths) {
            const entityId = path.split(".")[1] || path;
            active.add(entityId);
            let mesh = runtime.meshes.get(entityId);
            if (!mesh) {
                mesh = new THREE.Mesh(
                    createReplayVehicleGeometry(),
                    new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.58, metalness: 0.18 }),
                );
                mesh.position.y = 0.45;
                mesh.userData.entityId = entityId;
                mesh.add(labelSprite(entityId));
                runtime.scene.add(mesh);
                runtime.meshes.set(entityId, mesh);
            }
            const pose = dataset.valueAt(path, timeUs, { interpolate: true });
            if (pose?.position) mesh.position.set(pose.position.x || 0, (pose.position.y || 0) + 0.45, pose.position.z || 0);
            if (pose?.rotation) mesh.rotation.set(pose.rotation.x || 0, pose.rotation.y || 0, pose.rotation.z || 0, pose.rotation.order || "XYZ");
            const selected = selectedEntity === entityId;
            mesh.material.color.setHex(selected ? 0xfbbf24 : 0x38bdf8);
            mesh.material.emissive.setHex(selected ? 0x332100 : 0x00131d);
        }
        for (const [entityId, mesh] of runtime.meshes) {
            if (active.has(entityId)) continue;
            runtime.scene.remove(mesh);
            runtime.meshes.delete(entityId);
            mesh.geometry.dispose();
            mesh.material.dispose();
        }

        const autonomy = dataset.autonomySnapshotAt?.(timeUs, { exactSync }) || {
            perception: {},
            localization: {},
            controls: null,
        };
        let vehiclePose = null;
        const egoPath = posePaths.find((path) => path === "vehicles.ego.pose") || posePaths[0] || null;
        if (egoPath) {
            const pose = dataset.valueAt(egoPath, timeUs, { interpolate: true });
            if (pose?.position) {
                vehiclePose = {
                    position: pose.position,
                    yaw: Number(pose.rotation?.y) || 0,
                };
            }
        }
        runtime.autonomyOverlay.updateFromSnapshot({ ...autonomy, vehiclePose }, autonomyLayers);
    }, [autonomyLayers, dataset, exactSync, selectedEntity, timeUs]);

    return <div ref={mountRef} className="absolute inset-0" aria-label="Read-only replay scene" />;
}
