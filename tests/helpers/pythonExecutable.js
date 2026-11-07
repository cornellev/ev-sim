import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function selectPythonExecutable({ env = process.env, repositoryRoot = REPOSITORY_ROOT } = {}) {
    if (env.PYTHON) return env.PYTHON;
    const virtualPython = path.join(repositoryRoot, "python", ".venv", "bin", "python");
    return existsSync(virtualPython) ? virtualPython : "python3";
}

export function runPython(args, options = {}) {
    const env = options.env ?? process.env;
    const executable = selectPythonExecutable({ env });
    const result = spawnSync(executable, args, {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        ...options,
        env: { ...env, PYTHONPATH: path.join(REPOSITORY_ROOT, "python", "src") },
    });
    if (result.error || result.status !== 0) {
        const detail = result.error?.message || result.stderr || result.stdout || `exit status ${result.status}, signal ${result.signal}`;
        throw new Error(`Python check failed using ${executable}: ${detail}`);
    }
    return result;
}
