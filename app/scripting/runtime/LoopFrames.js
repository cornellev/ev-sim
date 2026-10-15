import { REPEAT_REF_TYPE, UNIT_TYPE } from "../types/PortTypes.js";

export const REPEAT_BODY_INPUT = "body";
export const REPEAT_REF_PORT = "repeat";

/**
 * Edges `{ from, output, to, input, type }` from live units, matching the
 * shape of compiled `transitions.success`.
 */
export function graphEdges(units) {
    const edges = [];
    for (const unit of units) {
        for (const [input, connection] of Object.entries(unit.inputs || {})) {
            const output = connection.getOutput();
            edges.push({
                from: output.unit.uuid,
                output: output.label,
                to: unit.uuid,
                input,
                type: output.unit.outputType(output.label),
            });
        }
    }
    return edges;
}

function indexEdges(edges) {
    const incoming = new Map();
    const outgoing = new Map();
    for (const edge of edges) {
        if (!incoming.has(edge.to)) incoming.set(edge.to, []);
        incoming.get(edge.to).push(edge);
        if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
        outgoing.get(edge.from).push(edge);
    }
    return { incoming, outgoing };
}

function walk(starts, next) {
    const seen = new Set();
    const stack = [...starts];
    while (stack.length > 0) {
        const uuid = stack.pop();
        if (seen.has(uuid)) continue;
        seen.add(uuid);
        for (const neighbor of next(uuid)) {
            if (!seen.has(neighbor)) stack.push(neighbor);
        }
    }
    return seen;
}

function bodyRegion(index, repeatUuid) {
    const bodyEdge = (index.incoming.get(repeatUuid) || []).find((edge) => edge.input === REPEAT_BODY_INPUT);
    if (!bodyEdge || bodyEdge.from === repeatUuid) return { bodyEdge: null, region: new Set() };
    const region = walk([bodyEdge.from], (uuid) => (index.incoming.get(uuid) || [])
        .filter((edge) => edge.type !== REPEAT_REF_TYPE && edge.from !== repeatUuid)
        .map((edge) => edge.from));
    return { bodyEdge, region };
}

/** Every block upstream of a Repeat's `body` input, not crossing `repeat_ref`. */
export function loopBodyRegion(edges, repeatUuid) {
    return bodyRegion(indexEdges(edges), repeatUuid).region;
}

/**
 * Blocks a Repeat re-runs on every pass: those downstream of its Index blocks,
 * plus the `unit` chain that ends at `body`. Everything else in the body region
 * is pulled by data only and keeps its first result for the whole loop.
 */
export function loopPassUnits(edges, repeatUuid) {
    const index = indexEdges(edges);
    const { bodyEdge, region } = bodyRegion(index, repeatUuid);
    if (!bodyEdge) return new Set();

    const indexBlocks = (index.outgoing.get(repeatUuid) || [])
        .filter((edge) => edge.type === REPEAT_REF_TYPE && region.has(edge.to))
        .map((edge) => edge.to);
    const dependents = walk(indexBlocks, (uuid) => (index.outgoing.get(uuid) || [])
        .filter((edge) => edge.type !== REPEAT_REF_TYPE && region.has(edge.to))
        .map((edge) => edge.to));
    const chain = walk([bodyEdge.from], (uuid) => (index.incoming.get(uuid) || [])
        .filter((edge) => edge.type === UNIT_TYPE && region.has(edge.from))
        .map((edge) => edge.from));

    return new Set([...dependents, ...chain]);
}
