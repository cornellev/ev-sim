import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MIGRATION_CEV_SIM_ENGINE_RANGE } from "../app/plugin/PluginEngineRange.js";
import { scaffoldPlantFiles } from "./create-cev-plugin.mjs";
import { encodeBicyclePlantModule } from "./plant-wasm-module.mjs";

const destination = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../tests/fixtures/plugins/test.plant-fixture",
);
const scaffold = scaffoldPlantFiles({ id: "test.plant-fixture" });
scaffold.document.engines.cevSim = MIGRATION_CEV_SIM_ENGINE_RANGE;
scaffold.files["plugin.json"] = `${JSON.stringify(scaffold.document, null, 2)}\n`;
scaffold.files[".gitignore"] = "/target/\n";
scaffold.files["plant.wasm"] = encodeBicyclePlantModule();

await fs.rm(destination, { recursive: true, force: true });
for (const [relative, contents] of Object.entries(scaffold.files)) {
    const filePath = path.join(destination, relative);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
}
process.stdout.write(`Wrote ${destination}\n`);
