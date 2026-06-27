import * as THREE from "three";

export function isOverlayEvent(event) {
    return event.target instanceof Element && Boolean(event.target.closest("#overlay"));
}

export function getCanvasPointer(clientX, clientY, renderer) {
    if (!renderer?.domElement) return null;

    const rect = renderer.domElement.getBoundingClientRect();
    const inCanvas =
        clientX >= rect.left
        && clientX <= rect.right
        && clientY >= rect.top
        && clientY <= rect.bottom;

    if (!inCanvas) return null;

    return new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
    );
}

export function getGroundPointFromEvent(event, camera, renderer) {
    const pointer = getCanvasPointer(event.clientX, event.clientY, renderer);
    if (!pointer || !camera) return null;

    const raycaster = new THREE.Raycaster();
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const point = new THREE.Vector3();

    raycaster.setFromCamera(pointer, camera);
    return raycaster.ray.intersectPlane(ground, point) ? point : null;
}
