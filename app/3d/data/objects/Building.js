import { Box } from "./Box";

export class Building extends Box {
    constructor(position, size) {
        super(position, size);
        this.setTags(["building"]);
    }
}