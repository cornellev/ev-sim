export const PAN_DRAG_THRESHOLD = 4;

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

    if (interaction.mode === "pending-pan" && Math.hypot(dx, dy) < PAN_DRAG_THRESHOLD) {
        return interaction;
    }

    onPan(dx, dy);
    return {
        x: clientX,
        y: clientY,
        mode: "pan",
    };
}
