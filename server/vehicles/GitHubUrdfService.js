/**
 * Inspect and fetch a public GitHub URDF package.
 * Neither operation creates a vehicle or publishes assets.
 */

import { collectUrdfClosure } from "../../app/vehicles/urdf/github/collectUrdfClosure.js";
import { GitHubUrdfError } from "../../app/vehicles/urdf/github/errors.js";
import { githubReview } from "../../app/vehicles/urdf/github/githubSource.js";
import { githubCredentialIssue, parseGitHubVehicleUrl } from "../../app/vehicles/urdf/github/parseGitHubUrl.js";
import { rankUrdfCandidates, selectUrdfCandidate } from "../../app/vehicles/urdf/github/rankUrdfCandidates.js";
import { urdfIssue } from "../../app/vehicles/urdf/issue.js";
import { GitHubUrdfCache, GitHubUrdfClient, githubFailureIssue } from "./GitHubUrdfClient.js";

function emptyResult(diagnostics, extra = {}) {
    return {
        ok: false,
        review: null,
        candidates: [],
        selectionRequired: false,
        diagnostics,
        package: null,
        ...extra,
    };
}

function prefixExists(entries, prefix) {
    if (!prefix) return true;
    const own = entries.get(prefix);
    if (own?.type === "tree") return true;
    const needle = `${prefix}/`;
    for (const path of entries.keys()) {
        if (path.startsWith(needle)) return true;
    }
    return false;
}

function locate(pin, entries) {
    if (!pin.path) return { prefix: "", namedPath: null, error: null };
    const entry = entries.get(pin.path);
    if (entry?.type === "blob" || pin.kind === "blob" || pin.kind === "raw") {
        if (!entry || entry.type !== "blob") {
            return {
                prefix: "",
                namedPath: null,
                error: urdfIssue("vehicle.github.missing-path", pin.path, `Path "${pin.path}" is not in the pinned tree.`),
            };
        }
        return { prefix: "", namedPath: pin.path, error: null };
    }
    if (!prefixExists(entries, pin.path)) {
        return {
            prefix: "",
            namedPath: null,
            error: urdfIssue("vehicle.github.missing-path", pin.path, `Path "${pin.path}" is not in the pinned tree.`),
        };
    }
    return { prefix: pin.path, namedPath: null, error: null };
}

export function encodeGitHubResult(result) {
    if (!result?.package?.files) return result;
    return {
        ...result,
        package: {
            entryPath: result.package.entryPath,
            source: result.package.source,
            diagnostics: result.package.diagnostics,
            files: result.package.files.map((file) => ({
                path: file.path,
                size: file.bytes.byteLength,
                bytes: Buffer.from(file.bytes).toString("base64"),
            })),
        },
    };
}

export class GitHubUrdfService {
    constructor({ fetchImpl = globalThis.fetch, cache = new GitHubUrdfCache(), now = () => Date.now() } = {}) {
        this.fetchImpl = fetchImpl;
        this.cache = cache;
        this.now = now;
    }

    #client(signal) {
        return new GitHubUrdfClient({
            fetchImpl: this.fetchImpl,
            cache: this.cache,
            now: this.now,
            signal,
        });
    }

    async #prepare({ url, body, signal, entryPath = null }) {
        const credential = githubCredentialIssue(body);
        if (credential) throw new GitHubUrdfError(credential.code, credential.message, { path: credential.path });
        const parsed = parseGitHubVehicleUrl(url);
        if (!parsed.ok) return emptyResult(parsed.diagnostics);
        const client = this.#client(signal);
        let pin;
        let tree;
        try {
            pin = await client.pin(parsed.url);
            tree = await client.tree(pin);
        } catch (error) {
            const issue = githubFailureIssue(error);
            return emptyResult([issue], { review: null });
        }
        const located = locate(pin, tree.entries);
        if (located.error) {
            return emptyResult([located.error], {
                review: githubReview({ ...pin, selectedPath: null, rateLimit: client.rateLimit }),
            });
        }
        const ranked = rankUrdfCandidates([...tree.entries.values()], {
            prefix: located.prefix,
            namedPath: located.namedPath,
        });
        const selected = selectUrdfCandidate(ranked, entryPath);
        return {
            ok: selected.diagnostics.length === 0,
            client,
            pin,
            tree,
            candidates: ranked.candidates,
            selectionRequired: selected.selectionRequired,
            selected: selected.selected,
            diagnostics: selected.diagnostics,
            review: githubReview({
                ...pin,
                selectedPath: selected.selected,
                rateLimit: client.rateLimit,
            }),
            package: null,
        };
    }

    async inspect(input) {
        try {
            const prepared = await this.#prepare(input);
            return {
                ok: prepared.ok,
                review: prepared.review,
                candidates: prepared.candidates,
                selectionRequired: prepared.selectionRequired,
                diagnostics: prepared.diagnostics,
                package: null,
            };
        } catch (error) {
            if (error instanceof GitHubUrdfError) throw error;
            const issue = githubFailureIssue(error);
            return emptyResult([issue]);
        }
    }

    async fetch(input) {
        const prepared = await this.#prepare(input);
        if (!prepared.selected) {
            return {
                ok: false,
                review: prepared.review,
                candidates: prepared.candidates,
                selectionRequired: prepared.selectionRequired,
                diagnostics: prepared.diagnostics,
                package: null,
            };
        }
        try {
            const closure = await collectUrdfClosure({
                entryPath: prepared.selected,
                index: prepared.tree.entries,
                readFile: (filePath, entry) => prepared.client.blob(prepared.pin, entry ?? prepared.tree.entries.get(filePath)),
                source: prepared.client.source(prepared.pin, prepared.selected),
                signal: input.signal ?? null,
            });
            return {
                ok: closure.ok,
                review: prepared.review,
                candidates: prepared.candidates,
                selectionRequired: false,
                diagnostics: closure.diagnostics,
                package: closure.package,
            };
        } catch (error) {
            const issue = githubFailureIssue(error);
            return {
                ok: false,
                review: prepared.review,
                candidates: prepared.candidates,
                selectionRequired: false,
                diagnostics: [issue],
                package: null,
            };
        }
    }
}
