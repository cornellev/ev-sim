#!/usr/bin/env node
/**
 * Lightweight portable-plugin / skill integrity checks.
 * Does not snapshot MCP Zod schemas.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(__dirname, "..");
const repoRoot = resolve(skillRoot, "../..");
const errors = [];
const warnings = [];

function fail(msg) {
    errors.push(msg);
}

function warn(msg) {
    warnings.push(msg);
}

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        fail(`Invalid JSON ${relative(repoRoot, path)}: ${error.message}`);
        return null;
    }
}

function readText(path) {
    return readFileSync(path, "utf8");
}

function walkMarkdown(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walkMarkdown(full, out);
        else if (name.endsWith(".md")) out.push(full);
    }
    return out;
}

// --- plugin.json ---
const pluginPath = join(repoRoot, "plugin.json");
const plugin = readJson(pluginPath);
if (plugin) {
    if (plugin.name !== "cev-sim") fail('plugin.json name must be "cev-sim"');
    if (!plugin.version) fail("plugin.json missing version");
    if (!plugin.description) fail("plugin.json missing description");
    if (!String(plugin.$schema || "").includes("plugin.schema.json")) {
        warn("plugin.json $schema should point at agent-plugins plugin.schema.json");
    }
}

// --- mcp.json ---
const mcpPath = join(repoRoot, "mcp.json");
const mcp = readJson(mcpPath);
if (mcp) {
    const server = mcp.mcpServers?.["cev-sim"];
    if (!server) fail('mcp.json must define mcpServers["cev-sim"]');
    else {
        if (server.type !== "streamable-http") {
            fail('mcp.json cev-sim.type must be "streamable-http"');
        }
        if (server.url !== "http://localhost:3000/mcp") {
            fail('mcp.json cev-sim.url must be "http://localhost:3000/mcp"');
        }
    }
    const keys = Object.keys(mcp).filter((k) => k !== "$schema" && k !== "mcpServers");
    if (keys.length) fail(`mcp.json unexpected top-level keys: ${keys.join(", ")}`);
}

// --- SKILL.md frontmatter + length ---
const skillPath = join(skillRoot, "SKILL.md");
if (!existsSync(skillPath)) fail("Missing skills/cev-sim/SKILL.md");
else {
    const text = readText(skillPath);
    const lines = text.split(/\r?\n/);
    if (lines.length > 500) fail(`SKILL.md has ${lines.length} lines (max 500)`);

    if (!text.startsWith("---")) fail("SKILL.md missing YAML frontmatter");
    else {
        const end = text.indexOf("\n---", 3);
        if (end < 0) fail("SKILL.md frontmatter not closed");
        else {
            const fm = text.slice(3, end);
            if (!/^\s*name:\s*cev-sim\s*$/m.test(fm)) fail('SKILL.md name must be "cev-sim"');
            if (!/^\s*description:\s*/m.test(fm)) fail("SKILL.md missing description");
            if (/disable-model-invocation:\s*true/i.test(fm)) {
                fail("SKILL.md must auto-invoke (do not set disable-model-invocation: true)");
            }
        }
    }
}

// --- Relative links in skill markdown ---
const mdFiles = walkMarkdown(skillRoot);
const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
for (const file of mdFiles) {
    const text = readText(file);
    let match;
    while ((match = linkRe.exec(text)) !== null) {
        let target = match[1].trim();
        if (!target || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:")) {
            continue;
        }
        if (target.startsWith("#")) continue;
        const hash = target.indexOf("#");
        if (hash >= 0) target = target.slice(0, hash);
        const resolved = resolve(dirname(file), target);
        if (!existsSync(resolved)) {
            fail(`Broken link in ${relative(repoRoot, file)}: ${match[1]}`);
        }
    }
}

// --- No machine-specific absolute home paths ---
const absHomeRe = /\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+/g;
for (const file of mdFiles) {
    const text = readText(file);
    const hits = text.match(absHomeRe);
    if (hits) {
        fail(`${relative(repoRoot, file)} contains absolute home path(s): ${[...new Set(hits)].join(", ")}`);
    }
}

// --- MCP tool modules covered in references ---
const toolsDir = join(repoRoot, "server/mcp");
const toolModules = readdirSync(toolsDir).filter((n) => n.endsWith("Tools.js"));
const mcpRef = join(skillRoot, "references/mcp-workflows.md");
const mcpRefText = existsSync(mcpRef) ? readText(mcpRef) : "";
for (const mod of toolModules) {
    if (!mcpRefText.includes(mod)) {
        fail(`references/mcp-workflows.md must mention ${mod}`);
    }
}

// --- Report ---
for (const w of warnings) console.warn(`WARN: ${w}`);
if (errors.length) {
    for (const e of errors) console.error(`FAIL: ${e}`);
    console.error(`\nvalidate.mjs: ${errors.length} error(s), ${warnings.length} warning(s)`);
    process.exit(1);
}
console.log(`OK: portable cev-sim plugin/skill checks passed (${warnings.length} warning(s))`);
