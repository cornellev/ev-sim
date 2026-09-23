import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function localFile(specifier, context) {
    if (specifier.startsWith("@/")) return path.join(root, specifier.slice(2));
    if (specifier.startsWith("file:")) return fileURLToPath(specifier);
    if (specifier.startsWith(".")) {
        const parent = context.parentURL ? fileURLToPath(context.parentURL) : root;
        return path.resolve(path.dirname(parent), specifier);
    }
    return null;
}

function withExtension(filePath) {
    if (existsSync(filePath) && statSync(filePath).isFile()) return filePath;
    if (existsSync(`${filePath}.js`)) return `${filePath}.js`;
    if (existsSync(path.join(filePath, "index.js"))) return path.join(filePath, "index.js");
    return null;
}

function packageFile(specifier) {
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:") || specifier.includes(":")) {
        return null;
    }
    return withExtension(path.join(root, "node_modules", specifier));
}

export async function resolve(specifier, context, nextResolve) {
    const filePath = localFile(specifier, context);
    if (filePath) {
        const resolved = withExtension(filePath);
        if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
    }
    try {
        return await nextResolve(specifier, context);
    } catch (error) {
        if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
        const packaged = packageFile(specifier);
        if (packaged) return { url: pathToFileURL(packaged).href, shortCircuit: true };
        throw error;
    }
}
