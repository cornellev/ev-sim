import { storageGet, storagePost, storagePut } from "../client/storageClient.js";
import { VisualAssetClient } from "../3d/environment/visual/VisualAssetClient.js";

const assetClient = new VisualAssetClient();

export const VisualLabClient = Object.freeze({
    listCases: () => storageGet("visual-lab/cases"),
    getCase: (caseId) => storageGet(`visual-lab/cases/${encodeURIComponent(caseId)}`),
    registerCase: (caseDocument) => storagePost("visual-lab/cases", { case: caseDocument }),
    listCandidates: (caseId) => storageGet(`visual-lab/candidates?caseId=${encodeURIComponent(caseId)}`),
    registerCandidate: (candidate) => storagePost("visual-lab/candidates", { candidate }),
    listReviews: (caseId) => storageGet(`visual-lab/reviews?caseId=${encodeURIComponent(caseId)}`),
    getReview: (reviewId) => storageGet(`visual-lab/reviews/${encodeURIComponent(reviewId)}`),
    createReview: (review) => storagePost("visual-lab/reviews", { review }),
    saveReview: (review) => storagePut(`visual-lab/reviews/${encodeURIComponent(review.id)}`, {
        review,
        expectedRevision: review.revision,
    }),
    exportReview: (reviewId) => storageGet(`visual-lab/reviews/${encodeURIComponent(reviewId)}/export`),
    reportUrl: (reviewId) => `/api/storage/visual-lab/reviews/${encodeURIComponent(reviewId)}/report`,
    async mediaUrl(media) {
        if (media.url) return { url: media.url, revoke: () => {} };
        const response = await assetClient.getUseContent(media.useHash);
        const blob = new Blob([response.bytes], { type: response.mediaType || "image/png" });
        const url = URL.createObjectURL(blob);
        return { url, revoke: () => URL.revokeObjectURL(url) };
    },
});
