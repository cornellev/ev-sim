import { ZENOH_BROWSER_LIMITS as LIMITS } from "./ZenohBrowserConfig.js";

// The SDK and browser surface are injected so tests exercise the worker's real logic.
export function createZenohBrowserWorkerRuntime({ sdk, postMessage }) {
    let session = null;
    let connectionGeneration = 0;
    let routeGeneration = 0;
    let nextSampleId = 0;
    let publishing = false;
    let controlTail = Promise.resolve();
    const publishers = new Map();
    const subscribers = new Map();
    const routes = new Map();
    const inbound = new Map();
    let inboundBytes = 0;

    const emit = (message, transfer = []) => postMessage({ ...message, connectionGeneration }, transfer);
    const dropped = (routeId, code) => emit({ type: "inbound-rejected", routeId, code });

    async function subscribe(route) {
        const generation = routeGeneration;
        const binding = { route, handle: null };
        subscribers.set(route.routeId, binding);
        try {
            binding.handle = await session.declareSubscriber(route.key, { handler: (sample) => {
                if (generation !== routeGeneration || subscribers.get(route.routeId) !== binding) return;
                if (sample.kind() !== sdk.SampleKind.PUT) return;
                const length = sample.payload().len();
                if (length > LIMITS.payloadBytes) return dropped(route.routeId, "payload-too-large");
                if (inbound.size >= LIMITS.inboundEntries || inboundBytes + length > LIMITS.inboundBytes) return dropped(route.routeId, "inbound-handoff-full");
                const bytes = sample.payload().toBytes().slice();
                const sampleId = ++nextSampleId;
                inbound.set(sampleId, length);
                inboundBytes += length;
                emit({ type: "sample", sampleId, routeId: route.routeId, routeGeneration: generation, bytes }, [bytes.buffer]);
            } });
        } catch (error) { subscribers.delete(route.routeId); throw error; }
    }

    async function unsubscribe(routeId) {
        const binding = subscribers.get(routeId);
        subscribers.delete(routeId);
        await binding?.handle?.undeclare();
    }

    async function control(message) {
        switch (message.type) {
            case "open": {
                if (session) throw new Error("Worker already owns a Zenoh session.");
                connectionGeneration = message.connectionGeneration;
                routeGeneration = message.routeGeneration;
                if (!Array.isArray(message.routes) || message.routes.length > 64) throw new Error("Zenoh requires at most 64 routes.");
                session = await sdk.Session.open(new sdk.Config(message.endpoint, LIMITS.requestTimeoutMs));
                for (const route of message.routes) {
                    if (!route.routeId || routes.has(route.routeId) || !["publish", "subscribe"].includes(route.direction)) throw new Error("Invalid or duplicate Zenoh route.");
                    routes.set(route.routeId, route);
                    if (route.direction === "publish") publishers.set(route.routeId, await session.declarePublisher(route.key, { encoding: sdk.Encoding.APPLICATION_PROTOBUF }));
                    else await subscribe(route);
                }
                return { routes: routes.size };
            }
            case "bind":
                routeGeneration = message.routeGeneration;
                for (const routeId of [...subscribers.keys()]) await unsubscribe(routeId);
                for (const route of routes.values()) if (route.direction === "subscribe") await subscribe(route);
                return {};
            case "subscribe": {
                const route = { routeId: message.routeId, key: message.key, direction: "subscribe" };
                if (publishers.has(route.routeId)) throw new Error("Cannot replace a publisher with a subscription.");
                if (!routes.has(route.routeId) && routes.size >= 64) throw new Error("Zenoh requires at most 64 routes.");
                await unsubscribe(route.routeId);
                routes.set(route.routeId, route);
                await subscribe(route);
                return {};
            }
            case "unsubscribe":
                await unsubscribe(message.routeId);
                routes.delete(message.routeId);
                return {};
            case "heartbeat":
                await session.info();
                return {};
            case "close":
                routeGeneration++;
                for (const routeId of [...subscribers.keys()]) await unsubscribe(routeId);
                for (const publisher of publishers.values()) await publisher.undeclare();
                publishers.clear();
                routes.clear();
                inbound.clear();
                inboundBytes = 0;
                await session?.close();
                session = null;
                return {};
            default: throw new Error(`Unknown Zenoh worker request ${message.type}.`);
        }
    }

    async function publication(message) {
        if (publishing || message.routeGeneration !== routeGeneration) throw new Error("Stale or concurrent Zenoh publication.");
        const publisher = publishers.get(message.routeId);
        if (!publisher || routes.get(message.routeId)?.key !== message.key || !(message.bytes instanceof Uint8Array) || message.bytes.byteLength > LIMITS.payloadBytes) throw new Error("Invalid Zenoh publication.");
        publishing = true;
        try { await publisher.put(message.bytes); return {}; }
        finally { publishing = false; }
    }

    function handle(message) {
        if (message.type !== "open" && message.connectionGeneration !== connectionGeneration) return;
        if (message.type === "sample-ack") {
            const length = inbound.get(message.sampleId);
            if (length !== undefined) { inbound.delete(message.sampleId); inboundBytes -= length; }
            return;
        }
        const work = message.type === "publish" ? controlTail.catch(() => {}).then(() => publication(message))
            : (controlTail = controlTail.catch(() => {}).then(() => control(message)));
        return work.then((result) => emit({ type: "reply", requestId: message.requestId, ok: true, ...result }),
            (error) => emit({ type: "reply", requestId: message.requestId, ok: false, error: error.message }));
    }

    return { handle, getInboundStats: () => ({ entries: inbound.size, bytes: inboundBytes }) };
}
