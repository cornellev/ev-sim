const ROAD_COORDINATES = `42°40'05.93"N 83°13'03.15"W -> 42°40'04.71"N 83°13'03.11"W
42°40'04.59"N 83°13'02.44"W -> 42°40'04.59"N 83°13'02.95"W
42°40'04.58"N 83°13'03.24"W -> 42°40'04.57"N 83°13'03.78"W
42°40'06.05"N 83°13'03.31"W -> 42°40'06.04"N 83°13'03.81"W
42°40'06.14"N 83°13'03.96"W -> 42°40'06.28"N 83°13'03.96"W
42°40'06.02"N 83°13'04.13"W -> 42°40'06.01"N 83°13'04.64"W
42°40'05.91"N 83°13'03.98"W -> 42°40'05.43"N 83°13'03.97"W
42°40'05.30"N 83°13'04.10"W -> 42°40'05.29"N 83°13'04.26"W
42°40'05.31"N 83°13'03.80"W -> 42°40'05.31"N 83°13'03.62"W
42°40'05.19"N 83°13'03.95"W -> 42°40'04.70"N 83°13'03.94"W
42°40'04.56"N 83°13'04.08"W -> 42°40'04.55"N 83°13'04.58"W
42°40'04.69"N 83°13'04.74"W -> 42°40'05.90"N 83°13'04.79"W`;

const INTERSECTION_ROADS = Object.freeze([
    [0, 3],
    [0, 1, 2],
    [2, 10, 9],
    [9, 7, 6, 8],
    [3, 6, 5, 4],
    [11, 5],
    [10, 11],
]);

function parseCoordinate(value) {
    const [latitude, longitude] = value.split(" ");
    const parse = (part, negative) => {
        const match = part.match(/(\d+)°(\d+)'([\d.]+)"([NSEW])/);
        const degrees = Number(match[1]) + Number(match[2]) / 60 + Number(match[3]) / 3600;
        return negative.includes(match[4]) ? -degrees : degrees;
    };
    return { latitude: parse(latitude, "S"), longitude: parse(longitude, "W") };
}

function toMercator({ latitude, longitude }) {
    const radius = 6_378_137;
    return {
        x: radius * longitude * Math.PI / 180,
        z: radius * Math.log(Math.tan(latitude * Math.PI / 360 + Math.PI / 4)),
    };
}

function squaredDistance(left, right) {
    return (left.x - right.x) ** 2 + (left.z - right.z) ** 2;
}

function chooseIntersectionEndpoints(roads, roadIndexes) {
    let best = null;
    const combinationCount = 2 ** roadIndexes.length;
    for (let mask = 0; mask < combinationCount; mask += 1) {
        const points = roadIndexes.map((roadIndex, offset) => roads[roadIndex][(mask >> offset) & 1]);
        let score = 0;
        for (let left = 0; left < points.length; left += 1) {
            for (let right = left + 1; right < points.length; right += 1) {
                score += squaredDistance(points[left], points[right]);
            }
        }
        if (!best || score < best.score) best = { score, points, mask };
    }
    return best;
}

/**
 * Pure server/browser projection of the native IGVC template road topology.
 * The runtime scene remains the visual source; this document gives authoring,
 * validation, and deterministic route verification the same logical graph.
 */
export function createBuiltInIGVCEnvironmentDocument() {
    const geographicRoads = ROAD_COORDINATES.split("\n").map((line) => (
        line.split(" -> ").map((coordinate) => toMercator(parseCoordinate(coordinate)))
    ));
    const origin = geographicRoads[0][0];
    const roads = geographicRoads.map((road) => road.map((point) => ({
        x: point.x - origin.x,
        z: -(point.z - origin.z),
    })));
    const nodes = [];
    const links = new Map();

    INTERSECTION_ROADS.forEach((roadIndexes, intersectionIndex) => {
        const selected = chooseIntersectionEndpoints(roads, roadIndexes);
        const center = selected.points.reduce((sum, point) => ({
            x: sum.x + point.x / selected.points.length,
            z: sum.z + point.z / selected.points.length,
        }), { x: 0, z: 0 });
        const id = `intersection:${intersectionIndex}`;
        nodes.push({ id, x: center.x, z: center.z, kind: "intersection" });
        roadIndexes.forEach((roadIndex, offset) => {
            const entries = links.get(roadIndex) ?? [];
            entries.push({ id, endpoint: (selected.mask >> offset) & 1 });
            links.set(roadIndex, entries);
        });
    });

    const edges = roads.map((road, roadIndex) => {
        const roadLinks = links.get(roadIndex) ?? [];
        const endpointNode = (endpoint) => {
            const link = roadLinks.find((entry) => entry.endpoint === endpoint);
            if (link) return link.id;
            const id = `endpoint:road-${roadIndex}-${endpoint}`;
            const point = road[endpoint];
            nodes.push({ id, x: point.x, z: point.z, kind: "endpoint" });
            return id;
        };
        return {
            id: `road:${roadIndex}`,
            startNodeId: endpointNode(0),
            endNodeId: endpointNode(1),
            bidirectional: true,
            width: 6.096,
            laneCount: 2,
            shoulderWidth: 3,
        };
    });

    return {
        environmentId: "igvc",
        chunkSize: 20,
        roadsAuthored: false,
        buildingsAuthored: false,
        featuresAuthored: false,
        roads: { nodes, edges },
        buildings: [],
        features: [],
        earth: null,
    };
}

export function createBuiltInIGVCEnvironmentManifest() {
    return {
        environmentId: "igvc",
        name: "IGVC",
        schemaVersion: 2,
        templateId: "igvc",
        roadStylePreset: "igvc",
        roadsAuthored: false,
        document: createBuiltInIGVCEnvironmentDocument(),
    };
}
