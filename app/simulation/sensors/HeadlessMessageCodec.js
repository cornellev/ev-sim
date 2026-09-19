let codecPromise = null;

/** Lazy adapter keeps the shared sensor graph free of browser transport imports. */
export function loadHeadlessMessageCodec() {
    codecPromise ??= import("../../client/Client.js").then((client) => Object.freeze({
        encodeTopicValue: client.encodeTopicValue,
        registerMsgDefinition: client.registerMsgDefinition,
    }));
    return codecPromise;
}
