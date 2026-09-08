export async function settleRequiredBakeUploads(uploadPromises) {
    const results = await Promise.all(uploadPromises);
    return results.every((result) => result === true);
}

export function assertPromotionPreviewReload(preview, receipt) {
    if (preview?.status !== "error") return preview;
    throw Object.assign(new Error(
        preview.error?.message || "Bake promotion committed, but preview reload failed.",
    ), {
        code: "BAKE_PREVIEW_RELOAD_FAILED",
        receipt,
        preview,
    });
}

export function adoptCommittedPromotion(outcome, persistence) {
    if (!outcome?.committed || !outcome.receipt) return null;
    persistence?.adoptPromotedVisualLayer(outcome.receipt);
    return outcome.receipt;
}
