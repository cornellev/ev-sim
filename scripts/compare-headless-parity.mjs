#!/usr/bin/env node

import { promises as fs } from "node:fs";
import process from "node:process";

import { compareParityReports } from "../server/headless/ReleaseReports.js";

async function main() {
    const files = process.argv.slice(2);
    if (files.length < 2) throw new Error("Usage: compare-headless-parity <baseline.json> <candidate.json> [...candidate.json]");
    const [baseline, ...candidates] = await Promise.all(files.map(async (file) => (
        JSON.parse(await fs.readFile(file, "utf8"))
    )));
    const comparisons = candidates.map((candidate) => compareParityReports(baseline, candidate));
    const result = { ok: comparisons.every((entry) => entry.ok), comparisons };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
