/** Write a sensor manifest pose onto a marker. A live gizmo drag owns that object. */
export function applySensorMarkerPose(object, sensor, dragging) {
    if (dragging) return;
    const position = sensor.pose.position;
    const rotation = sensor.pose.rotation;
    object.position.set(position.x, position.y, position.z);
    object.rotation.set(rotation.x, rotation.y, rotation.z);
    if (rotation.order) object.rotation.order = rotation.order;
}
