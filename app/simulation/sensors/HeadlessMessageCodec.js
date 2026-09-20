let codecPromise = null;

/** Lazy adapter keeps the shared sensor graph free of browser transport imports. */
export function loadHeadlessMessageCodec() {
    codecPromise ??= import("../../client/TopicCodec.js").then((codec) => Object.freeze({
        encodeTopicValue: codec.encodeTopicValue,
        registerMsgDefinition: codec.registerMsgDefinition,
    }));
    return codecPromise;
}
