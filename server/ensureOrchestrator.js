const { execFile, spawn } = require("node:child_process");
const net = require("node:net");

const API_PORT = 8090;
const PROBE_TIMEOUT_MS = 200;
const KILL_GRACE_MS = 500;

function orchOnPath() {
    return new Promise((resolve) => {
        execFile("sh", ["-c", "command -v orch"], (error, stdout) => {
            resolve(!error && Boolean(String(stdout).trim()));
        });
    });
}

function portOpen(port, host) {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host });
        let settled = false;
        const done = (open) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(PROBE_TIMEOUT_MS);
        socket.once("connect", () => done(true));
        socket.once("timeout", () => done(false));
        socket.once("error", () => done(false));
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureOrchestrator({
    lookup = orchOnPath,
    listening = () => portOpen(API_PORT, "127.0.0.1"),
    spawnOrch = spawn,
    kill = (pid, signal) => process.kill(pid, signal),
    wait = delay,
} = {}) {
    let child = null;
    let onProcessExit = null;

    const ready = (async () => {
        if (!(await lookup())) {
            console.warn("[WARNING] Orchestrator doesn't exist.");
            return;
        }
        // shortcut: two servers can both pass this probe and both spawn; upgrade if boot needs a lock.
        if (await listening()) return;
        try {
            child = spawnOrch("orch", [], { detached: true, stdio: "inherit" });
        } catch (error) {
            child = null;
            console.warn(`[WARNING] Could not start orchestrator: ${error.message}`);
            return;
        }
        if (typeof child.on === "function") {
            child.on("error", (error) => {
                console.warn(`[WARNING] Could not start orchestrator: ${error.message}`);
            });
        }
        if (typeof child.unref === "function") child.unref();
        if (!child.pid) {
            child = null;
            console.warn("[WARNING] Could not start orchestrator.");
            return;
        }
        // Detached orch is its own session, so a later process exit must signal it.
        onProcessExit = () => {
            if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
            try {
                kill(-child.pid, "SIGKILL");
            } catch {
                // Already gone.
            }
        };
        process.on("exit", onProcessExit);
        console.log("Started orchestrator (orch).");
    })();

    let stopping = null;
    return {
        stop() {
            if (stopping) return stopping;
            stopping = (async () => {
                try {
                    await ready;
                } catch (error) {
                    console.warn(`[WARNING] Orchestrator startup failed: ${error.message}`);
                }
                if (!child?.pid) return;
                const group = -child.pid;
                try {
                    kill(group, "SIGTERM");
                } catch {
                    return;
                }
                await wait(KILL_GRACE_MS);
                if (child.exitCode != null || child.signalCode != null) return;
                // A stuck process still holds 8090, so the next boot would skip orch.
                try {
                    kill(group, "SIGKILL");
                } catch {
                    // Already gone.
                }
            })().finally(() => {
                if (onProcessExit) process.removeListener("exit", onProcessExit);
            });
            return stopping;
        },
    };
}

module.exports = {
    ensureOrchestrator,
};
