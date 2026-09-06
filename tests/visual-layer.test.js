import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { normalizeEpisodeSpec } from "../app/simulation/headless/HeadlessEpisode.js";
import {
    computeEpisodeHash,
    defaultEpisodeIdentity,
} from "../app/simulation/kernel/SimulationHashes.js";
import { canonicalStringify } from "../app/simulation/RunManifest.js";
import {
    RUN_PACKAGE_PROFILE,
    VISUAL_ALPHA_MODES,
    VISUAL_MATERIAL_EXTENSIONS,
    assertVisualLayer,
    canonicalExactStringify,
    evaluateVisualSourcePolicy,
    hashVisualLayer,
    normalizeVisualLayer,
    parseExactJson,
    parseVisualLayerJson,
    sha256ExactUtf8,
} from "../app/simulation/visual/VisualLayer.js";
import { HEADLESS_PROTOCOL } from "../server/headless/HeadlessProtocol.js";

const root = new URL("../", import.meta.url);
const ownedFixtureUrl = new URL("tests/fixtures/visual-layer/owned-layer.v1.json", root);
const baselineUrl = new URL("tests/fixtures/visual-layer/compatibility-baseline.v1.json", root);
const expectationsUrl = new URL("tests/fixtures/visual-layer/identity-expectations.v1.json", root);
const protoUrl = new URL("proto/cev_sim/headless/v1/headless.proto", root);
const moduleUrl = new URL("app/simulation/visual/VisualLayer.js", root);
const registryUrl = new URL("app/simulation/render/RenderSceneProviderRegistry.js", root);

async function json(url) {
    return JSON.parse(await readFile(url, "utf8"));
}

function authoredLayer() {
    const mesh = "a".repeat(64);
    const texture = "b".repeat(64);
    const coarseMesh = "d".repeat(64);
    return {
        sourceWorldHash: "c".repeat(64),
        assets: [
            { sha256: texture, mediaType: "image/ktx2", sizeBytes: 128, role: "texture" },
            { sha256: mesh, mediaType: "model/gltf-binary", sizeBytes: 256, role: "mesh" },
            { sha256: coarseMesh, mediaType: "model/gltf-binary", sizeBytes: 192, role: "mesh" },
        ],
        materials: [{
            id: "brick",
            parameters: { clearcoatFactor: 0.25 },
            textures: [{
                slot: "baseColor",
                assetUri: `sha256:${texture}`,
                transform: { offset: [0.125, -0], scale: [2, 2] },
            }],
            extensions: ["KHR_texture_transform", "KHR_materials_clearcoat", "KHR_texture_basisu"],
        }],
        chunks: [{ id: "chunk-0", instanceIds: ["building-0"], dependencyUris: [`sha256:${coarseMesh}`, `sha256:${mesh}`] }],
        instances: [{
            id: "building-0",
            assetUri: `sha256:${mesh}`,
            lodLevels: [`sha256:${mesh}`, `sha256:${coarseMesh}`],
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10.123456789, 0, -2.5, 1],
            chunkIds: ["chunk-0"],
            materialIds: ["brick"],
        }],
        bindings: [{ id: "binding-0", instanceId: "building-0", truthEntityId: "building-0" }],
        appearanceDependencies: [`sha256:${coarseMesh}`, `sha256:${mesh}`],
    };
}

test("visual-layer authoring normalization matches the owned golden fixture", async () => {
    const fixture = await json(ownedFixtureUrl);
    const normalized = normalizeVisualLayer(authoredLayer());
    assert.deepEqual(normalized, fixture.document);
    assert.equal(Object.is(normalized.materials[0].textures[0].transform.offset[1], -0), false);
    assert.equal(hashVisualLayer(normalized), fixture.visualLayerHash);
    assert.equal(assertVisualLayer(normalized), normalized);
    assert.deepEqual(parseVisualLayerJson(JSON.stringify(normalized)), normalized);
});

test("immutable validation rejects noncanonical order, unknown fields, invalid matrices and open graphs", async () => {
    const { document } = await json(ownedFixtureUrl);
    const reordered = structuredClone(document);
    reordered.assets.reverse();
    assert.throws(() => assertVisualLayer(reordered), /not in canonical normalized form/);

    const unknown = structuredClone(document);
    unknown.evidence = {};
    assert.throws(() => normalizeVisualLayer(unknown), /unknown field/);

    const singular = structuredClone(document);
    singular.instances[0].matrix[0] = 0;
    assert.throws(() => normalizeVisualLayer(singular), /nonsingular/);

    const missing = structuredClone(document);
    missing.assets.pop();
    assert.throws(() => normalizeVisualLayer(missing), /references missing asset/);

    const blended = structuredClone(document);
    blended.materials[0].alphaMode = "BLEND";
    assert.throws(() => normalizeVisualLayer(blended), /unsupported value/);

    const invalidFactor = structuredClone(document);
    invalidFactor.materials[0].parameters.metallicFactor = 1.1;
    assert.throws(() => normalizeVisualLayer(invalidFactor), /expected a number in \[0, 1\]/);

    const reorderedLods = structuredClone(document);
    reorderedLods.instances[0].lodLevels.reverse();
    assert.throws(() => normalizeVisualLayer(reorderedLods), /must match the primary assetUri/);

    const evidenceInDescriptor = structuredClone(document);
    evidenceInDescriptor.assets[0].role = "evidence";
    assert.throws(() => normalizeVisualLayer(evidenceInDescriptor), /unsupported value/);

    const unsupportedVersion = structuredClone(document);
    unsupportedVersion.version = 2;
    assert.throws(() => normalizeVisualLayer(unsupportedVersion), /expected cev-sim\.visual-layer version 1/);

    const unsafeCounter = structuredClone(document);
    unsafeCounter.assets[0].sizeBytes = Number.MAX_SAFE_INTEGER + 1;
    assert.throws(() => normalizeVisualLayer(unsafeCounter), /safe integer/);
    assert.deepEqual(VISUAL_ALPHA_MODES, ["MASK", "OPAQUE"]);
    assert.ok(VISUAL_MATERIAL_EXTENSIONS.includes("KHR_materials_specular"));
    assert.equal(VISUAL_MATERIAL_EXTENSIONS.includes("KHR_materials_transmission"), false);
});

test("exact JSON preserves numeric precision and rejects invalid JSON data", async () => {
    const fixture = await json(ownedFixtureUrl);
    const original = fixture.document;
    const changed = structuredClone(original);
    changed.instances[0].matrix[12] += 1e-9;
    assert.notEqual(hashVisualLayer(changed), hashVisualLayer(original));
    assert.equal(canonicalExactStringify({ value: -0 }), '{"value":0}');
    assert.equal(canonicalExactStringify({ 2: "two", 10: "ten" }), '{"10":"ten","2":"two"}');
    assert.throws(() => canonicalExactStringify({ value: Number.NaN }), /finite number/);
    assert.throws(() => canonicalExactStringify({ value: "\ud800" }), /lone surrogate/);
    const sparse = [];
    sparse.length = 1;
    assert.throws(() => canonicalExactStringify(sparse), /outside the JSON data model/);
    assert.throws(() => canonicalExactStringify({ [Symbol("hidden")]: true }), /outside the JSON data model/);
    assert.throws(() => normalizeVisualLayer({ ...authoredLayer(), chunks: [{ id: "e\u0301", instanceIds: [] }] }), /NFC/);
    assert.throws(() => parseExactJson('{"a":1,"a":2}'), /Duplicate JSON object key/);
    assert.throws(() => parseExactJson('{"a":1} trailing'), /Trailing data/);
    assert.notEqual(sha256ExactUtf8("bundle"), sha256ExactUtf8("bundle\n"));
});

function grant(id, overrides = {}) {
    return {
        id,
        kind: "owned",
        status: "active",
        ancestorIds: [],
        permissions: Object.fromEntries([
            "display", "derivatives", "machine-interpretation", "worker-access", "export", "retention",
        ].map((operation) => [operation, true])),
        obligations: { attribution: [`Credit ${id}`], requirements: [] },
        ...overrides,
    };
}

test("source policy intersects trusted ancestors and returns obligations", () => {
    const registry = new Map([
        ["owned-root", grant("owned-root")],
        ["derived", grant("derived", {
            ancestorIds: ["owned-root"],
            obligations: { attribution: ["Credit derived"], requirements: ["retain-source-id"] },
        })],
    ]);
    const decision = evaluateVisualSourcePolicy({
        sourceIds: ["derived"],
        operations: ["display", "export"],
        registry,
        atTime: "2026-09-06T00:00:00.000Z",
    });
    assert.equal(decision.allowed, true);
    assert.deepEqual(decision.evaluatedSourceIds, ["derived", "owned-root"]);
    assert.deepEqual(decision.obligations.attribution, ["Credit derived", "Credit owned-root"]);

    registry.get("owned-root").permissions.export = false;
    const denied = evaluateVisualSourcePolicy({
        sourceIds: ["derived"], operations: ["export"], registry, atTime: "2026-09-06T00:00:00.000Z",
    });
    assert.equal(denied.allowed, false);
    assert.deepEqual(denied.denials.map((entry) => entry.code), ["OPERATION_NOT_GRANTED"]);
});

test("source policy fails closed for unknown, forged, expired, revoked and restricted sources", () => {
    const registry = {
        expired: grant("expired", { expiresAt: "2026-01-01T00:00:00.000Z" }),
        revoked: grant("revoked", { status: "revoked" }),
        google: grant("google", { kind: "google-derived", permissions: { "live-preview-display": true } }),
        deduplicated: grant("deduplicated", { ancestorIds: ["google"] }),
    };
    for (const [sourceId, code] of [
        ["unknown", "SOURCE_NOT_TRUSTED"],
        ["expired", "SOURCE_EXPIRED"],
        ["revoked", "SOURCE_REVOKED"],
        ["google", "GOOGLE_GRANT_REQUIRED"],
        ["deduplicated", "GOOGLE_GRANT_REQUIRED"],
    ]) {
        const decision = evaluateVisualSourcePolicy({
            sourceIds: [sourceId], operations: ["export"], registry, atTime: "2026-09-06T00:00:00.000Z",
        });
        assert.equal(decision.allowed, false, sourceId);
        assert.ok(decision.denials.some((entry) => entry.code === code), sourceId);
    }
    assert.equal(evaluateVisualSourcePolicy({
        sourceIds: ["google"], operations: ["live-preview-display"], registry,
        atTime: "2026-09-06T00:00:00.000Z",
    }).allowed, true);
    // An imported owned flag is never consulted; only the injected registry is authoritative.
    assert.equal(evaluateVisualSourcePolicy({
        sourceIds: ["forged"], operations: ["display"], registry: {},
        atTime: "2026-09-06T00:00:00.000Z", imported: { forged: { owned: true } },
    }).allowed, false);
    assert.throws(() => evaluateVisualSourcePolicy({ registry }), /required for deterministic policy evaluation/);
});

test("VIS-12a activates identity negotiation while package declarations remain inactive", async () => {
    assert.equal(RUN_PACKAGE_PROFILE.container, "ustar");
    assert.equal(RUN_PACKAGE_PROFILE.compression, "none");
    assert.equal(RUN_PACKAGE_PROFILE.limits.archiveBytes, 8 * 1024 ** 3);
    assert.deepEqual(HEADLESS_PROTOCOL, { major: 1, minor: 3 });

    const proto = await readFile(protoUrl, "utf8");
    assert.match(proto, /repeated string identity_profiles = 12;/);
    assert.match(proto, /repeated string asset_admission_profiles = 13;/);
    assert.match(proto, /AssetAdmissionRef asset_admission = 5;/);
    assert.match(proto, /string handle = 1;/);
    assert.match(proto, /string bundle_bytes_hash = 2;/);
    assert.match(proto, /rpc AdmitRunPackage\(/);
    assert.match(proto, /rpc ReleaseAssetAdmission\(/);
});

test("legacy compatibility vectors and prospective identity cases stay frozen", async () => {
    const expected = await json(baselineUrl);
    const { resolved } = await json(new URL("tests/fixtures/visual-layer/legacy-analytic.v10.json", root));
    const bundle = {
        kind: "cev-sim.run-bundle",
        version: 1,
        exportedAt: "2026-09-06T00:00:00.000Z",
        manifest: resolved.manifest,
        resolved,
        resolvedHash: resolved.resolvedHash,
        simulationSemanticHash: resolved.simulationSemanticHash,
    };
    const bytes = canonicalStringify(bundle);
    assert.deepEqual({
        worldHash: resolved.world.hash,
        analyticRenderSceneHash: resolved.renderScene.hash,
        resolvedHash: resolved.resolvedHash,
        simulationSemanticHash: resolved.simulationSemanticHash,
        legacyBackendSelections: resolved.backendSelections,
        browserDefaultEpisodeHash: computeEpisodeHash(defaultEpisodeIdentity(resolved)),
        headlessDefaultEpisodeHash: computeEpisodeHash(normalizeEpisodeSpec(resolved)),
        canonicalBundleBytesHash: sha256ExactUtf8(bytes),
        canonicalBundleByteLength: new TextEncoder().encode(bytes).length,
        protocol: expected.protocol,
    }, {
        worldHash: expected.worldHash,
        analyticRenderSceneHash: expected.analyticRenderSceneHash,
        resolvedHash: expected.resolvedHash,
        simulationSemanticHash: expected.simulationSemanticHash,
        legacyBackendSelections: expected.legacyBackendSelections,
        browserDefaultEpisodeHash: expected.browserDefaultEpisodeHash,
        headlessDefaultEpisodeHash: expected.headlessDefaultEpisodeHash,
        canonicalBundleBytesHash: expected.canonicalBundleBytesHash,
        canonicalBundleByteLength: expected.canonicalBundleByteLength,
        protocol: expected.protocol,
    });

    const expectations = await json(expectationsUrl);
    assert.deepEqual(expectations.identityProfile, { id: "world-bound", version: 2 });
    assert.equal(expectations.cases.length, 12);
    assert.ok(expectations.cases.some((entry) => entry.id === "stale-top-level-or-nested-lock" && entry.resolution === "failure"));
    assert.ok(expectations.cases.some((entry) => entry.id === "scenario-behavior-profile-config" && entry.episode === "changes"));
});

test("visual contract import graph is kernel-safe", async () => {
    for (const url of [moduleUrl, registryUrl]) {
        const source = await readFile(url, "utf8");
        assert.doesNotMatch(source, /from ["'](?:three|react|next|node:)/);
        assert.doesNotMatch(source, /\b(?:window|document|navigator|requestAnimationFrame|WebGL)\b/);
        const script = `
for (const key of ["window", "document", "navigator", "requestAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error(key + " accessed"); } });
}
await import(${JSON.stringify(url.href)});
`;
        const result = spawnSync(process.execPath, ["--experimental-default-type=module", "--input-type=module", "-e", script], {
            cwd: new URL("../", import.meta.url),
            encoding: "utf8",
        });
        assert.equal(result.status, 0, `${url.pathname}: ${result.stderr}`);
    }
});
