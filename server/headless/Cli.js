import { createReadStream, promises as fs } from "node:fs";
import process from "node:process";
import readline from "node:readline";

import { HeadlessEpisodeError } from "../../app/simulation/headless/HeadlessErrors.js";
import { canonicalRunBundleStringify, verifyRunBundleBytes } from "./RunBundle.js";
import { HEADLESS_PROTOCOL } from "./HeadlessProtocol.js";
import { HeadlessRunner } from "./HeadlessRunner.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { inspectTarget } from "./Inspection.js";
import { stringifyJsonProtocol } from "./JsonProtocol.js";
import { createHeadlessSmokeBundle } from "./SmokeBundle.js";
import { readSupervisorConfig } from "./SupervisorConfig.js";
import { SupervisorRunner } from "./SupervisorRunner.js";
import { startHeadlessSupervisor } from "./SupervisorServer.js";
import { validateBundleWithSupervisor } from "./SupervisorValidation.js";
import { runGpuPreflight } from "./GpuPreflight.js";

export const CLI_EXIT = Object.freeze({
    OK: 0,
    SEMANTIC_FAILURE: 1,
    USAGE: 2,
    INVALID_INPUT: 3,
    ARTIFACT_FAILURE: 4,
    INTERNAL: 5,
    INTERRUPTED: 130,
});

const VALUE_OPTIONS = new Set([
    "bundle", "episode", "output", "actions", "tape", "artifact-profile", "sflog-sample-rate",
    "socket", "tcp", "preset", "config",
]);
const FLAG_OPTIONS = new Set(["sflog-on-failure", "no-sflog-on-failure", "allow-remote-tcp"]);

function usage() {
    return [
        "cev-sim validate --bundle <file> [--episode <file>] [--config <supervisor.json>]",
        "cev-sim create-smoke-bundle --output <bundle.json>",
        "cev-sim inspect <bundle|output-directory|sflog>",
        "cev-sim run --bundle <file> --output <directory> [--episode <file>] [--actions <jsonl-file>] [--config <supervisor.json>]",
        "cev-sim replay --bundle <file> --tape <file> --output <directory>",
        "cev-sim supervisor (--socket <path> | --tcp <host:port>) [--preset safety|permissive] [--config <json>] [--allow-remote-tcp]",
        "cev-sim gpu-preflight --config <json>",
    ].join("\n");
}

function parseArguments(argv) {
    const command = argv[0];
    if (!command || command === "--help" || command === "-h") return { help: true };
    const options = {};
    const positional = [];
    for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index];
        if (!arg.startsWith("--")) {
            positional.push(arg);
            continue;
        }
        const key = arg.slice(2);
        if (FLAG_OPTIONS.has(key)) {
            options[key] = true;
            continue;
        }
        if (!VALUE_OPTIONS.has(key)) throw new HeadlessRunnerError("USAGE", `Unknown option --${key}.`);
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) throw new HeadlessRunnerError("USAGE", `Option --${key} requires a value.`);
        options[key] = value;
        index += 1;
    }
    return { command, options, positional };
}

async function readJson(filePath, label) {
    if (!filePath) throw new HeadlessRunnerError("USAGE", `${label} is required.`);
    try {
        return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
        throw new HeadlessRunnerError("INVALID_REQUEST", `Could not read ${label} ${filePath}: ${error.message}`, null, { cause: error });
    }
}

async function* jsonlActions(stream, label, signal = null) {
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const onAbort = () => lines.close();
    if (signal?.aborted) lines.close();
    else signal?.addEventListener("abort", onAbort, { once: true });
    let lineNumber = 0;
    try {
        for await (const line of lines) {
            lineNumber += 1;
            if (!line.trim()) continue;
            try {
                yield JSON.parse(line);
            } catch (error) {
                throw new HeadlessRunnerError("INVALID_REQUEST", `Invalid JSON action at ${label}:${lineNumber}: ${error.message}`, null, { cause: error });
            }
        }
    } catch (error) {
        if (error instanceof HeadlessRunnerError) throw error;
        throw new HeadlessRunnerError("INVALID_REQUEST", `Could not read actions from ${label}: ${error.message}`, null, { cause: error });
    } finally {
        signal?.removeEventListener("abort", onAbort);
        lines.close();
    }
}

function artifactPolicy(options) {
    const profile = options["artifact-profile"];
    const sampleValue = options["sflog-sample-rate"];
    const failure = options["no-sflog-on-failure"] ? false : options["sflog-on-failure"] ? true : undefined;
    return {
        ...(profile ? { profile } : {}),
        ...(sampleValue !== undefined ? { fullSflogSampleRate: Number(sampleValue) } : {}),
        ...(failure !== undefined ? { fullSflogOnFailure: failure } : {}),
        outputUri: options.output,
    };
}

function exitForError(error) {
    if (error instanceof HeadlessRunnerError) {
        if (error.code === "USAGE") return CLI_EXIT.USAGE;
        if (error.code === "ARTIFACT_FAILURE") return CLI_EXIT.ARTIFACT_FAILURE;
        if (["INVALID_REQUEST", "BUNDLE_INVALID", "BUNDLE_HASH_MISMATCH", "UNSUPPORTED_CAPABILITY", "INCOMPATIBLE_SPACE"].includes(error.code)) {
            return CLI_EXIT.INVALID_INPUT;
        }
    }
    if (error instanceof HeadlessEpisodeError) return CLI_EXIT.INVALID_INPUT;
    return CLI_EXIT.INTERNAL;
}

export async function main(argv = process.argv.slice(2), io = {}) {
    const stdout = io.stdout ?? process.stdout;
    const stderr = io.stderr ?? process.stderr;
    const stdin = io.stdin ?? process.stdin;
    const writeJson = (stream, value) => stream.write(`${stringifyJsonProtocol(value)}\n`);
    let parsed;
    try {
        parsed = parseArguments(argv);
        if (parsed.help) {
            stdout.write(`${usage()}\n`);
            return CLI_EXIT.OK;
        }
        const { command, options, positional } = parsed;
        if (command === "gpu-preflight") {
            if (positional.length > 0 || !options.config || Object.keys(options).length !== 1) {
                throw new HeadlessRunnerError("USAGE", "gpu-preflight requires exactly --config <json>.");
            }
            const config = await readSupervisorConfig(options.config);
            writeJson(stdout, await runGpuPreflight(config.renderer || {}));
            return CLI_EXIT.OK;
        }
        if (command === "supervisor") {
            if (positional.length > 0) throw new HeadlessRunnerError("USAGE", "supervisor does not accept positional arguments.");
            const allowed = new Set(["socket", "tcp", "preset", "config", "allow-remote-tcp"]);
            const unsupported = Object.keys(options).find((key) => !allowed.has(key));
            if (unsupported) throw new HeadlessRunnerError("USAGE", `supervisor does not accept --${unsupported}.`);
            const config = options.config ? await readSupervisorConfig(options.config) : null;
            const running = await startHeadlessSupervisor({
                ...(config ? { config } : {}),
                ...(options.socket ? { socket: options.socket } : {}),
                ...(options.tcp ? { tcp: options.tcp } : {}),
                ...(options.preset ? { preset: options.preset } : {}),
                ...(options["allow-remote-tcp"] ? { allowRemoteTcp: true } : {}),
            });
            writeJson(stdout, {
                kind: "cev-sim.headless.supervisor-listening",
                version: 1,
                protocol: HEADLESS_PROTOCOL,
                address: running.address,
                transport: running.config.listener.kind,
            });
            await new Promise((resolve) => {
                const stop = () => resolve();
                process.once("SIGINT", stop);
                process.once("SIGTERM", stop);
            });
            await running.close();
            return CLI_EXIT.OK;
        }
        if (command === "create-smoke-bundle") {
            if (positional.length > 0 || !options.output || Object.keys(options).length !== 1) {
                throw new HeadlessRunnerError("USAGE", "create-smoke-bundle requires exactly --output <bundle.json>.");
            }
            const createBundle = io.smokeBundleFactory ?? createHeadlessSmokeBundle;
            const bundle = await createBundle();
            try {
                await fs.writeFile(options.output, canonicalRunBundleStringify(bundle));
            } catch (error) {
                throw new HeadlessRunnerError(
                    "ARTIFACT_FAILURE",
                    `Could not write smoke bundle ${options.output}: ${error.message}`,
                    null,
                    { cause: error },
                );
            }
            writeJson(stdout, {
                kind: "cev-sim.headless.smoke-bundle",
                version: 1,
                output: options.output,
                manifestId: bundle.resolved.manifest.id,
                scenarioId: bundle.resolved.scenario.scenario.id,
                resolvedHash: bundle.resolvedHash,
                simulationSemanticHash: bundle.simulationSemanticHash,
            });
            return CLI_EXIT.OK;
        }
        const runner = io.runner ?? new HeadlessRunner();
        if (command === "inspect") {
            if (positional.length !== 1 || Object.keys(options).length > 0) {
                throw new HeadlessRunnerError("USAGE", "inspect requires exactly one target.");
            }
            writeJson(stdout, await inspectTarget(positional[0]));
            return CLI_EXIT.OK;
        }
        if (!options.bundle) throw new HeadlessRunnerError("USAGE", `--bundle is required for ${command}.`);
        if (positional.length > 0) throw new HeadlessRunnerError("USAGE", `Unexpected positional argument: ${positional[0]}`);
        const { bundle } = verifyRunBundleBytes(await fs.readFile(options.bundle));
        if (command === "validate") {
            const allowed = new Set(["bundle", "episode", "config"]);
            const unsupported = Object.keys(options).find((key) => !allowed.has(key));
            if (unsupported) throw new HeadlessRunnerError("USAGE", `validate does not accept --${unsupported}.`);
            const episodeSpec = options.episode ? await readJson(options.episode, "episode specification") : {};
            if (options.config) {
                const config = await readSupervisorConfig(options.config);
                const supervisorValidator = io.supervisorValidator ?? validateBundleWithSupervisor;
                writeJson(stdout, await supervisorValidator(bundle, { config, episodeSpec }));
            } else {
                writeJson(stdout, await runner.validate(bundle, { episodeSpec }));
            }
            return CLI_EXIT.OK;
        }
        if (!["run", "replay"].includes(command)) throw new HeadlessRunnerError("USAGE", `Unknown command ${command}.`);
        if (!options.output) throw new HeadlessRunnerError("USAGE", `--output is required for ${command}.`);
        const abortController = new AbortController();
        let actionStream = null;
        const onSigint = () => abortController.abort();
        process.once("SIGINT", onSigint);
        try {
            let final;
            if (command === "replay") {
                if (!options.tape) throw new HeadlessRunnerError("USAGE", "--tape is required for replay.");
                if (options.actions || options.episode || options.config) {
                    throw new HeadlessRunnerError("USAGE", "replay takes actions and episode settings from its tape and does not accept --config.");
                }
                const tape = await readJson(options.tape, "policy action tape");
                final = await runner.replay(bundle, tape, {
                    artifactPolicy: artifactPolicy(options),
                    outputUri: options.output,
                    signal: abortController.signal,
                    onEvent: (event) => writeJson(stdout, event),
                });
            } else {
                if (options.tape) throw new HeadlessRunnerError("USAGE", "run does not accept --tape; use replay.");
                if (!options.actions && stdin.isTTY) {
                    throw new HeadlessRunnerError("USAGE", "run requires --actions or JSONL actions on stdin.");
                }
                const episodeSpec = options.episode ? await readJson(options.episode, "episode specification") : {};
                actionStream = options.actions ? createReadStream(options.actions) : stdin;
                const configured = options.config ? await readSupervisorConfig(options.config) : null;
                const executionRunner = configured
                    ? (io.supervisorRunner ?? new SupervisorRunner())
                    : runner;
                final = await executionRunner.run(bundle, {
                    ...(configured ? { config: configured } : {}),
                    episodeSpec,
                    actions: jsonlActions(actionStream, options.actions || "stdin", abortController.signal),
                    artifactPolicy: artifactPolicy(options),
                    outputUri: options.output,
                    signal: abortController.signal,
                    onEvent: (event) => writeJson(stdout, event),
                });
            }
            if (abortController.signal.aborted || final.result.interruptedBySignal) return CLI_EXIT.INTERRUPTED;
            return final.result.passed ? CLI_EXIT.OK : CLI_EXIT.SEMANTIC_FAILURE;
        } finally {
            process.removeListener("SIGINT", onSigint);
        }
    } catch (error) {
        writeJson(stderr, {
            kind: "cev-sim.headless.error",
            version: 1,
            code: error.code || "INTERNAL",
            message: error.message,
            details: error.details ?? null,
        });
        if (exitForError(error) === CLI_EXIT.USAGE) stderr.write(`${usage()}\n`);
        return exitForError(error);
    }
}
