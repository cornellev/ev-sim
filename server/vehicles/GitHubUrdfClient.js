/**
 * Public api.github.com client for one acquisition.
 * Trees and blobs are cached by immutable SHA. No credentials are sent.
 */

import { GitHubUrdfError } from "../../app/vehicles/urdf/github/errors.js";
import { gitBlobSizeIssue, gitTreeIssue, isGitLfsPointer } from "../../app/vehicles/urdf/github/gitTree.js";
import { githubSource } from "../../app/vehicles/urdf/github/githubSource.js";
import { GITHUB_URDF_LIMITS, githubRequestLimit } from "../../app/vehicles/urdf/github/limits.js";
import { splitGitHubRef } from "../../app/vehicles/urdf/github/parseGitHubUrl.js";
import { urdfIssue } from "../../app/vehicles/urdf/issue.js";

const API_ORIGIN = "https://api.github.com";
const PRIVATE_MESSAGE = "The repository is not a public GitHub repository.";

function headerValue(headers, name) {
    return headers?.get?.(name) ?? null;
}

function rateLimitFrom(headers) {
    const number = (name) => {
        const value = Number(headerValue(headers, name));
        return Number.isFinite(value) ? value : null;
    };
    return {
        limit: number("x-ratelimit-limit"),
        remaining: number("x-ratelimit-remaining"),
        reset: number("x-ratelimit-reset"),
        resource: headerValue(headers, "x-ratelimit-resource"),
    };
}

function rateLimitError(rateLimit) {
    const reset = rateLimit?.reset == null ? "an unknown time" : new Date(rateLimit.reset * 1000).toISOString();
    return new GitHubUrdfError("vehicle.github.rate-limit", `GitHub rate limit resets at ${reset}.`);
}

function licenseFrom(repo) {
    const license = repo?.license;
    if (!license) return { status: "none", spdxId: null, name: null };
    const spdxId = license.spdx_id ?? null;
    if (spdxId && spdxId !== "NOASSERTION") return { status: "spdx", spdxId, name: license.name ?? null };
    return { status: "other", spdxId: spdxId === "NOASSERTION" ? "NOASSERTION" : null, name: license.name ?? null };
}

export class GitHubUrdfCache {
    constructor({ maxTrees = 32, maxBlobs = 256, maxBlobBytes = GITHUB_URDF_LIMITS.maxPackageBytes } = {}) {
        this.repos = new Map();
        this.refs = new Map();
        this.trees = new Map();
        this.blobs = new Map();
        this.blobBytes = 0;
        this.maxTrees = maxTrees;
        this.maxBlobs = maxBlobs;
        this.maxBlobBytes = maxBlobBytes;
    }

    #touch(map, key, value, max) {
        if (map.has(key)) map.delete(key);
        map.set(key, value);
        while (map.size > max) map.delete(map.keys().next().value);
    }

    getTree(key) {
        const value = this.trees.get(key);
        if (!value) return null;
        this.#touch(this.trees, key, value, this.maxTrees);
        return value;
    }

    setTree(key, value) {
        this.#touch(this.trees, key, value, this.maxTrees);
    }

    getBlob(sha) {
        const value = this.blobs.get(sha);
        if (!value) return null;
        this.#touch(this.blobs, sha, value, this.maxBlobs);
        return value;
    }

    setBlob(sha, bytes) {
        if (this.blobs.has(sha)) {
            this.blobBytes -= this.blobs.get(sha).byteLength;
            this.blobs.delete(sha);
        }
        while (
            this.blobs.size > 0
            && (this.blobs.size >= this.maxBlobs || this.blobBytes + bytes.byteLength > this.maxBlobBytes)
        ) {
            const oldest = this.blobs.keys().next().value;
            this.blobBytes -= this.blobs.get(oldest).byteLength;
            this.blobs.delete(oldest);
        }
        if (bytes.byteLength > this.maxBlobBytes) return;
        this.blobs.set(sha, bytes);
        this.blobBytes += bytes.byteLength;
    }
}

export class GitHubUrdfClient {
    constructor({
        fetchImpl = globalThis.fetch,
        cache = new GitHubUrdfCache(),
        now = () => Date.now(),
        limits = GITHUB_URDF_LIMITS,
        signal = null,
    } = {}) {
        this.fetchImpl = fetchImpl;
        this.cache = cache;
        this.now = now;
        this.limits = { ...GITHUB_URDF_LIMITS, ...limits };
        this.signal = signal;
        this.requestCount = 0;
        this.started = now();
        this.rateLimit = null;
        this.active = 0;
        this.waiters = [];
    }

    #cancelled() {
        return new GitHubUrdfError("vehicle.github.cancelled", "GitHub acquisition was cancelled.");
    }

    #deadline() {
        return new GitHubUrdfError("vehicle.github.deadline", "GitHub acquisition exceeded its deadline.");
    }

    async #acquireSlot() {
        while (this.active >= this.limits.maxConcurrent) {
            if (this.signal?.aborted) throw this.#cancelled();
            if (this.now() - this.started >= this.limits.deadlineMs) throw this.#deadline();
            await new Promise((resolve) => this.waiters.push(resolve));
        }
        if (this.signal?.aborted) {
            this.waiters.shift()?.();
            throw this.#cancelled();
        }
        this.active += 1;
    }

    #releaseSlot() {
        this.active -= 1;
        this.waiters.shift()?.();
    }

    async #slot(task) {
        await this.#acquireSlot();
        try {
            return await task();
        } finally {
            this.#releaseSlot();
        }
    }

    #apiUrl(pathname) {
        const url = new URL(pathname, API_ORIGIN);
        if (url.origin !== API_ORIGIN || url.username || url.password) {
            throw new GitHubUrdfError("vehicle.github.redirect", "GitHub requests stay on api.github.com.", { path: pathname });
        }
        return url;
    }

    async #request(pathname, {
        accept = "application/vnd.github+json",
        etag = null,
        raw = false,
        maxBytes = this.limits.maxPackageBytes,
        allowStatuses = [],
    } = {}) {
        if (this.signal?.aborted) throw this.#cancelled();
        if (this.now() - this.started >= this.limits.deadlineMs) throw this.#deadline();
        if (this.rateLimit?.remaining === 0) throw rateLimitError(this.rateLimit);
        if (this.requestCount >= githubRequestLimit(this.limits)) {
            throw new GitHubUrdfError("vehicle.github.request-limit", "GitHub acquisition exceeded its request limit.");
        }
        const url = this.#apiUrl(pathname);
        const remaining = Math.max(1, this.limits.deadlineMs - (this.now() - this.started));
        const timed = AbortSignal.timeout(remaining);
        const signal = this.signal ? AbortSignal.any([this.signal, timed]) : timed;
        this.requestCount += 1;
        let response;
        try {
            response = await this.fetchImpl(url.href, {
                method: "GET",
                redirect: "manual",
                headers: {
                    Accept: accept,
                    "User-Agent": "cev-sim",
                    "X-GitHub-Api-Version": "2022-11-28",
                    ...(etag ? { "If-None-Match": etag } : {}),
                },
                signal,
            });
        } catch (error) {
            if (this.signal?.aborted) throw this.#cancelled();
            if (timed.aborted || this.now() - this.started >= this.limits.deadlineMs) throw this.#deadline();
            if (error?.name === "AbortError" || error?.name === "TimeoutError") throw this.#cancelled();
            throw new GitHubUrdfError("vehicle.github.unavailable", "GitHub is unavailable.");
        }
        this.rateLimit = rateLimitFrom(response.headers) ?? this.rateLimit;
        if (response.status >= 300 && response.status < 400 && response.status !== 304) {
            await response.body?.cancel?.();
            throw new GitHubUrdfError("vehicle.github.redirect", "GitHub redirects are not followed.", { path: pathname });
        }
        if (response.status === 429 || (response.status === 403 && this.rateLimit?.remaining === 0)) {
            await response.body?.cancel?.();
            throw rateLimitError(this.rateLimit);
        }
        const allowed = response.ok || response.status === 304 || allowStatuses.includes(response.status);
        if (!allowed) {
            await response.body?.cancel?.();
            throw new GitHubUrdfError("vehicle.github.unavailable", `GitHub request failed (${response.status}).`);
        }
        if (response.status === 304 || allowStatuses.includes(response.status)) {
            await response.body?.cancel?.();
            return { status: response.status, body: null, etag: headerValue(response.headers, "etag") };
        }
        const declared = Number(headerValue(response.headers, "content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) {
            await response.body?.cancel?.();
            throw new GitHubUrdfError("vehicle.github.file-bytes", `GitHub response exceeds ${maxBytes} bytes.`, { path: pathname });
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > maxBytes) {
            throw new GitHubUrdfError("vehicle.github.file-bytes", `GitHub response exceeds ${maxBytes} bytes.`, { path: pathname });
        }
        if (raw) return { status: response.status, body: bytes, etag: headerValue(response.headers, "etag") };
        try {
            return {
                status: response.status,
                body: JSON.parse(new TextDecoder().decode(bytes)),
                etag: headerValue(response.headers, "etag"),
            };
        } catch {
            throw new GitHubUrdfError("vehicle.github.unavailable", "GitHub returned invalid JSON.");
        }
    }

    async #repo(owner, repo) {
        const key = `${owner}/${repo}`;
        const cached = this.cache.repos.get(key);
        const response = await this.#slot(() => this.#request(`/repos/${owner}/${repo}`, {
            etag: cached?.etag ?? null,
            allowStatuses: [401, 403, 404],
        }));
        if (response.status === 401 || response.status === 403 || response.status === 404) {
            throw new GitHubUrdfError("vehicle.github.private", PRIVATE_MESSAGE, { path: `${owner}/${repo}` });
        }
        if (response.status === 304 && cached) return cached.body;
        if (response.body?.private === true) {
            throw new GitHubUrdfError("vehicle.github.private", PRIVATE_MESSAGE, { path: `${owner}/${repo}` });
        }
        this.cache.repos.set(key, { etag: response.etag, body: response.body });
        return response.body;
    }

    async #matchingRefs(owner, repo, namespace, etag) {
        try {
            return await this.#slot(() => this.#request(
                `/repos/${owner}/${repo}/git/matching-refs/${namespace}/`,
                { etag, maxBytes: this.limits.maxXmlBytes },
            ));
        } catch (error) {
            if (error instanceof GitHubUrdfError && error.code === "vehicle.github.file-bytes") {
                throw new GitHubUrdfError(
                    "vehicle.github.ref-list",
                    "The GitHub ref list exceeds 4 MiB. Use a 40-character commit SHA.",
                    { path: `${owner}/${repo}` },
                );
            }
            throw error;
        }
    }

    async #refList(owner, repo) {
        const key = `${owner}/${repo}`;
        const cached = this.cache.refs.get(key) ?? { heads: [], tags: [], headsEtag: null, tagsEtag: null };
        const heads = await this.#matchingRefs(owner, repo, "heads", cached.headsEtag);
        const tags = await this.#matchingRefs(owner, repo, "tags", cached.tagsEtag);
        const next = {
            heads: heads?.status === 304 ? cached.heads : (heads?.body ?? []),
            tags: tags?.status === 304 ? cached.tags : (tags?.body ?? []),
            headsEtag: heads?.etag ?? cached.headsEtag,
            tagsEtag: tags?.etag ?? cached.tagsEtag,
        };
        this.cache.refs.set(key, next);
        const refs = [];
        for (const entry of next.heads) {
            const full = String(entry?.ref ?? "");
            if (!full.startsWith("refs/heads/")) continue;
            refs.push({ name: full.slice("refs/heads/".length), commitRef: full });
        }
        for (const entry of next.tags) {
            const full = String(entry?.ref ?? "");
            if (!full.startsWith("refs/tags/")) continue;
            refs.push({ name: full.slice("refs/tags/".length), commitRef: full });
        }
        return refs;
    }

    async #commit(owner, repo, commitRef) {
        const response = await this.#slot(() => this.#request(
            `/repos/${owner}/${repo}/commits/${encodeURIComponent(commitRef)}`,
            { allowStatuses: [404] },
        ));
        if (response.status === 404) {
            throw new GitHubUrdfError("vehicle.github.unknown-ref", `GitHub ref "${commitRef}" was not found.`, { path: commitRef });
        }
        const sha = String(response.body?.sha ?? "").toLowerCase();
        const treeSha = String(response.body?.commit?.tree?.sha ?? "").toLowerCase();
        if (!/^[0-9a-f]{40}$/u.test(sha) || !/^[0-9a-f]{40}$/u.test(treeSha)) {
            throw new GitHubUrdfError("vehicle.github.unavailable", "GitHub did not return a commit and tree SHA.");
        }
        return { sha, treeSha };
    }

    async pin(parsed) {
        const repo = await this.#repo(parsed.owner, parsed.repo);
        let requestedRef = repo.default_branch;
        let path = "";
        let commitRef = repo.default_branch;
        if (parsed.kind !== "repository") {
            const directCommit = /^[0-9a-f]{40}(?:\/|$)/iu.test(parsed.refPath);
            const refs = directCommit ? [] : await this.#refList(parsed.owner, parsed.repo);
            const split = splitGitHubRef(parsed.refPath, refs);
            if (split.error) throw new GitHubUrdfError(split.error.code, split.error.message, { path: split.error.path });
            requestedRef = split.ref;
            commitRef = split.commitRef;
            path = split.path;
        }
        const commit = await this.#commit(parsed.owner, parsed.repo, commitRef);
        return {
            owner: parsed.owner,
            repo: parsed.repo,
            url: parsed.canonicalUrl,
            kind: parsed.kind,
            requestedRef,
            commitSha: commit.sha,
            treeSha: commit.treeSha,
            path,
            defaultBranch: repo.default_branch,
            license: licenseFrom(repo),
            rateLimit: this.rateLimit,
        };
    }

    source(pin, entryPath) {
        return githubSource({ ...pin, entryPath });
    }

    async tree(pin) {
        const key = `${pin.owner}/${pin.repo}/${pin.commitSha}`;
        const cached = this.cache.getTree(key);
        if (cached) return cached;
        const response = await this.#slot(() => this.#request(
            `/repos/${pin.owner}/${pin.repo}/git/trees/${pin.treeSha}?recursive=1`,
        ));
        if (response.body?.truncated === true) {
            throw new GitHubUrdfError("vehicle.github.tree-truncated", "The GitHub tree listing was truncated.", { path: pin.treeSha });
        }
        const entries = new Map();
        for (const entry of response.body?.tree ?? []) {
            if (!entry?.path) continue;
            entries.set(entry.path, {
                path: entry.path,
                mode: String(entry.mode ?? ""),
                type: entry.type ?? "blob",
                sha: entry.sha ?? "",
                size: Number.isFinite(entry.size) ? entry.size : null,
            });
        }
        const value = { commitSha: pin.commitSha, treeSha: pin.treeSha, entries, rateLimit: this.rateLimit };
        this.cache.setTree(key, value);
        return value;
    }

    async blob(pin, entry) {
        const hostile = gitTreeIssue(entry, entry?.path ?? "");
        if (hostile) throw new GitHubUrdfError(hostile.code, hostile.message, { path: hostile.path });
        const oversize = gitBlobSizeIssue(entry, this.limits.maxFileBytes);
        if (oversize) throw new GitHubUrdfError(oversize.code, oversize.message, { path: oversize.path });
        const cached = entry.sha ? this.cache.getBlob(entry.sha) : null;
        if (cached) return cached;
        const response = await this.#slot(() => this.#request(
            `/repos/${pin.owner}/${pin.repo}/git/blobs/${entry.sha}`,
            { accept: "application/vnd.github.raw", raw: true, maxBytes: this.limits.maxFileBytes },
        ));
        const bytes = response.body;
        if (Number.isFinite(entry.size) && bytes.byteLength !== entry.size) {
            throw new GitHubUrdfError(
                "vehicle.github.size-mismatch",
                `File "${entry.path}" size does not match the tree.`,
                { path: entry.path },
            );
        }
        if (isGitLfsPointer(bytes)) {
            throw new GitHubUrdfError("vehicle.github.lfs", `File "${entry.path}" is a Git LFS pointer.`, { path: entry.path });
        }
        if (entry.sha) this.cache.setBlob(entry.sha, bytes);
        return bytes;
    }
}

export function githubFailureIssue(error) {
    if (error instanceof GitHubUrdfError) return urdfIssue(error.code, error.path, error.message);
    return urdfIssue("vehicle.github.unavailable", "", error?.message || "GitHub acquisition failed.");
}
