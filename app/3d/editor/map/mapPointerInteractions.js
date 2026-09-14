export const PAN_DRAG_THRESHOLD = 4;

/**
 * @param {{ x: number, y: number }} from
 * @param {number} clientX
 * @param {number} clientY
 * @param {number} [threshold]
 */
export function exceedsPointerDragThreshold(from, clientX, clientY, threshold = PAN_DRAG_THRESHOLD) {
    return Math.hypot(clientX - from.x, clientY - from.y) >= threshold;
}

/**
 * Advance pan / pending-pan drag state. Returns the next interaction, or null when inactive.
 * @param {{ mode: "pan" | "pending-pan", x: number, y: number } | null} interaction
 * @param {number} clientX
 * @param {number} clientY
 * @param {(dx: number, dy: number) => void} onPan
 */
export function advancePanDrag(interaction, clientX, clientY, onPan) {
    if (!interaction || (interaction.mode !== "pan" && interaction.mode !== "pending-pan")) {
        return interaction;
    }

    const dx = clientX - interaction.x;
    const dy = clientY - interaction.y;

    if (interaction.mode === "pending-pan" && !exceedsPointerDragThreshold(interaction, clientX, clientY)) {
        return interaction;
    }

    onPan(dx, dy);
    return {
        x: clientX,
        y: clientY,
        mode: "pan",
    };
}

/**
 * Promote a pending object drag once the pointer moves past the click threshold.
 * `begin` runs once; its return value becomes the active interaction.
 * @param {{ mode: "pending-object", x: number, y: number, begin: function } | null} interaction
 * @param {number} clientX
 * @param {number} clientY
 * @param {(interaction: object) => object | null} begin
 */
export function advancePendingObjectDrag(interaction, clientX, clientY, begin) {
    if (!interaction || interaction.mode !== "pending-object") return interaction;
    if (!exceedsPointerDragThreshold(interaction, clientX, clientY)) return interaction;
    return begin(interaction) ?? interaction;
}
