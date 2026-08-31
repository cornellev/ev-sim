import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));

test("hundreds of in-place reset/replay cycles retain bounded resources", () => {
    const run = () => {
        const child = spawnSync(process.execPath, [
            "--expose-gc",
            "--experimental-default-type=module",
            path.join(testsDirectory, "helpers", "simulationResetSoakChild.js"),
        ], {
            cwd: path.dirname(testsDirectory),
            encoding: "utf8",
            timeout: 60_000,
        });
        assert.equal(child.status, 0, child.stderr || child.stdout);
        return JSON.parse(child.stdout.trim().split("\n").at(-1));
    };
    const first = run();
    const freshProcess = run();
    for (const result of [first, freshProcess]) {
        assert.equal(result.cycles, 500);
        assert.match(result.trajectoryHash, /^[a-f0-9]{64}$/);
        assert.ok(result.growthBytes < 16 * 1024 * 1024);
        assert.ok(result.signalCount < 100);
    }
    assert.equal(freshProcess.trajectoryHash, first.trajectoryHash);
});
