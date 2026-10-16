/**
 * Open rows in the vehicle-editor sensor list.
 * Selecting a sensor reveals that row once. Collapsing it stays collapsed
 * until the selection changes.
 */

export function revealSelectedSensor(openSensorIds, selectedSensorId, revealedSensorId) {
    if (selectedSensorId === revealedSensorId) return { openSensorIds, revealedSensorId };
    if (!selectedSensorId || openSensorIds.includes(selectedSensorId)) {
        return { openSensorIds, revealedSensorId: selectedSensorId };
    }
    return {
        openSensorIds: [...openSensorIds, selectedSensorId],
        revealedSensorId: selectedSensorId,
    };
}

export function setSensorDisclosureOpen(openSensorIds, sensorId, open) {
    const without = openSensorIds.filter((id) => id !== sensorId);
    return open ? [...without, sensorId] : without;
}
