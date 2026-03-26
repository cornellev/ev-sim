import { Road } from "../city/Road";
import { Database } from "./Database";

export class City extends Database {
    constructor(parent) {
        super(parent);
        this.roads = [];
        this.roadSetup = false;
        this.intersections = [];
        this.intersectionSetup = false;
    }

    addRoad(road) {
        this.roads.push(road);
        road.parent = this;
    }

    addRoads(roads) {
        for (const road of roads) {
            this.addRoad(road);
        }
    }

    /**
     * 
     * @returns {Road[]}
     */
    getRoads() {
        return this.roads;
    }

    addIntersection(intersection) {
        this.intersections.push(intersection);
        intersection.parent = this;
    }

    async setupRoads(scene) {
        for (const road of this.roads) {
            await road.setup(scene);
            if (road.triangles?.length) {
                this.getParent().objects().addObjects(road.triangles);
            }
        }

        this.roadSetup = true;
        
        console.log("Setup city with", this.roads.length, "roads");
    }

    async setupIntersections(scene) {
        if (!this.roadSetup) {
            console.warn("Roads must be set up before intersections");
            return;
        }

        for (const intersection of this.intersections) {
            await intersection.setup(scene);
        }

        console.log("Setup city with", this.intersections.length, "intersections");
    }

    async setup(scene) {
        // ...
    }
}