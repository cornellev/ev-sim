import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
    fsyncDir,
    openRegularFile,
} from "../../storage/visual-assets/atomicFs.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { REGISTRY_DIRECTORY_MODE, REGISTRY_FILE_MODE } from "./RegistryLayout.js";

function hostile(nodePath, message) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, `${message}: ${nodePath}`, { path: nodePath });
}

export async function lstatOrNull(nodePath) {
    try {
        return await fs.lstat(nodePath);
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

export async function requireDirectory(nodePath) {
    const stat = await lstatOrNull(nodePath);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw hostile(nodePath, "Expected a regular registry directory");
    return stat;
}

export async function ensureDirectory(nodePath) {
    const existing = await lstatOrNull(nodePath);
    if (existing) {
        if (!existing.isDirectory() || existing.isSymbolicLink()) throw hostile(nodePath, "Registry path is not a directory");
        await fs.chmod(nodePath, REGISTRY_DIRECTORY_MODE);
        return;
    }
    await fs.mkdir(nodePath, { recursive: true, mode: REGISTRY_DIRECTORY_MODE });
    await requireDirectory(nodePath);
    await fs.chmod(nodePath, REGISTRY_DIRECTORY_MODE);
}

export async function ensureDirectoryWithin(root, nodePath) {
    const resolvedRoot = path.resolve(root);
    const resolvedNode = path.resolve(nodePath);
    const relative = path.relative(resolvedRoot, resolvedNode);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw hostile(resolvedNode, "Registry directory escapes its managed root");
    await requireDirectory(resolvedRoot);
    let current = resolvedRoot;
    for (const part of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        const existing = await lstatOrNull(current);
        if (existing) {
            if (!existing.isDirectory() || existing.isSymbolicLink()) throw hostile(current, "Registry path is not a directory");
        } else {
            await fs.mkdir(current, { mode: REGISTRY_DIRECTORY_MODE });
            await fsyncDir(path.dirname(current));
        }
        await fs.chmod(current, REGISTRY_DIRECTORY_MODE);
    }
}

async function writeAll(handle, bytes) {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
        if (bytesWritten <= 0) throw new Error("Registry write made no progress.");
        offset += bytesWritten;
    }
}

export async function writeExclusiveDurable(filePath, rawBytes) {
    const bytes = Buffer.from(rawBytes);
    await ensureDirectory(path.dirname(filePath));
    let handle;
    let created = false;
    try {
        handle = await fs.open(filePath, "wx", REGISTRY_FILE_MODE);
        created = true;
        await writeAll(handle, bytes);
        await handle.sync();
        await handle.chmod(REGISTRY_FILE_MODE);
        await handle.close();
        handle = null;
        await fsyncDir(path.dirname(filePath));
    } catch (error) {
        await handle?.close().catch(() => {});
        if (created) await fs.rm(filePath, { force: true }).catch(() => {});
        throw error;
    }
}

export async function atomicReplaceDurable(filePath, rawBytes) {
    const bytes = Buffer.from(rawBytes);
    const parent = path.dirname(filePath);
    await ensureDirectory(parent);
    const temporary = path.join(parent, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    try {
        await writeExclusiveDurable(temporary, bytes);
        await fs.rename(temporary, filePath);
        await fsyncDir(parent);
    } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
    }
}

export async function readRegularBytes(filePath, { maxBytes = 64 * 1024 * 1024 } = {}) {
    let opened;
    try {
        opened = await openRegularFile(filePath);
    } catch (error) {
        throw hostile(filePath, `Registry file is not a stable regular file (${error.message})`);
    }
    if (!opened) throw hostile(filePath, "Required registry file is missing");
    try {
        if (opened.stat.size > maxBytes) throw hostile(filePath, `Registry file exceeds ${maxBytes} bytes`);
        return await opened.handle.readFile();
    } finally {
        await opened.handle.close();
    }
}

export async function hashRegularFile(filePath, expectedSize) {
    let opened;
    try {
        opened = await openRegularFile(filePath);
    } catch (error) {
        throw hostile(filePath, `Registry file is not a stable regular file (${error.message})`);
    }
    if (!opened) throw hostile(filePath, "Required registry file is missing or not regular");
    try {
        if (expectedSize !== undefined && opened.stat.size !== expectedSize) {
            throw hostile(filePath, "Registry file size does not match its record");
        }
        const hash = createHash("sha256");
        for await (const chunk of opened.handle.createReadStream({ autoClose: false })) hash.update(chunk);
        return { sha256: hash.digest("hex"), sizeBytes: opened.stat.size };
    } finally {
        await opened.handle.close();
    }
}

export async function verifyRegularFile(filePath, sha256, sizeBytes) {
    const actual = await hashRegularFile(filePath, sizeBytes);
    if (actual.sha256 !== sha256) throw hostile(filePath, "Registry file digest does not match its record");
    return actual;
}

export async function publishImmutableFile(stagedPath, destinationPath, sha256, sizeBytes, managedRoot = null) {
    const existing = await lstatOrNull(destinationPath);
    if (existing) {
        await verifyRegularFile(destinationPath, sha256, sizeBytes);
        await fs.rm(stagedPath, { force: true });
        return false;
    }
    if (managedRoot) await ensureDirectoryWithin(managedRoot, path.dirname(destinationPath));
    else await ensureDirectory(path.dirname(destinationPath));
    await verifyRegularFile(stagedPath, sha256, sizeBytes);
    try {
        await fs.link(stagedPath, destinationPath);
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        await verifyRegularFile(destinationPath, sha256, sizeBytes);
        await fs.rm(stagedPath, { force: true });
        return false;
    }
    await fs.chmod(destinationPath, REGISTRY_FILE_MODE);
    await fs.rm(stagedPath, { force: true });
    await fsyncDir(path.dirname(destinationPath));
    return true;
}

export async function removeDirectoryDurable(directory) {
    const parent = path.dirname(directory);
    await fs.rm(directory, { recursive: true, force: true });
    await fsyncDir(parent).catch((error) => {
        if (error.code !== "ENOENT") throw error;
    });
}
