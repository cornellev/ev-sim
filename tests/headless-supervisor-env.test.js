import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readSupervisorConfigFromEnv } from "../server/headless/SupervisorConfig.js";

const CONFIG = {
    kind: "cev-sim.headless-supervisor-config",
    version: 1,
    renderer: {
        chromiumExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
};

async function tempRoot(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-env-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

test("a relative supervisor path in .env.local is read from the repository root", async (t) => {
    const root = await tempRoot(t);
    await fs.writeFile(path.join(root, "supervisor.json"), `${JSON.stringify(CONFIG)}\n`);
    await fs.writeFile(path.join(root, ".env.local"), "CEV_SIM_HEADLESS_SUPERVISOR_CONFIG=supervisor.json\n");
    const env = { NODE_ENV: "development" };
    const loaded = await readSupervisorConfigFromEnv(env, root);
    assert.equal(loaded.renderer.chromiumExecutable, CONFIG.renderer.chromiumExecutable);
    assert.equal(env.CEV_SIM_HEADLESS_SUPERVISOR_CONFIG, "supervisor.json");
});

test("the process environment wins over .env.local", async (t) => {
    const root = await tempRoot(t);
    const selected = path.join(root, "selected.json");
    const ignored = path.join(root, "ignored.json");
    await fs.writeFile(selected, `${JSON.stringify(CONFIG)}\n`);
    await fs.writeFile(ignored, `${JSON.stringify({
        ...CONFIG,
        renderer: { chromiumExecutable: "/ignored" },
    })}\n`);
    await fs.writeFile(path.join(root, ".env.local"), `CEV_SIM_HEADLESS_SUPERVISOR_CONFIG=${ignored}\n`);
    const loaded = await readSupervisorConfigFromEnv({
        NODE_ENV: "development",
        CEV_SIM_HEADLESS_SUPERVISOR_CONFIG: selected,
    }, root);
    assert.equal(loaded.renderer.chromiumExecutable, CONFIG.renderer.chromiumExecutable);
});

test("CEV_SIM_SUPERVISOR_CONFIG is accepted when the headless name is unset", async (t) => {
    const root = await tempRoot(t);
    const loaded = await readSupervisorConfigFromEnv({
        NODE_ENV: "development",
        CEV_SIM_SUPERVISOR_CONFIG: JSON.stringify(CONFIG),
    }, root);
    assert.equal(loaded.renderer.chromiumExecutable, CONFIG.renderer.chromiumExecutable);
});

test("a missing supervisor config path names the file it could not read", async (t) => {
    const root = await tempRoot(t);
    await assert.rejects(
        readSupervisorConfigFromEnv({
            NODE_ENV: "development",
            CEV_SIM_HEADLESS_SUPERVISOR_CONFIG: "missing-supervisor.json",
        }, root),
        /missing-supervisor\.json/,
    );
});
