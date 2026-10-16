/**
 * Conventional URDF ranking.
 * A lower rank wins. Ties at the best rank require an explicit selection.
 */

import { urdfIssue } from "../issue.js";

const URDF_DIRECTORY = /(^|\/)urdf\/[^/]+\.urdf$/iu;
const ROBOTS_DIRECTORY = /(^|\/)robots\/[^/]+\.urdf$/iu;

function pathOf(entry) {
    return typeof entry === "string" ? entry : String(entry?.path ?? "");
}

function typeOf(entry) {
    return typeof entry === "string" ? "blob" : (entry?.type ?? "blob");
}

function underPrefix(path, prefix) {
    if (!prefix) return true;
    return path === prefix || path.startsWith(`${prefix}/`);
}

function rankOf(path, prefix) {
    if (URDF_DIRECTORY.test(path)) return { rank: 1, reason: "urdf-directory" };
    if (ROBOTS_DIRECTORY.test(path)) return { rank: 2, reason: "robots-directory" };
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (parent === prefix) return { rank: 3, reason: "prefix-root" };
    return { rank: 4, reason: "other" };
}

/**
 * @param {Array<string | { path: string, type?: string }>} entries
 * @param {{ prefix?: string, namedPath?: string | null }} [options]
 */
export function rankUrdfCandidates(entries, { prefix = "", namedPath = null } = {}) {
    const root = String(prefix ?? "").replace(/\/+$/u, "");
    if (namedPath) {
        const path = String(namedPath);
        if (!path.toLowerCase().endsWith(".urdf")) {
            return {
                candidates: [],
                selectionRequired: false,
                selected: null,
                diagnostics: [urdfIssue("vehicle.github.not-urdf", path, `Path "${path}" is not a URDF file.`)],
            };
        }
        return {
            candidates: [{ path, rank: 0, reason: "named" }],
            selectionRequired: false,
            selected: path,
            diagnostics: [],
        };
    }
    const candidates = [];
    for (const entry of entries ?? []) {
        const path = pathOf(entry);
        if (!path || typeOf(entry) !== "blob" || !underPrefix(path, root)) continue;
        if (!path.toLowerCase().endsWith(".urdf")) continue;
        const ranked = rankOf(path, root);
        candidates.push({ path, rank: ranked.rank, reason: ranked.reason });
    }
    candidates.sort((left, right) => left.rank - right.rank || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    if (candidates.length === 0) {
        return {
            candidates,
            selectionRequired: false,
            selected: null,
            diagnostics: [urdfIssue("vehicle.github.no-urdf", root, "The GitHub tree has no URDF file.")],
        };
    }
    const best = candidates[0].rank;
    const tied = candidates.filter((candidate) => candidate.rank === best);
    return {
        candidates,
        selectionRequired: tied.length > 1,
        selected: tied.length === 1 ? tied[0].path : null,
        diagnostics: [],
    };
}

/** Apply an explicit entry, or the unique best candidate. */
export function selectUrdfCandidate(ranked, entryPath) {
    if (ranked?.diagnostics?.length) {
        return {
            selected: null,
            selectionRequired: false,
            diagnostics: ranked.diagnostics,
        };
    }
    if (entryPath) {
        const path = String(entryPath);
        const match = ranked.candidates.find((candidate) => candidate.path === path);
        if (!match) {
            return {
                selected: null,
                selectionRequired: ranked.selectionRequired,
                diagnostics: [urdfIssue(
                    "vehicle.github.unknown-entry",
                    path,
                    `Path "${path}" is not one of the URDF candidates.`,
                )],
            };
        }
        return { selected: path, selectionRequired: false, diagnostics: [] };
    }
    if (ranked.selectionRequired) {
        return {
            selected: null,
            selectionRequired: true,
            diagnostics: [urdfIssue(
                "vehicle.github.selection-required",
                "",
                "More than one URDF file shares the best rank.",
            )],
        };
    }
    return { selected: ranked.selected, selectionRequired: false, diagnostics: [] };
}
