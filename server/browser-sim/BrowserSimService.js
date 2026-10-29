import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
    BROWSER_SIM_ACTIONS,
    BROWSER_SIM_TIMEOUT_MS,
    assertBrowserSimCommand,
    browserSimError,
} from "../../app/simulation/BrowserSimControl.js";
import { storageEvents } from "../mcp/events.js";

const Id = z.string().trim().min(1).max(200);
const Nanoseconds = z.string().regex(/^(0|[1-9][0-9]*)$/).max(30);
const Snapshot = z.object({
    status: z.string().max(80),
    runId: Id.nullable().default(null),
    manifestId: Id.nullable().default(null),
    manifestRevision: z.number().int().nonnegative().nullable().default(null),
    resolvedHash: z.string().max(128).nullable().default(null),
    step: z.number().int().nonnegative().safe().default(0),
    timeNs: Nanoseconds.default("0"),
    stepNs: Nanoseconds.default("0"),
    degraded: z.boolean().default(false),
    error: z.string().max(4096).nullable().default(null),
    transitioning: z.boolean().default(false),
    experimentActive: z.boolean().default(false),
    navigationBlocked: z.boolean().default(false),
    runResult: z.object({
        runId: Id.nullable(),
        status: z.string().max(80),
        completed: z.boolean(),
        passed: z.boolean(),
        logId: Id.nullable(),
        terminationReason: z.string().max(200).nullable(),
        step: z.number().int().nonnegative().safe(),
        timeNs: Nanoseconds,
    }).nullable().default(null),
});
const Command = z.object({
    action: z.enum(BROWSER_SIM_ACTIONS),
    browserId: Id.optional(),
    manifestId: Id.optional(),
    runId: Id.optional(),
    autoplay: z.boolean().optional(),
    requestId: Id.optional(),
}).strict().superRefine((value, ctx) => {
    const field = value.action === "start" ? "manifestId" : "runId";
    if (!value[field]) ctx.addIssue({ code: "custom", path: [field], message: `${field} is required.` });
    if (value.action !== "start" && (value.manifestId !== undefined || value.autoplay !== undefined)) {
        ctx.addIssue({ code: "custom", message: "manifestId and autoplay apply only to start." });
    }
    if (value.action === "start" && value.runId !== undefined) {
        ctx.addIssue({ code: "custom", message: "runId does not apply to start." });
    }
});
const Sequence = z.number().int().nonnegative().safe();
const Report = z.object({ snapshot: Snapshot, activity: Sequence, sequence: Sequence });
const Completion = z.object({
    claimId: Id,
    sequence: Sequence,
    snapshot: Snapshot,
    error: z.object({ code: z.string().min(1).max(100), message: z.string().max(4096) }).nullable(),
});
const TERMINAL = new Set(["succeeded", "failed", "unknown"]);
const RETENTION_MS = 10 * 60_000;
const COMMAND_WAIT_MS = 60_000;

function parse(schema, input) {
    const result = schema.safeParse(input);
    if (!result.success) throw browserSimError("INVALID_REQUEST", result.error.issues.map((issue) => issue.message).join(" "), 400);
    return result.data;
}

/** One process owns live tabs and bounded, non-durable command receipts. */
export class BrowserSimService {
    constructor(storage, { events = storageEvents, now = Date.now, maxBrowsers = 32, maxCommands = 256 } = {}) {
        this.storage = storage;
        this.events = events;
        this.now = now;
        this.maxBrowsers = maxBrowsers;
        this.maxCommands = maxCommands;
        this.browsers = new Map();
        this.commands = new Map();
        this.sequence = 0;
    }

    register(input) {
        const report = parse(Report, input);
        this._expire();
        if (this.browsers.size >= this.maxBrowsers) {
            const stale = [...this.browsers.values()].find((browser) => !this._connected(browser));
            if (stale) this.browsers.delete(stale.browserId);
            else throw browserSimError("CAPACITY", "Too many simulator tabs are connected.", 503);
        }
        const browser = {
            browserId: randomUUID(),
            token: randomUUID(),
            registeredOrder: ++this.sequence,
            lastSeenAt: this.now(),
            activity: 0,
            interactionOrder: 0,
            lastInteractionAt: null,
            commandId: null,
            reportSequence: -1,
        };
        this.browsers.set(browser.browserId, browser);
        this._report(browser, report);
        return { browserId: browser.browserId, token: browser.token };
    }

    heartbeat(browserId, token, input) {
        const report = parse(Report, input);
        this._expire();
        const browser = this._authenticate(browserId, token);
        this._report(browser, report);
        const command = this.commands.get(browser.commandId);
        return {
            browserId,
            command: command && ["accepted", "running"].includes(command.state) && command.ready
                ? { commandId: command.commandId, browserId }
                : null,
        };
    }

    unregister(browserId, token) {
        const browser = this._authenticate(browserId, token);
        browser.lastSeenAt = this.now() - BROWSER_SIM_TIMEOUT_MS;
        this._expire();
        this.browsers.delete(browserId);
        return { browserId };
    }

    list() {
        this._expire();
        const selected = this._defaultBrowser();
        return {
            browserId: selected?.browserId ?? null,
            browsers: [...this.browsers.values()].map((browser) => ({
                ...this._status(browser),
                isDefault: browser === selected,
            })),
        };
    }

    status(browserId) {
        this._expire();
        return this._status(this._select(browserId));
    }

    submit(input) {
        const request = parse(Command, input);
        const normalized = { ...request, ...(request.action === "start" ? { autoplay: request.autoplay ?? true } : {}) };
        const fingerprint = JSON.stringify(Object.keys(normalized).sort().map((key) => [key, normalized[key]]));
        this._expire();
        if (request.requestId) {
            const previous = [...this.commands.values()].find((command) => command.request.requestId === request.requestId);
            if (previous) {
                if (previous.fingerprint !== fingerprint) throw browserSimError("REQUEST_ID_CONFLICT", "requestId was already used with different arguments.");
                return this._receipt(previous);
            }
        }
        const browser = this._select(request.browserId);
        if (browser.commandId) throw browserSimError("BUSY", "Another command is active in this tab.");
        assertBrowserSimCommand(normalized, browser.snapshot);
        if (this.commands.size >= this.maxCommands) {
            const old = [...this.commands.values()].find((command) => TERMINAL.has(command.state) && this.browsers.get(command.browserId)?.commandId !== command.commandId);
            if (old) this.commands.delete(old.commandId);
            else throw browserSimError("CAPACITY", "The browser command registry is full.", 503);
        }
        const command = {
            commandId: randomUUID(),
            browserId: browser.browserId,
            request: normalized,
            fingerprint,
            state: "accepted",
            createdAt: this.now(),
            updatedAt: this.now(),
            ready: false,
            claimId: null,
            error: null,
            snapshot: null,
            resolved: null,
        };
        this.commands.set(command.commandId, command);
        browser.commandId = command.commandId;
        this._prepare(command, browser.snapshot.manifestId);
        return this._receipt(command);
    }

    get(commandId) {
        this._expire();
        return this._receipt(this._command(commandId));
    }

    claim(browserId, token, commandId, input) {
        const { claimId } = parse(z.object({ claimId: Id }), input);
        this._authenticate(browserId, token);
        this._expire();
        const command = this._command(commandId);
        if (command.browserId !== browserId) throw browserSimError("WRONG_BROWSER", "This command belongs to another tab.");
        if (!command.ready || (command.state !== "accepted" && !(command.state === "running" && command.claimId === claimId))) {
            throw browserSimError("COMMAND_NOT_PENDING", "This command cannot be claimed.");
        }
        command.claimId = claimId;
        command.state = "running";
        command.updatedAt = this.now();
        return { ...this._receipt(command), ...command.request, browserId, resolved: command.resolved, manifestRevision: command.manifestRevision ?? null };
    }

    complete(browserId, token, commandId, input) {
        const completion = parse(Completion, input);
        const browser = this._authenticate(browserId, token);
        const command = this._command(commandId);
        if (command.browserId !== browserId || command.claimId !== completion.claimId) {
            throw browserSimError("WRONG_CLAIM", "The command was not claimed by this browser execution.");
        }
        if (["succeeded", "failed"].includes(command.state)) return this._receipt(command);
        command.state = completion.error ? "failed" : "succeeded";
        command.error = completion.error;
        command.snapshot = completion.snapshot;
        command.updatedAt = this.now();
        command.resolved = null;
        this._reportSnapshot(browser, completion);
        browser.lastSeenAt = this.now();
        if (browser.commandId === commandId) browser.commandId = null;
        return this._receipt(command);
    }

    async _prepare(command, manifestId) {
        try {
            if (["start", "reset"].includes(command.request.action)) {
                const id = command.request.manifestId ?? manifestId;
                const source = await this.storage.getRunManifest(id);
                if (!source) throw browserSimError("MANIFEST_NOT_FOUND", `Run manifest "${id}" does not exist.`, 404);
                command.manifestRevision = source.revision ?? null;
                command.resolved = await this.storage.resolveRunManifest(id, { manifest: source });
            }
            this._expire();
            if (command.state !== "accepted") {
                command.resolved = null;
                return;
            }
            command.ready = true;
            this.events.publish({ domain: "browser-sim", id: command.browserId, action: "command", data: { commandId: command.commandId } });
        } catch (error) {
            if (command.state !== "accepted") return;
            this._finishUnavailable(command, "failed", error.code ?? "MANIFEST_RESOLUTION_FAILED", error.message);
        }
    }

    _connected(browser) {
        return this.now() - browser.lastSeenAt < BROWSER_SIM_TIMEOUT_MS;
    }

    _defaultBrowser() {
        return [...this.browsers.values()].filter((browser) => this._connected(browser))
            .sort((a, b) => b.interactionOrder - a.interactionOrder || b.registeredOrder - a.registeredOrder)[0];
    }

    _select(browserId) {
        if (browserId !== undefined) parse(Id, browserId);
        const browser = browserId === undefined ? this._defaultBrowser() : this.browsers.get(browserId);
        if (!browser || !this._connected(browser)) throw browserSimError("BROWSER_UNAVAILABLE", "No responsive simulator tab is available for this target.", 503);
        return browser;
    }

    _status(browser) {
        return {
            browserId: browser.browserId,
            connected: this._connected(browser),
            lastSeenAt: new Date(browser.lastSeenAt).toISOString(),
            lastInteractionAt: browser.lastInteractionAt === null ? null : new Date(browser.lastInteractionAt).toISOString(),
            interactionOrder: browser.interactionOrder,
            commandId: browser.commandId,
            ...browser.snapshot,
        };
    }

    _report(browser, report) {
        this._reportSnapshot(browser, report);
        browser.lastSeenAt = this.now();
        if (report.activity > browser.activity) {
            browser.activity = report.activity;
            browser.interactionOrder = ++this.sequence;
            browser.lastInteractionAt = this.now();
        }
    }

    _reportSnapshot(browser, report) {
        // Completion and heartbeat requests can arrive on different HTTP connections.
        if (report.sequence > browser.reportSequence) {
            browser.snapshot = report.snapshot;
            browser.reportSequence = report.sequence;
        }
    }

    _authenticate(browserId, token) {
        const browser = this.browsers.get(browserId);
        if (!browser) throw browserSimError("BROWSER_NOT_REGISTERED", "Register this page with the current server first.", 404);
        if (browser.token !== token) throw browserSimError("INVALID_BROWSER_TOKEN", "Invalid browser bridge token.", 403);
        return browser;
    }

    _command(commandId) {
        const command = this.commands.get(commandId);
        if (!command) throw browserSimError("COMMAND_NOT_FOUND", "This command receipt has expired or the server restarted.", 404);
        return command;
    }

    _receipt(command) {
        return {
            commandId: command.commandId,
            browserId: command.browserId,
            action: command.request.action,
            state: command.state,
            createdAt: new Date(command.createdAt).toISOString(),
            updatedAt: new Date(command.updatedAt).toISOString(),
            error: command.error,
            snapshot: command.snapshot,
        };
    }

    _finishUnavailable(command, state, code, message) {
        command.state = state;
        command.error = { code, message };
        command.updatedAt = this.now();
        command.resolved = null;
        const browser = this.browsers.get(command.browserId);
        if (state === "failed" && browser?.commandId === command.commandId) browser.commandId = null;
    }

    _expire() {
        for (const command of this.commands.values()) {
            const browser = this.browsers.get(command.browserId);
            if (!TERMINAL.has(command.state)) {
                if (!browser || !this._connected(browser)) {
                    this._finishUnavailable(command, command.state === "running" ? "unknown" : "failed", "BROWSER_UNAVAILABLE", "The target tab disconnected; the command will not be replayed.");
                } else if (command.state === "accepted" && this.now() - command.createdAt >= COMMAND_WAIT_MS) {
                    this._finishUnavailable(command, "failed", "COMMAND_EXPIRED", "The browser did not claim this command within 60 seconds.");
                }
            }
            if (TERMINAL.has(command.state) && this.now() - command.updatedAt >= RETENTION_MS
                && (browser?.commandId !== command.commandId || this.now() - browser.lastSeenAt >= RETENTION_MS)) {
                if (browser?.commandId === command.commandId) browser.commandId = null;
                this.commands.delete(command.commandId);
            }
        }
        for (const browser of this.browsers.values()) {
            if (this.now() - browser.lastSeenAt >= RETENTION_MS) this.browsers.delete(browser.browserId);
        }
    }
}
