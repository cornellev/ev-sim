import assert from "node:assert/strict";
import test from "node:test";

import {
    createMarketplaceHostProfile,
    evaluateMarketplaceCompatibility,
    hashMarketplaceHostProfile,
} from "../server/marketplace/client/MarketplaceCompatibility.js";

function requirements(overrides = {}) {
    return {
        cevSim: ">=0.1.0 <0.2.0",
        contracts: [{ kind: "cev-sim.plugin-package", versions: [1] }],
        platforms: [],
        architectures: [],
        runtimes: [],
        backends: [],
        features: [],
        ...overrides,
    };
}

test("MKT-07 host profiles normalize supervisor capabilities and hash deterministically", () => {
    const input = {
        version: "0.1.0",
        platform: "linux",
        architecture: "x64",
        supervisorCapabilities: {
            identityProfiles: ["world-v1", "world-v1"],
            transports: ["unix"],
            backends: [
                { kind: 7, id: "state", version: "2", available: true, features: ["packed"] },
                { kind: "gpu", id: "disabled", version: 1, available: false, features: ["ignored"] },
            ],
        },
    };
    const first = createMarketplaceHostProfile(input);
    const second = createMarketplaceHostProfile(input);
    assert.deepEqual(first.backends, [{ kind: "7", id: "state", version: 2 }]);
    assert.deepEqual(first.features, ["packed", "unix", "world-v1"]);
    assert.equal(hashMarketplaceHostProfile(first), hashMarketplaceHostProfile(second));
    assert.ok(Object.isFrozen(first));
});

test("MKT-07 compatibility evaluates every dimension with deterministic issue ordering", () => {
    const profile = createMarketplaceHostProfile({
        version: "0.1.0",
        platform: "linux",
        architecture: "x64",
        supervisorCapabilities: {
            backends: [{ kind: "physics", id: "rapier", version: 1, available: true, features: ["fixed-step"] }],
        },
    });
    assert.deepEqual(evaluateMarketplaceCompatibility(requirements(), profile), { compatible: true, issues: [] });
    const verdict = evaluateMarketplaceCompatibility(requirements({
        cevSim: ">=2.0.0",
        platforms: ["darwin"],
        architectures: ["arm64"],
        runtimes: ["browser"],
        contracts: [{ kind: "missing", versions: [9] }],
        backends: [{ kind: "physics", id: "other", version: 1 }],
        features: ["missing-feature"],
    }), profile);
    assert.equal(verdict.compatible, false);
    assert.deepEqual(verdict.issues.map((issue) => issue.code), [
        "ARCHITECTURE", "BACKEND", "CEV_SIM_VERSION", "CONTRACT", "FEATURE", "PLATFORM",
    ]);
    assert.equal(verdict.issues.some((issue) => issue.code === "RUNTIME"), false);
    assert.deepEqual(
        evaluateMarketplaceCompatibility(requirements({ runtimes: ["unsupported"] }), profile).issues.map((issue) => issue.code),
        ["RUNTIME"],
    );
});

