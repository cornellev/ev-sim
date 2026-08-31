import { createReadStream, promises as fs } from "node:fs";
import process from "node:process";
import readline from "node:readline";

import { HeadlessEpisodeError } from "../../app/simulation/headless/HeadlessErrors.js";
import { HeadlessRunner } from "./HeadlessRunner.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { inspectTarget } from "./Inspection.js";
import { stringifyJsonProtocol } from "./JsonProtocol.js";

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
]);
const FLAG_OPTIONS = new Set(["sflog-on-failure", "no-sflog-on-failure"]);

function usage() {
    return [
        "cev-sim validate --bundle <file> [--episode <file>]",
        "cev-sim inspect <bundle|output-directory|sflog>",
        "cev-sim run --bundle <file> --output <directory> [--episode <file>] [--actions <jsonl-file>]",
        "cev-sim replay --bundle <file> --tape <file> --output <directory>",
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

async function* jsonlActions(stream, label) {
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
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
        const bundle = await readJson(options.bundle, "run bundle");
        if (command === "validate") {
            const allowed = new Set(["bundle", "episode"]);
            const unsupported = Object.keys(options).find((key) => !allowed.has(key));
            if (unsupported) throw new HeadlessRunnerError("USAGE", `validate does not accept --${unsupported}.`);
            const episodeSpec = options.episode ? await readJson(options.episode, "episode specification") : {};
            writeJson(stdout, await runner.validate(bundle, { episodeSpec }));
            return CLI_EXIT.OK;
        }
        if (!["run", "replay"].includes(command)) throw new HeadlessRunnerError("USAGE", `Unknown command ${command}.`);
        if (!options.output) throw new HeadlessRunnerError("USAGE", `--output is required for ${command}.`);
        const abortController = new AbortController();
        const onSigint = () => abortController.abort();
        process.once("SIGINT", onSigint);
        try {
            let final;
            if (command === "replay") {
                if (!options.tape) throw new HeadlessRunnerError("USAGE", "--tape is required for replay.");
                if (options.actions || options.episode) throw new HeadlessRunnerError("USAGE", "replay takes actions and episode settings from its tape.");
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
                const actionStream = options.actions ? createReadStream(options.actions) : stdin;
                final = await runner.run(bundle, {
                    episodeSpec,
                    actions: jsonlActions(actionStream, options.actions || "stdin"),
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
