import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import semver from "semver";

import { defaultCevSimEngineRange, MIGRATION_CEV_SIM_ENGINE_RANGE } from "../app/plugin/PluginEngineRange.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_FILES = {
    packageJson: "package.json",
    pluginJson: "plugin.json",
    versionJs: "app/version.js",
    pyproject: "python/pyproject.toml",
    pythonInit: "python/src/cev_sim/__init__.py",
    packageLock: "package-lock.json",
};

export const HAND_EDIT_PATHS = [
    "CHANGELOG.md",
    "README.md",
    "docs/getting-started.md",
    "docs/headless-release.md",
    "docs/python-headless.md",
    "docs/plugin-api.md",
    "install.sh",
    "docs/headless-simulation-plan.md",
];

function matchVersion(source, pattern, label) {
    const match = source.match(pattern);
    if (!match) throw new Error(`${label} version could not be read.`);
    return match[1];
}

export function readCoordinatedVersions(sources) {
    const packageJson = JSON.parse(sources.packageJson);
    const pluginJson = JSON.parse(sources.pluginJson);
    const lock = JSON.parse(sources.packageLock);
    return {
        package: packageJson.version,
        plugin: pluginJson.version,
        app: matchVersion(sources.versionJs, /export const CEV_SIM_VERSION = "([^"]+)"/, "app/version.js"),
        pythonProject: matchVersion(sources.pyproject, /^version\s*=\s*"([^"]+)"/m, "python/pyproject.toml"),
        pythonRuntime: matchVersion(sources.pythonInit, /^__version__\s*=\s*"([^"]+)"/m, "python/src/cev_sim/__init__.py"),
        lock: lock.version,
        lockRoot: lock.packages?.[""]?.version,
    };
}

function assertAligned(versions) {
    const coordinated = {
        package: versions.package,
        plugin: versions.plugin,
        app: versions.app,
        pythonProject: versions.pythonProject,
        pythonRuntime: versions.pythonRuntime,
    };
    if (new Set(Object.values(coordinated)).size !== 1) {
        throw new Error(`Coordinated package versions differ: ${JSON.stringify(coordinated)}.`);
    }
    if (versions.lock !== versions.package || versions.lockRoot !== versions.package) {
        throw new Error(`package-lock.json root version does not match ${versions.package}.`);
    }
    if (semver.valid(versions.package) !== versions.package) {
        throw new Error(`Current version must be strict SemVer; received ${JSON.stringify(versions.package)}.`);
    }
    return versions.package;
}

function assertNext(current, next) {
    if (semver.valid(next) !== next) {
        throw new Error(`Version must be strict SemVer; received ${JSON.stringify(next)}.`);
    }
    if (!semver.gt(next, current)) {
        throw new Error(`Version ${next} is not greater than ${current}.`);
    }
}

function replaceVersionFields(text, current, next, count) {
    const pattern = /"version"\s*:\s*"([^"]+)"/g;
    let seen = 0;
    const updated = text.replace(pattern, (full, value) => {
        if (seen >= count) return full;
        if (value !== current) throw new Error(`Expected version ${current} in ${full}.`);
        seen += 1;
        return full.replace(`"${current}"`, `"${next}"`);
    });
    if (seen !== count) throw new Error(`Expected ${count} version fields, found ${seen}.`);
    return updated;
}

function replacePattern(text, pattern, replacement, label) {
    const match = text.match(pattern);
    if (!match) throw new Error(`${label} version could not be read.`);
    const nextText = typeof replacement === "function" ? replacement(match[0]) : replacement;
    return text.slice(0, match.index) + nextText + text.slice(match.index + match[0].length);
}

function admits(version, range) {
    return Boolean(semver.validRange(range)) && semver.satisfies(version, range);
}

export function pluginsExcludingVersion(plugins, version) {
    return plugins.filter((plugin) => !admits(version, plugin.range));
}

export function reminderLines({ next, migrationRange, scaffoldRange, excludedExamples }) {
    const lines = [
        `Hand-edit these release notes and install snippets for ${next}. Leave older sections alone:`,
        ...HAND_EDIT_PATHS.map((file) => `- ${file}`),
        `- docs/release-${next}-notes.md when cutting a tag. Leave docs/release-0.3.0-notes.md as history.`,
        "Add a decision-log entry to docs/headless-simulation-plan.md only when this bump is a packaging milestone. Do not rewrite older entries.",
        `New plugin scaffolds use engines.cevSim ${scaffoldRange}.`,
    ];
    if (!admits(next, migrationRange)) {
        lines.push(`${next} is outside ${migrationRange}. Update MIGRATION_CEV_SIM_ENGINE_RANGE in app/plugin/PluginEngineRange.js. scripts/generate-plant-fixture.mjs reads that constant.`);
    }
    if (excludedExamples.length > 0) {
        lines.push("These example plugins do not admit the new version. Widen engines.cevSim by hand if they must load:");
        for (const example of excludedExamples) lines.push(`- ${example.file}: ${example.range}`);
    }
    lines.push("This script does not change engine ranges, test fixtures, marketplace canonical documents, or characterization tapes.");
    lines.push("Run npm run release:check.");
    return lines;
}

export function bumpSources(sources, next, { dryRun = false } = {}) {
    const current = assertAligned(readCoordinatedVersions(sources));
    assertNext(current, next);
    const updated = {
        packageJson: replaceVersionFields(sources.packageJson, current, next, 1),
        pluginJson: replaceVersionFields(sources.pluginJson, current, next, 1),
        versionJs: replacePattern(
            sources.versionJs,
            /export const CEV_SIM_VERSION = "[^"]+"/,
            `export const CEV_SIM_VERSION = "${next}"`,
            "app/version.js",
        ),
        pyproject: replacePattern(
            sources.pyproject,
            /^version\s*=\s*"[^"]+"/m,
            (match) => match.replace(/"[^"]+"/, `"${next}"`),
            "python/pyproject.toml",
        ),
        pythonInit: replacePattern(
            sources.pythonInit,
            /^__version__\s*=\s*"[^"]+"/m,
            (match) => match.replace(/"[^"]+"/, `"${next}"`),
            "python/src/cev_sim/__init__.py",
        ),
        packageLock: replaceVersionFields(sources.packageLock, current, next, 2),
    };
    const written = assertAligned(readCoordinatedVersions(updated));
    if (written !== next) throw new Error(`Bump wrote ${written}, expected ${next}.`);
    return { current, next, sources: dryRun ? sources : updated, wrote: !dryRun };
}

function parseArgs(argv) {
    let next = null;
    let dryRun = false;
    for (const arg of argv) {
        if (arg === "--dry-run") dryRun = true;
        else if (arg.startsWith("-")) throw new Error(`Unexpected argument ${arg}.`);
        else if (next) throw new Error("Pass one version.");
        else next = arg;
    }
    if (!next) throw new Error("Usage: npm run version:bump -- <version> [--dry-run]");
    return { next, dryRun };
}

async function readSources(root) {
    const sources = {};
    for (const [key, relative] of Object.entries(SOURCE_FILES)) {
        sources[key] = await fs.readFile(path.join(root, relative), "utf8");
    }
    return sources;
}

async function writeSources(root, sources) {
    await Promise.all(Object.entries(SOURCE_FILES).map(([key, relative]) => (
        fs.writeFile(path.join(root, relative), sources[key])
    )));
}

async function examplePluginRanges(root) {
    const base = path.join(root, "examples", "plugins");
    const entries = await fs.readdir(base, { withFileTypes: true });
    const plugins = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory()) continue;
        const relative = ["examples", "plugins", entry.name, "plugin.json"].join("/");
        const document = JSON.parse(await fs.readFile(path.join(root, relative), "utf8"));
        if (typeof document.engines?.cevSim === "string") plugins.push({ file: relative, range: document.engines.cevSim });
    }
    return plugins;
}

async function main() {
    const { next, dryRun } = parseArgs(process.argv.slice(2));
    const sources = await readSources(REPOSITORY_ROOT);
    const result = bumpSources(sources, next, { dryRun });
    if (result.wrote) await writeSources(REPOSITORY_ROOT, result.sources);
    const excludedExamples = pluginsExcludingVersion(await examplePluginRanges(REPOSITORY_ROOT), result.next);
    const lines = [
        result.wrote
            ? `Set the coordinated version from ${result.current} to ${result.next}.`
            : `Dry run. Would set the coordinated version from ${result.current} to ${result.next}.`,
        ...reminderLines({
            next: result.next,
            migrationRange: MIGRATION_CEV_SIM_ENGINE_RANGE,
            scaffoldRange: defaultCevSimEngineRange(result.next),
            excludedExamples,
        }),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch((error) => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}
