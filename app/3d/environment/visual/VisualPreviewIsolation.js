export const VISUAL_PREVIEW_USERDATA = Object.freeze({
    previewOnly: "cevSimVisualPreviewOnly",
    layerHash: "cevSimVisualLayerHash",
    instanceId: "cevSimVisualInstanceId",
    bindingId: "cevSimVisualBindingId",
});

export function isVisualPreviewObject(object) {
    let current = object;
    while (current) {
        if (current.userData?.[VISUAL_PREVIEW_USERDATA.previewOnly] === true) return true;
        current = current.parent;
    }
    return false;
}

export function visualPreviewUserData({ layerHash, instanceId, bindingId = null } = {}) {
    const userData = {
        [VISUAL_PREVIEW_USERDATA.previewOnly]: true,
        skipEnvironmentSelection: true,
        [VISUAL_PREVIEW_USERDATA.layerHash]: layerHash,
        [VISUAL_PREVIEW_USERDATA.instanceId]: instanceId,
    };
    if (bindingId) userData[VISUAL_PREVIEW_USERDATA.bindingId] = bindingId;
    return userData;
}

export function sanitizePreviewObject(object, metadata) {
    const userData = visualPreviewUserData(metadata);
    object.userData = { ...userData };
    object.traverse?.((child) => {
        child.userData = { ...userData };
    });
    return object;
}
