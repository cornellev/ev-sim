/** Minimal saved Duffy junction and anchors that reproduced the false one-way failure. */
export function duffyRoutingFixture() {
    const automaticCurve = () => ({
        version: 1,
        kind: "cubic-bezier",
        knots: [{ id: "start", mode: "auto" }, { id: "end", mode: "auto" }],
    });
    return {
        environmentId: "duffy-straight-through-regression",
        roads: {
            geometryVersion: 2,
            nodes: [
                { id: "east", x: 73.04090275800164, y: 6.2526469599389705, z: 3.7045230593443526, kind: "intersection" },
                { id: "junction", x: -13.37076570139569, y: 0.653108323593965, z: 9.195781029749353, kind: "intersection" },
                { id: "south", x: -18, y: 1.4052577567252782, z: -122, kind: "endpoint" },
                { id: "west", x: -105, y: -6.457725276030915, z: 12, kind: "intersection" },
            ],
            edges: [
                { id: "east-junction", startNodeId: "east", endNodeId: "junction", bidirectional: true, width: 7, laneCount: 2, shoulderWidth: 0, geometry: automaticCurve() },
                { id: "junction-south", startNodeId: "junction", endNodeId: "south", bidirectional: true, width: 7, laneCount: 2, shoulderWidth: 0, geometry: automaticCurve() },
                { id: "junction-west", startNodeId: "junction", endNodeId: "west", bidirectional: true, width: 7, laneCount: 2, shoulderWidth: 0, geometry: automaticCurve() },
            ],
        },
        waypoints: [
            {
                id: "start", kind: "start", order: 0,
                position: { x: -87.08336090083179, y: -5.071468939623154, z: 13.202498823648654 },
                anchor: { kind: "road", id: "junction-west", fraction: 0.8050501305744091, laneMode: "fixed", laneIndex: 1, laneId: "lane-1" },
            },
            {
                id: "finish", kind: "finish", order: 1,
                position: { x: 36.022082, y: 3.846609, z: 7.810512 },
                anchor: { kind: "road", id: "east-junction", fraction: 0.4296850913538972, laneMode: "fixed", laneIndex: 1, laneId: "lane-1" },
            },
        ],
    };
}
