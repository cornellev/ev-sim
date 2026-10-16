/** Provenance stored on the package source. It is not part of a vehicle manifest. */

export function githubSource({
    owner,
    repo,
    url,
    requestedRef,
    commitSha,
    treeSha,
    entryPath,
    license,
} = {}) {
    return Object.freeze({
        kind: "github",
        owner,
        repo,
        url,
        requestedRef,
        commitSha,
        treeSha,
        entryPath,
        license: Object.freeze({
            status: license?.status ?? "none",
            spdxId: license?.spdxId ?? null,
            name: license?.name ?? null,
        }),
    });
}

export function githubReview({
    owner,
    repo,
    requestedRef,
    commitSha,
    treeSha,
    selectedPath = null,
    license,
    rateLimit = null,
} = {}) {
    return {
        repository: `${owner}/${repo}`,
        requestedRef,
        commitSha,
        treeSha,
        selectedPath,
        license: {
            status: license?.status ?? "none",
            spdxId: license?.spdxId ?? null,
            name: license?.name ?? null,
        },
        rateLimit,
    };
}
