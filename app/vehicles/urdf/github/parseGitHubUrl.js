/**
 * Public GitHub URL forms for a vehicle URDF.
 * Branch names that contain slashes stay in `refPath` until `splitGitHubRef`.
 */

import { urdfIssue } from "../issue.js";

const OWNER = /^[A-Za-z0-9_.-]+$/u;
const COMMIT = /^[0-9a-f]{40}$/iu;
const CREDENTIAL_KEYS = Object.freeze(["token", "authorization", "access_token", "accessToken"]);

function fail(code, path, message) {
    return { ok: false, url: null, diagnostics: [urdfIssue(code, path, message)] };
}

function decodeSegments(pathname) {
    const parts = String(pathname ?? "").split("/");
    if (parts[0] !== "") return null;
    const decoded = [];
    for (const part of parts.slice(1)) {
        if (part === "") return null;
        let text;
        try {
            text = decodeURIComponent(part);
        } catch {
            return null;
        }
        if (!text || text === "." || text === ".." || text.includes("/") || text.includes("\\")) return null;
        decoded.push(text);
    }
    return decoded;
}

function repositoryName(segment) {
    return segment.toLowerCase().endsWith(".git") ? segment.slice(0, -4) : segment;
}

function canonicalUrl(kind, owner, repo, refPath) {
    if (kind === "repository") return `https://github.com/${owner}/${repo}`;
    if (kind === "raw") return `https://raw.githubusercontent.com/${owner}/${repo}/${refPath}`;
    return `https://github.com/${owner}/${repo}/${kind}/${refPath}`;
}

function parsed(kind, owner, repo, refPath) {
    return {
        ok: true,
        diagnostics: [],
        url: {
            kind,
            owner,
            repo,
            ref: null,
            path: "",
            refPath,
            canonicalUrl: canonicalUrl(kind, owner, repo, refPath),
        },
    };
}

function names(owner, repo) {
    if (!OWNER.test(owner) || owner === "." || owner === "..") return false;
    if (!OWNER.test(repo) || repo === "." || repo === "..") return false;
    return true;
}

/**
 * Split `ref/path` using the repository's branch and tag names.
 * A 40-character hex prefix is the commit and does not need the ref list.
 * The longest matching ref wins. An equal branch and tag name prefers the branch.
 */
export function splitGitHubRef(remainder, refs = []) {
    const text = String(remainder ?? "");
    if (!text) {
        return { error: urdfIssue("vehicle.github.unknown-ref", "", "A GitHub ref is required.") };
    }
    const first = text.split("/")[0];
    if (COMMIT.test(first)) {
        const ref = first.toLowerCase();
        return { ref, commitRef: ref, path: text.slice(first.length).replace(/^\//u, "") };
    }
    const matches = [];
    for (const entry of refs) {
        const name = typeof entry === "string" ? entry : entry?.name;
        const commitRef = typeof entry === "string" ? entry : (entry?.commitRef ?? name);
        if (!name) continue;
        if (text === name || text.startsWith(`${name}/`)) matches.push({ name, commitRef });
    }
    if (matches.length === 0) {
        return {
            error: urdfIssue("vehicle.github.unknown-ref", text, `GitHub ref in "${text}" does not match a branch or tag.`),
        };
    }
    matches.sort((left, right) => {
        if (left.name.length !== right.name.length) return right.name.length - left.name.length;
        const leftHead = String(left.commitRef).startsWith("refs/heads/") ? 0 : 1;
        const rightHead = String(right.commitRef).startsWith("refs/heads/") ? 0 : 1;
        if (leftHead !== rightHead) return leftHead - rightHead;
        return left.commitRef < right.commitRef ? -1 : left.commitRef > right.commitRef ? 1 : 0;
    });
    const best = matches[0];
    return {
        ref: best.name,
        commitRef: best.commitRef,
        path: text.slice(best.name.length).replace(/^\//u, ""),
    };
}

/** Reject a JSON body that tries to supply GitHub credentials. */
export function githubCredentialIssue(body) {
    if (!body || typeof body !== "object") return null;
    for (const key of CREDENTIAL_KEYS) {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
            return urdfIssue("vehicle.github.credentials", key, "GitHub credentials are not accepted.");
        }
    }
    return null;
}

/** Parse a public repository, tree, blob, or raw GitHub URL. */
export function parseGitHubVehicleUrl(value) {
    let url;
    try {
        url = new URL(String(value ?? ""));
    } catch {
        return fail("vehicle.github.unsupported-url", String(value ?? ""), "The vehicle URL is not a GitHub URL.");
    }
    if (url.username || url.password || url.search || url.hash) {
        return fail("vehicle.github.credentials", url.hostname, "GitHub credentials are not accepted.");
    }
    if (url.protocol !== "https:") {
        return fail("vehicle.github.unsupported-url", url.protocol, "GitHub vehicle URLs must use HTTPS.");
    }
    const host = url.hostname.toLowerCase();
    const segments = decodeSegments(url.pathname);
    if (!segments) {
        return fail("vehicle.github.unsupported-url", url.pathname, "The GitHub URL path is not a repository path.");
    }
    if (host === "raw.githubusercontent.com") {
        if (segments.length < 3) {
            return fail("vehicle.github.unsupported-url", url.pathname, "A raw GitHub URL must name an owner, repository, and ref.");
        }
        const owner = segments[0];
        const repo = repositoryName(segments[1]);
        if (!names(owner, repo)) {
            return fail("vehicle.github.unsupported-url", url.pathname, "The GitHub repository name is not valid.");
        }
        return parsed("raw", owner, repo, segments.slice(2).join("/"));
    }
    if (host !== "github.com" && host !== "www.github.com") {
        return fail("vehicle.github.unsupported-url", host, "Only public github.com URLs are accepted.");
    }
    if (segments.length < 2) {
        return fail("vehicle.github.unsupported-url", url.pathname, "The GitHub URL must name an owner and repository.");
    }
    const owner = segments[0];
    const repo = repositoryName(segments[1]);
    if (!names(owner, repo)) {
        return fail("vehicle.github.unsupported-url", url.pathname, "The GitHub repository name is not valid.");
    }
    if (segments.length === 2) return parsed("repository", owner, repo, "");
    const kind = segments[2];
    if (kind !== "tree" && kind !== "blob" && kind !== "raw") {
        return fail("vehicle.github.unsupported-url", url.pathname, "The GitHub URL must be a repository, tree, blob, or raw path.");
    }
    if (segments.length < 4) {
        return fail("vehicle.github.unsupported-url", url.pathname, "The GitHub URL must include a ref.");
    }
    return parsed(kind, owner, repo, segments.slice(3).join("/"));
}
