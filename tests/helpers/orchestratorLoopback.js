import { WebSocketServer } from "ws";

const OP_CODES = {
    echo: 0x00,
    subscribe: 0x01,
    publish: 0x02,
};

const RESP = {
    echo: 0x80,
    update: 0x82,
};

const TYPE_ENCODERS = {
    "std_msgs/String": 0x01,
    "std_msgs/Int32": 0x02,
    "std_msgs/Float32": 0x03,
    "std_msgs/Bool": 0x04,
};

const DYNAMIC_TYPE_BYTE = 0xff;
const encoder = new TextEncoder();

function encodeTopicInfo(topicId, name, typeStr, count = 0) {
    const nameBytes = encoder.encode(name);
    const typeBytes = encoder.encode(typeStr);
    const useDynamic = TYPE_ENCODERS[typeStr] === undefined;
    const typeByte = useDynamic ? DYNAMIC_TYPE_BYTE : TYPE_ENCODERS[typeStr];
    const dynamicLen = useDynamic ? typeBytes.length : 0;
    const bodyLen = 7 + dynamicLen + 4 + 1 + nameBytes.length;
    const out = new Uint8Array(bodyLen);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, topicId, false);
    out[4] = typeByte;
    dv.setUint16(5, dynamicLen, true);
    let offset = 7;
    if (useDynamic) {
        out.set(typeBytes, offset);
        offset += typeBytes.length;
    }
    dv.setUint32(offset, count, true);
    out[offset + 4] = nameBytes.length;
    out.set(nameBytes, offset + 5);
    return out;
}

function encodeEcho(topics) {
    const encodedTopics = topics.map((topic, index) => encodeTopicInfo(index + 1, topic.name, topic.typeStr, topic.count || 0));
    const totalLen = 4 + encodedTopics.reduce((sum, chunk) => sum + chunk.length, 0);
    const payload = new Uint8Array(totalLen);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, encodedTopics.length, true);
    let offset = 4;
    for (const chunk of encodedTopics) {
        payload.set(chunk, offset);
        offset += chunk.length;
    }
    const frame = new Uint8Array(1 + payload.length);
    frame[0] = RESP.echo;
    frame.set(payload, 1);
    return frame;
}

function encodeUpdate(name, typeStr, valueBytes) {
    const info = encodeTopicInfo(1, name, typeStr, 1);
    const payload = new Uint8Array(info.length + valueBytes.length);
    payload.set(info, 0);
    payload.set(valueBytes, info.length);
    const frame = new Uint8Array(1 + payload.length);
    frame[0] = RESP.update;
    frame.set(payload, 1);
    return frame;
}

export function createOrchestratorLoopback({ topics = [] } = {}) {
    const catalog = new Map(topics.map((topic) => [topic.name, { ...topic, subscribers: new Set() }]));
    const wss = new WebSocketServer({ port: 0 });
    const port = wss.address().port;

    wss.on("connection", (socket) => {
        socket.on("message", (data) => {
            const buf = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data.buffer || data);
            if (!buf.length) return;
            const op = buf[0];
            if (op === OP_CODES.echo) {
                const echoTopics = [...catalog.values()].map((entry) => ({
                    name: entry.name,
                    typeStr: entry.typeStr,
                    count: entry.count || 0,
                }));
                socket.send(encodeEcho(echoTopics));
                return;
            }
            if (op === OP_CODES.subscribe) {
                for (const entry of catalog.values()) {
                    entry.subscribers.add(socket);
                }
                return;
            }
            if (op === OP_CODES.publish) {
                const view = buf.subarray(1);
                const nameLen = view[0];
                const name = new TextDecoder().decode(view.subarray(1, 1 + nameLen));
                const entry = catalog.get(name) || { name, typeStr: "std_msgs/String", count: 0, subscribers: new Set() };
                entry.count = (entry.count || 0) + 1;
                catalog.set(name, entry);
                const updateFrame = encodeUpdate(name, entry.typeStr, view.subarray(1 + nameLen));
                for (const subscriber of entry.subscribers) {
                    if (subscriber.readyState === subscriber.OPEN) subscriber.send(updateFrame);
                }
                for (const subscriber of catalog.values()) {
                    for (const client of subscriber.subscribers) {
                        if (client !== socket && client.readyState === client.OPEN) client.send(updateFrame);
                    }
                }
            }
        });
    });

    return {
        port,
        url: `ws://127.0.0.1:${port}`,
        registerTopic(name, typeStr) {
            catalog.set(name, { name, typeStr, count: 0, subscribers: new Set() });
        },
        async close() {
            await new Promise((resolve, reject) => wss.close((error) => (error ? reject(error) : resolve())));
        },
    };
}
