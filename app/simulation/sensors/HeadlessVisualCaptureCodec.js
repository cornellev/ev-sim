let codecPromise = null;

/** Lazy visual adapter keeps the shared sensor graph free of browser renderer imports. */
export function loadHeadlessVisualCaptureCodec() {
    codecPromise ??= Promise.all([
        import("../../3d/environment/visual/VisualCapturePipeline.js"),
        import("../../3d/perception/CameraRenderProducts.js"),
    ]).then(([pipeline, products]) => Object.freeze({
        createOwnedCaptureScene: pipeline.createOwnedCaptureScene,
        createVisualCameraCalibration: pipeline.createVisualCameraCalibration,
        createVisualCaptureInput: pipeline.createVisualCaptureInput,
        snapshotRep103CameraPose: pipeline.snapshotRep103CameraPose,
        flipRows: products.flipRows,
        warpBrownConrady: products.warpBrownConrady,
    }));
    return codecPromise;
}
