import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CEV_SIM_VERSION, isMajorZeroVersion } from "../app/version.js";
import { PluginHost } from "../app/plugin/PluginHost.js";
import { PluginRunSession } from "../app/plugin/PluginRunSession.js";
import { RUN_MANIFEST_VERSION } from "../app/simulation/RunManifest.js";
import { createSensorFusionMcpServer } from "../server/mcp/createMcpRouter.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("CEV_SIM_VERSION matches coordinated package authorities", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
    const pluginJson = JSON.parse(await fs.readFile(path.join(ROOT, "plugin.json"), "utf8"));
    const pyproject = await fs.readFile(path.join(ROOT, "python/pyproject.toml"), "utf8");
    const pythonInit = await fs.readFile(path.join(ROOT, "python/src/cev_sim/__init__.py"), "utf8");
    assert.equal(CEV_SIM_VERSION, packageJson.version);
    assert.equal(CEV_SIM_VERSION, pluginJson.version);
    assert.match(pyproject, new RegExp(`^version\\s*=\\s*"${CEV_SIM_VERSION}"`, "m"));
    assert.match(pythonInit, new RegExp(`^__version__\\s*=\\s*"${CEV_SIM_VERSION}"`, "m"));
});

test("plugin hosts default simulatorVersion to CEV_SIM_VERSION", () => {
    assert.equal(new PluginHost().simulatorVersion, CEV_SIM_VERSION);
    assert.equal(new PluginRunSession({ moduleSource: null }).simulatorVersion, CEV_SIM_VERSION);
});

test("MCP server advertises CEV_SIM_VERSION", () => {
    const server = createSensorFusionMcpServer({}, {});
    assert.equal(server.server._serverInfo.version, CEV_SIM_VERSION);
});

test("major-zero detection covers the current alpha line", () => {
    assert.equal(isMajorZeroVersion("0.1.0"), true);
    assert.equal(isMajorZeroVersion("0.2.0"), true);
    assert.equal(isMajorZeroVersion("1.0.0"), false);
});

test("startup warns for every major-zero build", async () => {
    const text = await fs.readFile(path.join(ROOT, "server/startup.js"), "utf8");
    assert.match(text, /isMajorZeroVersion/);
    assert.doesNotMatch(text, /version === ['"]0\.1\.0['"]/);
});

test("release dist metadata tracks RUN_MANIFEST_VERSION", async () => {
    const source = await fs.readFile(path.join(ROOT, "scripts/build-headless-dist.mjs"), "utf8");
    assert.match(source, /RUN_MANIFEST_VERSION/);
    assert.doesNotMatch(source, /manifestVersion:\s*9\b/);
    assert.equal(RUN_MANIFEST_VERSION, 11);
});
