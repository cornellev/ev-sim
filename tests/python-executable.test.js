import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runPython, selectPythonExecutable } from "./helpers/pythonExecutable.js";

function temporaryRepository(context) {
    const root = mkdtempSync(path.join(os.tmpdir(), "cev-python-selector-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

test("an explicit PYTHON override wins over the project venv", (context) => {
    const root = temporaryRepository(context);
    const virtualPython = path.join(root, "python", ".venv", "bin", "python");
    mkdirSync(path.dirname(virtualPython), { recursive: true });
    writeFileSync(virtualPython, "");
    assert.equal(selectPythonExecutable({ env: { PYTHON: "/chosen/python" }, repositoryRoot: root }), "/chosen/python");
});

test("an existing project venv wins over python3 on PATH", (context) => {
    const root = temporaryRepository(context);
    const virtualPython = path.join(root, "python", ".venv", "bin", "python");
    mkdirSync(path.dirname(virtualPython), { recursive: true });
    writeFileSync(virtualPython, "");
    assert.equal(selectPythonExecutable({ env: {}, repositoryRoot: root }), virtualPython);
    assert.equal(selectPythonExecutable({ env: { PYTHON: "" }, repositoryRoot: root }), virtualPython);
});

test("python3 is selected when neither an override nor a project venv exists", (context) => {
    const root = temporaryRepository(context);
    assert.equal(selectPythonExecutable({ env: {}, repositoryRoot: root }), "python3");
});

test("an invalid explicit Python fails with the selected path instead of falling back", (context) => {
    const root = temporaryRepository(context);
    const executable = path.join(root, "missing-python");
    assert.throws(() => runPython(["-c", "print('unexpected fallback')"], {
        env: { ...process.env, PYTHON: executable },
    }), (error) => error.message.includes(executable) && error.message.includes("ENOENT"));
});

test("a failing selected Python is not replaced by another interpreter", (context) => {
    const root = temporaryRepository(context);
    const executable = path.join(root, "failing-python");
    writeFileSync(executable, "#!/bin/sh\nprintf 'dependency failure' >&2\nexit 42\n", { mode: 0o755 });
    assert.throws(() => runPython([], {
        env: { ...process.env, PYTHON: executable },
    }), (error) => error.message.includes(executable) && error.message.includes("dependency failure"));
});

test("Python checks use absolute repository and source paths", (context) => {
    const root = temporaryRepository(context);
    const executable = path.join(root, "probe-python");
    writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$PYTHONPATH\"\n", { mode: 0o755 });
    const result = runPython([], { env: { ...process.env, PYTHON: executable } });
    const [cwd, pythonPath] = result.stdout.trim().split("\n");
    const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
    assert.equal(cwd, path.resolve(repositoryRoot));
    assert.equal(pythonPath, path.join(repositoryRoot, "python", "src"));
});
