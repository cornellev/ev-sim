import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { constants } from "node:fs";
import path from "node:path";

import { VISUAL_ASSET_ERROR_CODES, visualAssetError } from "../StorageErrors.js";

export async function maybeFault(faults, name) {
    const fault = faults?.[name];
    if (!fault) return;
    if (typeof fault === "function") await fault(name);
}

export function mapFsError(error) {
    if (error?.code === "ENOSPC" || error?.code === VISUAL_ASSET_ERROR_CODES.DISK_FULL) {
        return visualAssetError(VISUAL_ASSET_ERROR_CODES.DISK_FULL, "Visual asset storage is out of disk space.");
    }
    if (error?.code === VISUAL_ASSET_ERROR_CODES.SHORT_WRITE || error?.code === "ESHORT") {
        return visualAssetError(VISUAL_ASSET_ERROR_CODES.SHORT_WRITE, "Visual asset write was shorter than requested.");
    }
    return error;
}

export async function fsyncFile(filePath, faults) {
    await maybeFault(faults, "fsync");
    const handle = await fs.open(filePath, "r+");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export async function fsyncDir(dirPath, faults) {
    await maybeFault(faults, "dirFsync");
    const handle = await fs.open(dirPath, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export async function openRegularFile(filePath, flags = constants.O_RDONLY) {
    let lstat;
    try {
        lstat = await fs.lstat(filePath);
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
    if (lstat.isSymbolicLink()) {
        throw visualAssetError(VISUAL_ASSET_ERROR_CODES.SYMLINK, "Visual asset paths must be regular files, not symlinks.");
    }
    if (!lstat.isFile()) {
        throw visualAssetError(VISUAL_ASSET_ERROR_CODES.CORRUPT, "Visual asset paths must be regular files.");
    }
    const follow = constants.O_NOFOLLOW ?? 0;
    const numericFlags = typeof flags === "string"
        ? (flags.includes("w") ? constants.O_RDWR : constants.O_RDONLY) | follow
        : flags | follow;
    const handle = await fs.open(filePath, numericFlags);
    try {
        const stat = await handle.stat();
        if (stat.isSymbolicLink?.() || !stat.isFile()) {
            throw visualAssetError(VISUAL_ASSET_ERROR_CODES.SYMLINK, "Visual asset paths must be regular files, not symlinks.");
        }
        return { handle, stat };
    } catch (error) {
        await handle.close();
        throw error;
    }
}

export async function hashRegularFile(filePath) {
    const opened = await openRegularFile(filePath);
    if (!opened) return null;
    const { handle, stat } = opened;
    try {
        const hasher = createHash("sha256");
        const stream = handle.createReadStream();
        for await (const chunk of stream) hasher.update(chunk);
        return { digest: hasher.digest("hex"), size: stat.size, mtimeNs: stat.mtimeNs, ino: stat.ino };
    } finally {
        await handle.close();
    }
}

export async function writeExclusiveFile(filePath, bytes, { faults, encoding } = {}) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    const handle = await fs.open(tempPath, "w");
    try {
        await maybeFault(faults, "write");
        const buffer = Buffer.isBuffer(bytes) || bytes instanceof Uint8Array
            ? Buffer.from(bytes)
            : Buffer.from(String(bytes), encoding ?? "utf8");
        const written = await handle.write(buffer, 0, buffer.length, 0);
        if (written.bytesWritten !== buffer.length) {
            throw visualAssetError(VISUAL_ASSET_ERROR_CODES.SHORT_WRITE, "Visual asset write was shorter than requested.");
        }
        await maybeFault(faults, "fsync");
        await handle.sync();
    } catch (error) {
        await handle.close().catch(() => {});
        await fs.rm(tempPath, { force: true });
        throw mapFsError(error);
    }
    await handle.close();
    try {
        await maybeFault(faults, "link");
        await fs.link(tempPath, filePath);
    } catch (error) {
        await fs.rm(tempPath, { force: true });
        if (error.code === "EEXIST") {
            return { existed: true, path: filePath };
        }
        throw mapFsError(error);
    }
    await fs.rm(tempPath, { force: true });
    await fsyncDir(path.dirname(filePath), faults);
    return { existed: false, path: filePath };
}

export async function streamToFile(readable, destPath, { expectedBytes, maxBytes, faults } = {}) {
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    const handle = await fs.open(destPath, "w");
    const hasher = createHash("sha256");
    let received = 0;
    try {
        for await (const chunk of readable) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            received += buffer.length;
            if (maxBytes != null && received > maxBytes) {
                throw visualAssetError(
                    VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                    `Visual asset exceeded the ${maxBytes}-byte request limit.`,
                );
            }
            if (expectedBytes != null && received > expectedBytes) {
                throw visualAssetError(
                    VISUAL_ASSET_ERROR_CODES.INVALID_METADATA,
                    "Visual asset stream exceeded the declared Content-Length.",
                );
            }
            hasher.update(buffer);
            await maybeFault(faults, "write");
            const written = await handle.write(buffer);
            if (written.bytesWritten !== buffer.length) {
                throw visualAssetError(VISUAL_ASSET_ERROR_CODES.SHORT_WRITE, "Visual asset write was shorter than requested.");
            }
        }
        if (expectedBytes != null && received !== expectedBytes) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.INVALID_METADATA,
                `Visual asset stream ended after ${received} bytes; expected ${expectedBytes}.`,
            );
        }
        await maybeFault(faults, "fsync");
        await handle.sync();
    } catch (error) {
        throw mapFsError(error);
    } finally {
        await handle.close();
    }
    await fsyncDir(path.dirname(destPath), faults);
    return { received, digest: hasher.digest("hex") };
}

export async function exclusiveLink(fromPath, toPath, faults) {
    await fs.mkdir(path.dirname(toPath), { recursive: true });
    try {
        await maybeFault(faults, "link");
        await fs.link(fromPath, toPath);
        await fsyncFile(toPath, faults);
        await fsyncDir(path.dirname(toPath), faults);
        return { existed: false };
    } catch (error) {
        if (error.code === "EEXIST") return { existed: true };
        throw mapFsError(error);
    }
}

export async function writeJsonExclusive(filePath, value, faults) {
    const bytes = `${JSON.stringify(value)}\n`;
    return writeExclusiveFile(filePath, bytes, { faults });
}
