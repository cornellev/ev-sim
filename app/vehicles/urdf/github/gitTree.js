/** Tree-entry checks shared by the GitHub client and the closure walk. */

import { urdfIssue } from "../issue.js";

const LFS_PREFIX = "version https://git-lfs.github.com/spec/v1";

export function isGitLfsPointer(bytes) {
    const sample = bytes.subarray(0, Math.min(bytes.byteLength, 200));
    return new TextDecoder().decode(sample).startsWith(LFS_PREFIX);
}

export function gitTreeIssue(entry, path) {
    if (!entry) {
        return urdfIssue("vehicle.github.missing-path", path, `Path "${path}" is not in the pinned tree.`);
    }
    if (entry.mode === "120000") {
        return urdfIssue("vehicle.github.symlink", path, `Path "${path}" is a symlink.`);
    }
    if (entry.mode === "160000" || entry.type === "commit") {
        return urdfIssue("vehicle.github.submodule", path, `Path "${path}" is a submodule.`);
    }
    return null;
}

/** A submodule entry whose path is a parent of `path`. */
export function gitSubmoduleAncestor(entries, path) {
    const parts = String(path ?? "").split("/");
    let prefix = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
        prefix = prefix ? `${prefix}/${parts[index]}` : parts[index];
        const entry = entries.get(prefix);
        if (entry && (entry.mode === "160000" || entry.type === "commit")) return entry;
    }
    return null;
}

export function gitBlobSizeIssue(entry, maxFileBytes) {
    if (Number.isFinite(entry?.size) && entry.size > maxFileBytes) {
        return urdfIssue(
            "vehicle.github.file-bytes",
            entry.path,
            `File "${entry.path}" exceeds ${maxFileBytes} bytes.`,
        );
    }
    return null;
}
