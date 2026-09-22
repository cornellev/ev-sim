import { promises as fs } from "node:fs";
import process from "node:process";

import { HeadlessEpisodeError } from "../../app/simulation/headless/HeadlessErrors.js";
import { StorageService } from "../storage/StorageService.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { canonicalRunBundleStringify, verifyRunBundleBytes } from "./RunBundle.js";

const CATALOG_PREFIX = "use:";

/**
 * Open the same authoring catalog the browser writes.
 * `CEV_SIM_DATA_DIR` defaults inside StorageService when unset.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function openAuthoringStorage(env = process.env) {
    return new StorageService(env.CEV_SIM_DATA_DIR, {
        visualAssets: {
            registryPath: env.CEV_SIM_VISUAL_SOURCE_REGISTRY || undefined,
        },
        bakeOutputSourceIds: env.CEV_SIM_BAKE_OUTPUT_SOURCE_IDS,
    });
}

/**
 * A `--bundle` value is a file path, or `use:<manifestId>` for one saved catalog id.
 * `./use:<id>` stays a file path. A slash inside the catalog form is a usage error.
 * @param {string} value
 */
export function parseBundleReference(value) {
    if (typeof value !== "string" || value.length === 0) {
        throw new HeadlessRunnerError("USAGE", "Option --bundle requires a file path or use:<manifestId>.");
    }
    if (!value.startsWith(CATALOG_PREFIX)) return { kind: "file", path: value };
    const manifestId = value.slice(CATALOG_PREFIX.length).trim();
    if (!manifestId || manifestId === "." || manifestId === ".." || /[\\/]/.test(manifestId)) {
        throw new HeadlessRunnerError("USAGE", "Catalog bundle references use the form use:<manifestId>.");
    }
    return { kind: "catalog", manifestId };
}

function validationMessage(issues = []) {
    const detail = issues.map((issue) => `${issue.path || "manifest"}: ${issue.message}`).join("; ");
    return detail ? `Run manifest validation failed: ${detail}` : "Run manifest validation failed.";
}

function catalogRequestError(error) {
    if (error instanceof HeadlessRunnerError || error instanceof HeadlessEpisodeError) return error;
    const issues = Array.isArray(error?.issues) ? error.issues : null;
    return new HeadlessRunnerError(
        "INVALID_REQUEST",
        error?.message || "Run manifest could not be exported.",
        issues ? { issues } : null,
        { cause: error },
    );
}

/**
 * Load a verified run bundle from a file or from a saved authoring manifest.
 * Catalog loads validate before export and never write a temporary bundle file.
 * @param {string} value
 * @param {{ storage?: import("../storage/StorageService.js").StorageService, readFile?: (filePath: string) => Promise<Buffer> }} [options]
 */
export async function loadBundleReference(value, { storage = null, readFile = fs.readFile } = {}) {
    const reference = parseBundleReference(value);
    if (reference.kind === "file") {
        return verifyRunBundleBytes(await readFile(reference.path));
    }
    const authoring = storage ?? openAuthoringStorage();
    let manifest;
    try {
        manifest = await authoring.getRunManifest(reference.manifestId);
    } catch (error) {
        throw catalogRequestError(error);
    }
    if (!manifest) {
        throw new HeadlessRunnerError(
            "INVALID_REQUEST",
            `Run manifest "${reference.manifestId}" does not exist.`,
        );
    }
    let validation;
    try {
        validation = await authoring.validateRunManifest(reference.manifestId);
    } catch (error) {
        throw catalogRequestError(error);
    }
    if (!validation.ok) {
        throw new HeadlessRunnerError(
            "INVALID_REQUEST",
            validationMessage(validation.issues),
            { issues: validation.issues ?? [] },
        );
    }
    let exported;
    try {
        exported = await authoring.exportRunManifest(reference.manifestId);
    } catch (error) {
        throw catalogRequestError(error);
    }
    return verifyRunBundleBytes(Buffer.from(canonicalRunBundleStringify(exported), "utf8"));
}
