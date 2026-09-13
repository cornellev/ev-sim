import assert from "node:assert/strict";
import test from "node:test";

import { createGeoFrame } from "../app/3d/earth/GeoFrame.js";
import { OverpassRoadProvider, buildOverpassQuery, createRoadNetworkProvider } from "../app/3d/earth/roads/OverpassRoadProvider.js";
import { RoadImportService, buildRoadImportDraft, clipRoadNetworkToArea } from "../app/3d/earth/roads/RoadImportService.js";

const BOUNDS = { north: 1, south: 0, east: 1, west: 0 };
const FRAME = createGeoFrame({ origin: { lat: 0.5, lng: 0.5, height: 0 } });
const network = (ways) => ({ providerId: "overpass", fetchedAt: "2026-09-13T00:00:00.000Z", ways });
const point = (id, lat, lng) => ({ id: String(id), lat, lng });

test("ED-08 clipping handles outside crossings, exits, and re-entry with stable boundary IDs", () => {
    const source = network([
        { id: "cross", sourceWayId: "cross", tags: { highway: "residential" }, points: [point(1, 0.5, -1), point(2, 0.5, 2)] },
        { id: "reentry", sourceWayId: "reentry", tags: { highway: "service" }, points: [
            point(3, 0.25, 0.25), point(4, 0.25, 1.5), point(5, 0.75, 1.5), point(6, 0.75, 0.75),
        ] },
    ]);
    const first = clipRoadNetworkToArea(source, BOUNDS);
    const second = clipRoadNetworkToArea(source, BOUNDS);
    assert.deepEqual(first, second);
    assert.equal(first.ways.length, 3);
    assert.deepEqual(first.ways[0].points.map((entry) => entry.lng), [0, 1]);
    assert.match(first.ways[0].points[0].id, /^boundary:cross:0:/);
    assert.match(first.ways[1].points.at(-1).id, /^boundary:reentry:0:/);
    assert.match(first.ways[2].points[0].id, /^boundary:reentry:2:/);
});

test("ED-08 draft topology connects shared OSM references and never coordinate proximity", () => {
    const clipped = network([
        { id: "a", sourceWayId: "10", tags: { highway: "residential" }, points: [point(1, 0.5, 0.4), point(2, 0.5, 0.5)] },
        { id: "b", sourceWayId: "11", tags: { highway: "residential" }, points: [point(2, 0.5, 0.5), point(3, 0.6, 0.5)] },
        { id: "bridge", sourceWayId: "12", tags: { highway: "service", bridge: "yes", layer: "1" }, points: [point(20, 0.5, 0.5), point(21, 0.4, 0.5)] },
    ]);
    const draft = buildRoadImportDraft(clipped, FRAME, { importId: "topology" });
    const shared = draft.roads.nodes.filter((entry) => entry.source.osmNodeId === "2");
    const coincident = draft.roads.nodes.filter((entry) => ["2", "20"].includes(entry.source.osmNodeId));
    assert.equal(shared.length, 1);
    assert.equal(coincident.length, 2);
    assert.equal(shared[0].kind, "intersection");
    assert.equal(draft.roads.edges.find((entry) => entry.source.osmWayId === "12").source.bridge, true);
    assert.equal(draft.roads.edges.find((entry) => entry.source.osmWayId === "12").source.layer, 1);
});

test("ED-08 draft builds legal loops and reports lane ambiguity and oversized junctions", () => {
    const loop = { id: "loop", sourceWayId: "99", tags: { highway: "residential", lanes: "3" }, points: [
        point(1, 0.4, 0.4), point(2, 0.4, 0.6), point(3, 0.6, 0.6), point(1, 0.4, 0.4),
    ] };
    const spokes = Array.from({ length: 5 }, (_, index) => ({
        id: `spoke-${index}`, sourceWayId: `spoke-${index}`, tags: { highway: "service" },
        points: [point(50, 0.5, 0.5), point(60 + index, 0.5 + index * 0.01, 0.6)],
    }));
    const draft = buildRoadImportDraft(network([loop, ...spokes]), FRAME, { importId: "issues" });
    assert.ok(draft.roads.edges.filter((entry) => entry.source.osmWayId === "99").length >= 2);
    assert.ok(draft.roads.edges.every((entry) => entry.startNodeId !== entry.endNodeId));
    assert.ok(draft.issues.some((entry) => entry.code === "road-import.lanes.ambiguous"));
    assert.ok(draft.issues.some((entry) => entry.code === "road-import.degree-unsupported"));
});

test("ED-08 lane compilation handles reverse and explicit directional counts", () => {
    const draft = buildRoadImportDraft(network([
        { id: "reverse", sourceWayId: "1", tags: { highway: "primary", oneway: "-1", lanes: "2" }, points: [point(1, 0.4, 0.4), point(2, 0.4, 0.6)] },
        { id: "asymmetric", sourceWayId: "2", tags: { highway: "primary", lanes: "3", "lanes:forward": "2", "lanes:backward": "1" }, points: [point(3, 0.6, 0.4), point(4, 0.6, 0.6)] },
        { id: "forward-only", sourceWayId: "3", tags: { highway: "service", oneway: "yes", "lanes:forward": "2", "lanes:backward": "0" }, points: [point(5, 0.7, 0.4), point(6, 0.7, 0.6)] },
        { id: "backward-only", sourceWayId: "4", tags: { highway: "service", oneway: "-1", "lanes:forward": "0", "lanes:backward": "3" }, points: [point(7, 0.8, 0.4), point(8, 0.8, 0.6)] },
    ]), FRAME, { importId: "lanes" });
    const reverse = draft.roads.edges.find((entry) => entry.source.osmWayId === "1");
    const asymmetric = draft.roads.edges.find((entry) => entry.source.osmWayId === "2");
    assert.equal(reverse.bidirectional, false);
    assert.equal(reverse.direction, -1);
    assert.deepEqual(asymmetric.lanes.map((lane) => lane.direction), [1, 1, -1]);
    assert.equal(draft.roads.edges.find((entry) => entry.source.osmWayId === "3").laneCount, 2);
    assert.equal(draft.roads.edges.find((entry) => entry.source.osmWayId === "4").laneCount, 3);
    assert.equal(draft.issues.length, 0);
});

test("ED-08 Overpass rejects missing references, unsupported providers, and filters outside the allowlist", async () => {
    const provider = new OverpassRoadProvider({ fetchImpl: async () => ({
        ok: true,
        json: async () => ({ elements: [{ type: "node", id: 1, lat: 0, lon: 0 }, { type: "way", id: 2, nodes: [1, 9], tags: { highway: "service" } }] }),
    }) });
    await assert.rejects(provider.fetchRoadNetwork(BOUNDS), (error) => error.code === "road-import.osm-node-missing");
    assert.throws(() => createRoadNetworkProvider("unknown"), /Unsupported road network provider/);
    assert.throws(() => buildOverpassQuery(BOUNDS, { highwayClasses: ["raceway"] }), /Unsupported OSM highway classes/);
});

test("ED-08 import fetch passes filters and AbortSignal without document access", async () => {
    const controller = new AbortController();
    let received = null;
    const service = new RoadImportService({ providerFactory: (providerId) => ({
        fetchRoadNetwork: async (bounds, options) => { received = { providerId, bounds, options }; return network([]); },
    }) });
    const smallBounds = { north: 0.01, south: 0, east: 0.01, west: 0 };
    await service.fetch(smallBounds, { providerId: "overpass", highwayClasses: ["service"] }, controller.signal);
    assert.equal(received.providerId, "overpass");
    assert.deepEqual(received.bounds, smallBounds);
    assert.deepEqual(received.options.filters, { highwayClasses: ["service"] });
    assert.equal(received.options.signal, controller.signal);
    await assert.rejects(service.fetch(BOUNDS, {}, controller.signal), /5000m limit/);
});
