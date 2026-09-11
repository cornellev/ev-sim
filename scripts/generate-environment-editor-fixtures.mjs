import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateEnvironmentEditorBaseline } from "../tests/helpers/environmentEditorBaseline.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(root, "tests", "fixtures", "environment-editor", "compatibility-baseline.v1.json");

const baseline = await generateEnvironmentEditorBaseline();
await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);

process.stdout.write(`${path.relative(root, baselinePath)}\n`);
