import * as THREE from "three";
import Unit from "@/app/util/Unit";
import { buildStripGeometry, createSolidLine, Road } from "./Road";


export class Intersection {
    /**
     * @param {Road[]} roads Roads connected to the intersection. At minimum, 2 roads can be added, and at maximum, 4 roads can be added.
     *                       Must be clockwise.
     * @param {Object} options
     */
    constructor(roads = [], options = {}) { 
        this.roads = roads;

        this.options = Object.assign({
            borderRadius: 0.5, // radius of the rounded corners in meters
            cornerSamples: 8, // number of samples to take when rounding corners
        }, options);

        this.roadEnds = []; // list of { left: THREE.Vector3, right: THREE.Vector3 } for each road end, ordered clockwise
    }

    calculateSides() {
        let combos = [];
        // calculate all possible combinations of use end or use start for each road, with true/false for each road
        const n = this.roads.length;
        for (let i = 0; i < (1 << n); i++) {
            const combo = [];
            for (let j = 0; j < n; j++) {
                combo.push((i & (1 << j)) ? true : false);
            }
            combos.push(combo);
        }
        
        // for each combo, calculate the distance between each of the roads' start/end points, and sort by distance
        let minimumDistance = Infinity;
        let bestCombo = null;
        for (const combo of combos) {
            const points = [];
            for (let i = 0; i < this.roads.length; i++) {
                const road = this.roads[i];
                const useEnd = combo[i];
                const point = useEnd ? road.points[road.points.length - 1] : road.points[0];
                points.push(point);
            }
            
            // calculate total distance between all points
            let totalDistance = 0;
            for (let i = 0; i < points.length; i++) {
                for (let j = i + 1; j < points.length; j++) {
                    totalDistance += points[i].distanceTo(points[j]);
                }
            }

            if (totalDistance < minimumDistance) {
                minimumDistance = totalDistance;
                bestCombo = combo;
            }
        }
        
        const bestPoints = [];
        for (let i = 0; i < bestCombo.length; i++) {
            const road = this.roads[i];
            const useEnd = bestCombo[i];
            const pointL = useEnd ? road.roadEdges.left[road.roadEdges.left.length - 1] : road.roadEdges.left[0];
            const pointR = useEnd ? road.roadEdges.right[road.roadEdges.right.length - 1] : road.roadEdges.right[0];
            const center = useEnd ? road.points[road.points.length - 1] : road.points[0];
            bestPoints.push({ left: pointL, right: pointR, center });
        }

        return bestPoints;
    }

    /**
     * 
     * @param {THREE.Vector3[]} vertices 
     * @param {THREE.Vector3} center 
     * @returns 
     */
    sortVertices(vertices, center) {
        // Order vertices clockwise around `center` on the ground plane (XZ).
        // (Angles from atan2 increase CCW, so we sort descending for CW.)
        vertices.sort((a, b) => {
            const angleA = Math.atan2(a.z - center.z, a.x - center.x);
            const angleB = Math.atan2(b.z - center.z, b.x - center.x);
            if (angleA !== angleB) return angleB - angleA;

            // Deterministic tie-breaker when angles match.
            const dxA = a.x - center.x;
            const dzA = a.z - center.z;
            const dxB = b.x - center.x;
            const dzB = b.z - center.z;
            return (dxB * dxB + dzB * dzB) - (dxA * dxA + dzA * dzA);
        });

        return vertices;
    }

    /**
     * Choose the two edge points ordered as { rightMost, leftMost } relative to the road direction.
     * This avoids issues with raw angle sorting around -PI/PI and matches the local road frame.
     * @param {{left: THREE.Vector3, right: THREE.Vector3, center: THREE.Vector3}} edge
     * @param {THREE.Vector3} centerPoint
     */
    getRoadEdgeOrdering(edge, centerPoint) {
        const up = new THREE.Vector3(0, 1, 0);

        // Direction from intersection toward the road.
        const forward = edge.center.clone().sub(centerPoint);
        forward.y = 0;
        if (forward.lengthSq() === 0) {
            return { rightMost: edge.right.clone(), leftMost: edge.left.clone() };
        }
        forward.normalize();

        const candidates = [edge.left.clone(), edge.right.clone()].map((p) => {
            const v = p.clone().sub(centerPoint);
            v.y = 0;
            if (v.lengthSq() === 0) return { p, signed: 0 };
            v.normalize();

            // Signed angle from `forward` to `v` around +Y.
            const cross = new THREE.Vector3().crossVectors(forward, v);
            const sin = up.dot(cross);
            const cos = forward.dot(v);
            return { p, signed: Math.atan2(sin, cos) };
        });

        // More negative is more clockwise => "right".
        candidates.sort((a, b) => a.signed - b.signed);
        return { rightMost: candidates[0].p, leftMost: candidates[1].p };
    }

    getLoop(list, i, offset) {
        const n = list.length;
        return list[(i + offset + n) % n];
    }

    /**
    * @param {THREE.Scene} 
    * */
    setup(scene) { 
        const points = []; // list of list of points for each road segment edges
        
        this.roadEdges = this.calculateSides();

        let verticies = [];

        // Track which original road each vertex came from so we can make
        // special-case decisions (e.g. 3-way intersections).
        const vertexRoadIndex = new WeakMap();

        const centerPoint = new THREE.Vector3(0, 0, 0);

        for (let i = 0; i < this.roadEdges.length; i++) {
            const edge = this.roadEdges[i];
            verticies.push(edge.left);
            verticies.push(edge.right);
            vertexRoadIndex.set(edge.left, i);
            vertexRoadIndex.set(edge.right, i);

            centerPoint.add(edge.center);
        }

        centerPoint.divideScalar(this.roadEdges.length);
        
        if (this.roadEdges.length > 2) {
            for (let edge of this.roadEdges) {
                const { leftMost } = this.getRoadEdgeOrdering(edge, centerPoint);

                const curve = new THREE.CatmullRomCurve3([
                    edge.center,
                    edge.center.clone().lerp(leftMost, 0.5),
                    leftMost
                ], false, "catmullrom", this.options.tension);

                const stopLine = createSolidLine(curve, 0.02, {
                    color: 0xffffff,
                    laneMarkingWidth: 0.1,
                    segments: 2,
                    markingElevation: 0.01
                });

                scene.add(stopLine);
            }
        } else {
            // for 2-road intersections, create a line between the two inner points of the roads, and add it to the scene
            let p1 = this.roadEdges[0].center;
            let p2 = this.roadEdges[1].center;

            // Pick a control point that always bends *into* the intersection.
            // For 2 roads, `centerPoint` is just the midpoint of the two road centers, so
            // using it to disambiguate "inside" vs "outside" can still flip.
            // Instead, compute the inward angle-bisector from the two road directions.
            const mid = p1.clone().add(p2).multiplyScalar(0.5);
            const chordLen = p1.distanceTo(p2);
            const baseOffset = Math.max(this.options.borderRadius, chordLen * 0.25) * 2;
            const offset = Math.min(baseOffset, chordLen * 0.5);

            const roadDirAtEnd = (road, endPoint) => {
                const pts = road?.points;
                if (!pts || pts.length < 2) return null;

                const start = pts[0];
                const end = pts[pts.length - 1];
                const dToStart = endPoint.distanceToSquared(start);
                const dToEnd = endPoint.distanceToSquared(end);
                const useStart = dToStart <= dToEnd;

                const dir = new THREE.Vector3();
                if (useStart) {
                    dir.copy(pts[1]).sub(start);
                } else {
                    dir.copy(pts[pts.length - 2]).sub(end);
                }

                dir.y = 0;
                if (dir.lengthSq() < 1e-12) return null;
                return dir.normalize();
            };

            const out1 = roadDirAtEnd(this.roads[0], p1);
            const out2 = roadDirAtEnd(this.roads[1], p2);

            let control = mid.clone();
            if (out1 && out2 && offset > 1e-12) {
                const inDir = out1.clone().multiplyScalar(-1).add(out2.clone().multiplyScalar(-1));
                inDir.y = 0;
                if (inDir.lengthSq() > 1e-12) {
                    inDir.normalize();
                    control.add(inDir.multiplyScalar(offset));
                }
            }

            control.y = (p1.y + p2.y) / 2 + 0.01;

            // create curve
            const curve = new THREE.QuadraticBezierCurve3(p1, control, p2);

            const stopLine = createSolidLine(curve, 0.02, {
                color: this.roads[0].options.yellowLineColor,
                laneMarkingWidth: 0.1,
                segments: 12,
                markingElevation: 0.01
            });

            scene.add(stopLine);
        }

        verticies = this.sortVertices(verticies, centerPoint);

        const curves = [];

        if (this.roads.length === 2) {
            // find the two points that has the largest distance in order to create a nice rounded corner for the intersection. 
            // This is a bit of a hack, but it works for simple 2-road intersections.
            let maxDistance = 0;
            let p1 = null;
            let p2 = null;
            for (let i = 0; i < verticies.length; i++) {
                for (let j = i + 1; j < verticies.length; j++) {
                    const distance = verticies[i].distanceTo(verticies[j]);
                    if (distance > maxDistance) {
                        maxDistance = distance;
                        p1 = verticies[i];
                        p2 = verticies[j];
                    }
                }
            }

            const cand1 = new THREE.Vector3(p1.x, (p1.y + p2.y) / 2, p2.z);
            const cand2 = new THREE.Vector3(p2.x, (p1.y + p2.y) / 2, p1.z);

            const dist1 = cand1.distanceTo(centerPoint);
            const dist2 = cand2.distanceTo(centerPoint);

            const chosen = dist1 > dist2 ? cand1 : cand2;

            verticies.push(chosen);
            verticies = this.sortVertices(verticies, centerPoint);

            const indexOf = verticies.findIndex(v => v.equals(chosen));
            const leftNeighbor = this.getLoop(verticies, indexOf, -1);
            const rightNeighbor = this.getLoop(verticies, indexOf, 1);

            // bezier curve from leftNeighbor to rightNeighbor with chosen as the control point, and sample points along the curve to create a rounded corner
            const curve = new THREE.QuadraticBezierCurve3(leftNeighbor, chosen, rightNeighbor);
            // create a curve from leftNeighbor to rightNeighbor with chosen as the control point, and sample points along the curve to create a rounded corner
            const cornerPoints = curve.getPoints(this.options.cornerSamples);
            verticies.splice(indexOf, 1, ...cornerPoints);

            // now, get the two inner points of the road
            let pp1 = null;
            let pp2 = null;

            for (let edge of this.roadEdges) {
                if (edge.left.equals(p1) || edge.right.equals(p1)) {
                    pp1 = edge.left.equals(p1) ? edge.right : edge.left;
                }
                if (edge.left.equals(p2) || edge.right.equals(p2)) {
                    pp2 = edge.left.equals(p2) ? edge.right : edge.left;
                }
            }

            p1 = pp1;
            p2 = pp2;

            const mid = p1.clone().add(p2).multiplyScalar(0.5);
            const dir = mid.clone().sub(centerPoint).normalize();

            // control should be inner, closer to the center point, offset closer to the center point to create a nice curve inwards
            const control = mid.clone().add(dir.multiplyScalar(-this.options.borderRadius));

            const curve2 = new THREE.QuadraticBezierCurve3(p1, control, p2);
            const cornerPoints2 = curve2.getPoints(this.options.cornerSamples);
            verticies.push(...cornerPoints2);
            verticies = this.sortVertices(verticies, centerPoint);

            curves.push(curve);
            curves.push(curve2);
        } else {
            let pairs = []; // identify pairs of points that are adjacent but not connected by a road, and create a rounded corner between them

            // For 3-way intersections, two roads are often (nearly) collinear.
            // If we round the *inner* gap between those two opposite roads, it can
            // create a small loop/triangle near the center. We detect the most
            // opposite road pair and skip only the shortest edge-to-edge gap
            // between that pair.
            let oppositePair = null; // [i, j]
            let oppositeMinEdgeDistance = null;
            if (this.roads.length === 3) {
                const clamp = (x, min, max) => Math.min(max, Math.max(min, x));

                // Direction vectors from intersection center toward each road center.
                const dirs = this.roadEdges.map((edge) => {
                    const d = edge.center.clone().sub(centerPoint);
                    d.y = 0;
                    if (d.lengthSq() === 0) return new THREE.Vector3(1, 0, 0);
                    return d.normalize();
                });

                let bestAngle = -Infinity;
                for (let i = 0; i < dirs.length; i++) {
                    for (let j = i + 1; j < dirs.length; j++) {
                        const dot = clamp(dirs[i].dot(dirs[j]), -1, 1);
                        const angle = Math.acos(dot);
                        if (angle > bestAngle) {
                            bestAngle = angle;
                            oppositePair = [i, j];
                        }
                    }
                }

                if (oppositePair) {
                    const [i, j] = oppositePair;
                    const a = this.roadEdges[i];
                    const b = this.roadEdges[j];
                    const candidates = [
                        a.left.distanceTo(b.left),
                        a.left.distanceTo(b.right),
                        a.right.distanceTo(b.left),
                        a.right.distanceTo(b.right),
                    ];
                    oppositeMinEdgeDistance = Math.min(...candidates);
                }
            }

            for (let i = 0; i < verticies.length; i++) {
                const v1 = verticies[i];
                const v2 = verticies[(i + 1) % verticies.length];

                let connected = false;
                for (let edge of this.roadEdges) {
                    if ((v1.equals(edge.left) && v2.equals(edge.right)) || (v1.equals(edge.right) && v2.equals(edge.left))) {
                        connected = true;
                        break;
                    }
                }

                if (!connected) {
                    pairs.push([v1, v2]);
                }
            }

            for (let [v1, v2] of pairs) {
                if (this.roads.length === 3 && oppositePair && oppositeMinEdgeDistance != null) {
                    // Skip rounding the smallest edge-gap between the two most-opposite roads.
                    const i1 = vertexRoadIndex.get(v1);
                    const i2 = vertexRoadIndex.get(v2);
                    if (i1 != null && i2 != null) {
                        const [a, b] = oppositePair;
                        const isOpposite = (i1 === a && i2 === b) || (i1 === b && i2 === a);
                        if (isOpposite) {
                            const d = v1.distanceTo(v2);
                            // Tolerance: vertices are shared object refs, but be safe.
                            if (Math.abs(d - oppositeMinEdgeDistance) < 1e-6) {
                                curves.push(new THREE.LineCurve3(v1, v2));
                                continue;
                            }
                        }
                    }
                }

                const mid = v1.clone().add(v2).multiplyScalar(0.5);
                const dir = mid.clone().sub(centerPoint).normalize();

                // control should be inner, closer to the center point, offset closer to the center point to create a nice curve inwards
                const control = mid.clone().add(dir.multiplyScalar(-this.options.borderRadius));

                const curve = new THREE.QuadraticBezierCurve3(v1, control, v2);
                const cornerPoints = curve.getPoints(this.options.cornerSamples);
                verticies.push(...cornerPoints);

                curves.push(curve);
            }

            verticies = this.sortVertices(verticies, centerPoint);
        }

        // create lines from the verticies
        for (let i = 0; i < verticies.length; i++) {
            const v1 = verticies[i];
            const v2 = verticies[(i + 1) % verticies.length];
            const geometry = new THREE.BufferGeometry().setFromPoints([v1, v2]);
            const material = new THREE.LineBasicMaterial({ color: 0x000000 });
            const line = new THREE.Line(geometry, material);
            // scene.add(line);
        }


        // now, add a polygon for the intersection fill (optional)
        const shape = new THREE.Shape(verticies.map(v => new THREE.Vector2(v.x, v.z)));
        const geometry = new THREE.ShapeGeometry(shape);

        const material = new THREE.MeshStandardMaterial({ 
            color: this.roads[0].options.surfaceColor, 
            roughness: this.roads[0].options.surfaceRoughness,
            metalness: this.roads[0].options.metalness,
            side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.x = Math.PI / 2;
        mesh.position.y = -0.01; // slight offset to prevent z-fighting with the road surfaces
        mesh.receiveShadow = true;
        scene.add(mesh);

        // for each curve, create a shoulder with a thickness of options.sholderWidth, and the same curve but offset to the left and right by options.shoulderWidth, and add it to the scene
        for (let curve of curves) {
            // Build a strip by offsetting perpendicular to the curve tangent.
            // (Using radial-to-center offsets can swap sides mid-curve and cause crossing.)
            const segments = this.options.cornerSamples;
            const up = new THREE.Vector3(0, 1, 0);
            const offsetDist = this.roads[0].options.laneMarkingWidth / 2;

            const leftPoints = [];
            const rightPoints = [];

            for (let i = 0; i <= segments; i++) {
                const t = segments === 0 ? 0 : i / segments;
                const p = curve.getPointAt(t);
                const tangent = curve.getTangentAt(t).clone();
                tangent.y = 0;

                let normal;
                if (tangent.lengthSq() > 1e-12) {
                    tangent.normalize();
                    normal = new THREE.Vector3().crossVectors(up, tangent).normalize();
                } else {
                    // Fallback: if tangent degenerates, use radial direction.
                    const dir = p.clone().sub(centerPoint);
                    dir.y = 0;
                    if (dir.lengthSq() > 1e-12) dir.normalize();
                    normal = new THREE.Vector3().crossVectors(up, dir).normalize();
                }

                leftPoints.push(p.clone().add(normal.clone().multiplyScalar(offsetDist)));
                rightPoints.push(p.clone().add(normal.clone().multiplyScalar(-offsetDist)));
            }

            const shoulderGeometry = buildStripGeometry(leftPoints, rightPoints);
            const mat = new THREE.MeshStandardMaterial({
                color: this.roads[0].options.whiteLineColor,
                roughness: this.roads[0].options.shoulderRoughness,
                metalness: this.roads[0].options.metalness,
                side: THREE.DoubleSide
            });
            const shoulderMesh = new THREE.Mesh(shoulderGeometry, mat);
            // shoulderMesh.rotation.x = Math.PI / 2;
            shoulderMesh.position.y = -0.02; // slight offset to prevent z-fighting with the road surfaces and intersection fill
            shoulderMesh.receiveShadow = true;
            scene.add(shoulderMesh);
        }
        

        // create a point at the center of the intersection for visualization
        // const geometry = new THREE.SphereGeometry(1, 8, 8);
        // const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
        // const sphere = new THREE.Mesh(geometry, material);
        // sphere.position.copy(centerPoint);
        // scene.add(sphere);
    }
}