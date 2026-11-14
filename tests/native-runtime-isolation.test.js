import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Parser } from "acorn";
import jsx from "acorn-jsx";

const parser = Parser.extend(jsx());
const root = path.resolve(import.meta.dirname, "..");
const retired = /server\/interfaces\/historical\/|server\/interfaces\/NativeRunMigration\.js$|server\/headless\/RunBundleInspection\.js$|app\/client\/(?:Client|TopicCodec|ProtobufChannel)\.js$|\/(?:AutonomyContractCatalog|SensorMessages|SensorEncodePool|HeadlessMessageCodec|ensureOrchestrator|sensorEncode\.worker|ROSUnit(?:\.block)?)\.js$/;

function imports(source) {
    const found = [];
    function visit(node) {
        if (!node || typeof node !== "object") return;
        if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type)) {
            const source = node.source;
            if (typeof source?.value === "string") found.push(source.value);
            else if (source?.type === "TemplateLiteral" && source.expressions.length === 0) found.push(source.quasis[0].value.cooked);
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === "object") visit(value);
        }
    }
    visit(parser.parse(source, { ecmaVersion: "latest", sourceType: "module" }));
    return found;
}

test("browser and worker execution graphs cannot import historical or retired runtime modules", () => {
    const visited = new Set();
    function walk(file, chain = []) {
        file = path.resolve(file);
        if (visited.has(file)) return;
        visited.add(file);
        const relative = path.relative(root, file).replaceAll(path.sep, "/");
        assert.equal(retired.test(relative), false, [...chain, relative].join(" -> "));
        const source = readFileSync(file, "utf8");
        assert.doesNotMatch(source, /NEXT_PUBLIC_ORCHESTRATOR|https?:\/\/(?:localhost|127\.0\.0\.1):8090|wss?:\/\/(?:localhost|127\.0\.0\.1):8080/, relative);
        for (const specifier of imports(source)) {
            if (!specifier.startsWith(".")) continue;
            const base = path.resolve(path.dirname(file), specifier);
            const target = [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")].find(existsSync);
            assert.ok(target, `${relative} imports missing ${specifier}`);
            if (/\.m?js$/.test(target)) walk(target, [...chain, relative]);
        }
    }
    for (const entry of ["app/simulation/kernel/SimulationKernel.js", "app/simulation/headless/HeadlessEpisode.js", "server/headless/HeadlessWorker.js", "server/headless/HeadlessRunner.js", "server/headless/HeadlessExternalSession.js", "app/3d/managers/ClientManager.js", "app/3d/data/DeviceDatabase.js", "app/3d/Scene.js", "app/config/ConfigPage.js"]) walk(path.join(root, entry));
    assert.ok(visited.size > 200);
});

test("orchestrator modules and message assets are absent", () => {
    for (const file of ["server/ensureOrchestrator.js", "app/client/Client.js", "app/client/TopicCodec.js", "app/client/ProtobufChannel.js", "app/autonomy/AutonomyContractCatalog.js", "app/simulation/sensors/SensorMessages.js", "app/3d/devices/SensorEncodePool.js", "app/3d/devices/sensorEncode.worker.js", "app/simulation/sensors/HeadlessMessageCodec.js", "public/messages/std_msgs/msg/Header.msg"]) assert.equal(existsSync(path.join(root, file)), false, file);
});
