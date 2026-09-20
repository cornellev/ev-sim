import { promises as fs } from "node:fs";
import path from "node:path";

import { createPluginPackage } from "../../app/plugin/PluginPackage.js";

const fixturesRoot = path.resolve("tests/fixtures/plugins");

async function visit(root, directory = root, files = {}) {
    for (const name of (await fs.readdir(directory)).sort()) {
        const filePath = path.join(directory, name);
        const stat = await fs.lstat(filePath);
        if (stat.isDirectory()) await visit(root, filePath, files);
        else files[path.relative(root, filePath).split(path.sep).join("/")] = new Uint8Array(await fs.readFile(filePath));
    }
    return files;
}

export async function pluginFixtureFiles(fixture = "acme.example") {
    return visit(path.join(fixturesRoot, fixture));
}

export async function pluginFixtureResource({ fixture = "acme.example", mutateDocument, mutateFiles } = {}) {
    const files = await pluginFixtureFiles(fixture);
    if (mutateDocument) {
        const document = JSON.parse(new TextDecoder().decode(files["plugin.json"]));
        mutateDocument(document);
        files["plugin.json"] = new TextEncoder().encode(JSON.stringify(document, null, 2));
    }
    if (mutateFiles) mutateFiles(files);
    return createPluginPackage(files);
}
