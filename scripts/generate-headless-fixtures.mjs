import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateHeadlessCharacterization } from "../tests/helpers/headlessCharacterization.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = path.join(root, "tests", "fixtures", "headless");
const tapePath = path.join(fixtureDirectory, "action-tape.v1.json");
const characterizationPath = path.join(fixtureDirectory, "characterization.v1.json");

const tape = JSON.parse(await readFile(tapePath, "utf8"));
const characterization = await generateHeadlessCharacterization(tape);
await writeFile(characterizationPath, `${JSON.stringify(characterization, null, 2)}\n`);

process.stdout.write(`${path.relative(root, characterizationPath)}\n`);
