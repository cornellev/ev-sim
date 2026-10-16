/** In-memory api.github.com for VEH-07 tests. No test contacts GitHub. */

const textEncoder = new TextEncoder();

export const GITHUB_COMMIT_SHA = "a".repeat(40);
export const GITHUB_TREE_SHA = "b".repeat(40);

function bytesOf(value) {
    if (value instanceof Uint8Array) return value;
    return textEncoder.encode(String(value));
}

function jsonResponse(status, body, headers) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });
}

function rateHeaders(rateLimit, etag) {
    return {
        "x-ratelimit-limit": String(rateLimit.limit),
        "x-ratelimit-remaining": String(rateLimit.remaining),
        "x-ratelimit-reset": String(rateLimit.reset),
        "x-ratelimit-resource": rateLimit.resource,
        etag,
    };
}

/**
 * Serve one public repository. `calls` records every request the client makes.
 */
export function createGitHubFixture({
    owner = "acme",
    repo = "robot",
    isPrivate = false,
    repoStatus = 200,
    defaultBranch = "main",
    commitSha = GITHUB_COMMIT_SHA,
    treeSha = GITHUB_TREE_SHA,
    license = { spdx_id: "Apache-2.0", name: "Apache License 2.0" },
    branches = ["main"],
    tags = [],
    files = {},
    modes = {},
    types = {},
    sizes = {},
    redirect = null,
    rateLimit = { limit: 60, remaining: 50, reset: 1_700_000_000, resource: "core" },
    truncated = false,
    etag = "\"repo-1\"",
} = {}) {
    const blobs = new Map();
    const tree = [];
    const directories = new Set();
    let blobIndex = 1;
    for (const [path, content] of Object.entries(files)) {
        const bytes = bytesOf(content);
        const sha = blobIndex.toString(16).padStart(40, "c");
        blobIndex += 1;
        const mode = modes[path] ?? "100644";
        const type = types[path] ?? (mode === "160000" ? "commit" : "blob");
        const size = Object.hasOwn(sizes, path) ? sizes[path] : bytes.byteLength;
        blobs.set(sha, bytes);
        tree.push({ path, mode, type, sha, size });
        const parts = path.split("/");
        for (let index = 0; index < parts.length - 1; index += 1) {
            directories.add(parts.slice(0, index + 1).join("/"));
        }
    }
    for (const path of directories) {
        if (tree.some((entry) => entry.path === path)) continue;
        tree.push({ path, mode: "040000", type: "tree", sha: "d".repeat(40) });
    }
    const calls = [];
    const headers = () => rateHeaders(rateLimit, etag);
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url, init });
        if (redirect) return new Response(null, { status: 302, headers: { location: redirect } });
        const parsed = new URL(url);
        if (parsed.origin !== "https://api.github.com") {
            return new Response(null, { status: 302, headers: { location: parsed.href } });
        }
        const pathname = parsed.pathname;
        const repoPath = `/repos/${owner}/${repo}`;
        if (pathname === repoPath) {
            if (isPrivate || repoStatus === 404) return jsonResponse(404, { message: "Not Found" }, headers());
            if (repoStatus === 401 || repoStatus === 403) return jsonResponse(repoStatus, { message: "Forbidden" }, headers());
            if (init.headers?.["If-None-Match"] === etag) return new Response(null, { status: 304, headers: headers() });
            return jsonResponse(200, {
                private: false,
                default_branch: defaultBranch,
                license,
            }, headers());
        }
        if (pathname === `${repoPath}/git/matching-refs/heads/`) {
            return jsonResponse(200, branches.map((name) => ({ ref: `refs/heads/${name}` })), headers());
        }
        if (pathname === `${repoPath}/git/matching-refs/tags/`) {
            return jsonResponse(200, tags.map((name) => ({ ref: `refs/tags/${name}` })), headers());
        }
        if (pathname.startsWith(`${repoPath}/commits/`)) {
            return jsonResponse(200, { sha: commitSha, commit: { tree: { sha: treeSha } } }, headers());
        }
        if (pathname === `${repoPath}/git/trees/${treeSha}`) {
            return jsonResponse(200, { sha: treeSha, truncated, tree }, headers());
        }
        if (pathname.startsWith(`${repoPath}/git/blobs/`)) {
            const sha = decodeURIComponent(pathname.slice(`${repoPath}/git/blobs/`.length));
            const bytes = blobs.get(sha);
            if (!bytes) return jsonResponse(404, { message: "Not Found" }, headers());
            return new Response(bytes, { status: 200, headers: headers() });
        }
        return jsonResponse(404, { message: "Not Found" }, headers());
    };
    return { fetchImpl, calls, blobs, tree, owner, repo, commitSha, treeSha };
}
