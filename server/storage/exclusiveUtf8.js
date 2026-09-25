import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Exclusive create via a temp file and link(2). An existing identical body is
 * success. A different body is a digest collision.
 */
export async function writeExclusiveUtf8(filePath, body, collisionMessage) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, body, "utf8");
    try {
        await fs.link(tempPath, filePath);
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await fs.readFile(filePath, "utf8");
        if (existing !== body) {
            throw new Error(collisionMessage(path.basename(filePath)));
        }
    } finally {
        await fs.rm(tempPath, { force: true });
    }
}
