import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";

import { MARKETPLACE_KINDS } from "./MarketplaceContract.js";
import { registerMarketplaceFormats } from "./MarketplaceFormats.js";

const SCHEMA_NAMES = Object.freeze([
    "common",
    "item",
    "release",
    "catalog",
    "advisory",
    "collection",
    "sources",
    "installed",
    "install-receipt",
]);

function loadSchema(name) {
    const url = new URL(`../../schemas/marketplace/v1/${name}.schema.json`, import.meta.url);
    return JSON.parse(readFileSync(url, "utf8"));
}

export const MARKETPLACE_SCHEMAS = Object.freeze(Object.fromEntries(
    SCHEMA_NAMES.map((name) => [name, Object.freeze(loadSchema(name))]),
));

const ajv = registerMarketplaceFormats(new Ajv2020({
    strict: true,
    allErrors: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
}));

for (const schema of Object.values(MARKETPLACE_SCHEMAS)) ajv.addSchema(schema);

const SCHEMA_BY_KIND = Object.freeze({
    [MARKETPLACE_KINDS.item]: "item",
    [MARKETPLACE_KINDS.release]: "release",
    [MARKETPLACE_KINDS.catalog]: "catalog",
    [MARKETPLACE_KINDS.advisory]: "advisory",
    [MARKETPLACE_KINDS.collection]: "collection",
    [MARKETPLACE_KINDS.sources]: "sources",
    [MARKETPLACE_KINDS.installed]: "installed",
    [MARKETPLACE_KINDS.installReceipt]: "install-receipt",
});

export function marketplaceSchemaName(kind) {
    return SCHEMA_BY_KIND[kind] ?? null;
}

export function marketplaceSchemaValidator(kind) {
    const name = marketplaceSchemaName(kind);
    return name ? ajv.getSchema(MARKETPLACE_SCHEMAS[name].$id) : null;
}

export function marketplaceSchemaEngine() {
    return ajv;
}
