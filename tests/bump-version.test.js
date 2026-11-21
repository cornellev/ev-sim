import assert from "node:assert/strict";
import test from "node:test";

import {
    HAND_EDIT_PATHS,
    bumpSources,
    pluginsExcludingVersion,
    reminderLines,
} from "../scripts/bump-version.mjs";

function fixture(version = "0.3.0") {
    return {
        packageJson: `{\n  "name": "cev-sim",\n  "version": "${version}",\n  "private": true\n}\n`,
        pluginJson: `{\n  "name": "cev-sim",\n  "version": "${version}"\n}\n`,
        versionJs: `/** still ${version} in a comment */\nexport const CEV_SIM_VERSION = "${version}";\n`,
        pyproject: `[project]\nversion = "${version}"\n`,
        pythonInit: `__version__ = "${version}"\nNOTE = "still ${version}"\n`,
        packageLock: `{\n  "name": "cev-sim",\n  "version": "${version}",\n  "packages": {\n    "": {\n      "version": "${version}"\n    },\n    "decoy": {\n      "version": "${version}"\n    }\n  }\n}\n`,
    };
}

test("bump rewrites only the coordinated version fields", () => {
    const sources = fixture();
    const result = bumpSources(sources, "0.4.0");
    assert.equal(result.wrote, true);
    assert.equal(result.current, "0.3.0");
    assert.match(result.sources.packageJson, /"version": "0.4.0"/);
    assert.match(result.sources.pluginJson, /"version": "0.4.0"/);
    assert.match(result.sources.versionJs, /export const CEV_SIM_VERSION = "0.4.0"/);
    assert.match(result.sources.versionJs, /still 0\.3\.0 in a comment/);
    assert.match(result.sources.pyproject, /^version = "0.4.0"$/m);
    assert.match(result.sources.pythonInit, /^__version__ = "0.4.0"$/m);
    assert.match(result.sources.pythonInit, /NOTE = "still 0.3.0"/);
    assert.match(result.sources.packageLock, /"decoy": \{\n      "version": "0.3.0"/);
    assert.equal(JSON.parse(result.sources.packageLock).version, "0.4.0");
    assert.equal(JSON.parse(result.sources.packageLock).packages[""].version, "0.4.0");
    assert.equal(sources.packageJson.includes("0.4.0"), false);
});

test("dry run leaves the source text unchanged", () => {
    const sources = fixture();
    const result = bumpSources(sources, "0.4.0", { dryRun: true });
    assert.equal(result.wrote, false);
    assert.equal(result.sources, sources);
    assert.equal(sources.packageLock.includes("0.4.0"), false);
});

test("bump refuses drifted, unparsed, and non-increasing versions", () => {
    const drifted = fixture();
    drifted.pluginJson = drifted.pluginJson.replace("0.3.0", "0.2.0");
    assert.throws(() => bumpSources(drifted, "0.4.0"), /Coordinated package versions differ/);
    assert.throws(() => bumpSources(fixture(), "v0.4.0"), /strict SemVer/);
    assert.throws(() => bumpSources(fixture(), "0.3.0"), /not greater/);
    assert.throws(() => bumpSources(fixture(), "0.2.0"), /not greater/);
});

test("reminders name the hand edits and only the example ranges that exclude the new version", () => {
    const excluded = pluginsExcludingVersion([
        { file: "examples/plugins/acme.dynamics.bicycle/plugin.json", range: ">=0.3.0 <0.4.0" },
        { file: "examples/plugins/wide/plugin.json", range: ">=0.1.0 <0.5.0" },
    ], "0.4.0");
    const text = reminderLines({
        next: "0.4.0",
        migrationRange: ">=0.1.0 <0.4.0",
        scaffoldRange: ">=0.4.0 <0.5.0",
        excludedExamples: excluded,
    }).join("\n");
    for (const file of HAND_EDIT_PATHS) assert.match(text, new RegExp(file.replaceAll(".", "\\.")));
    assert.match(text, /docs\/release-0\.4\.0-notes\.md/);
    assert.match(text, /docs\/release-0\.3\.0-notes\.md/);
    assert.match(text, /MIGRATION_CEV_SIM_ENGINE_RANGE/);
    assert.match(text, /scripts\/generate-plant-fixture\.mjs/);
    assert.match(text, /acme\.dynamics\.bicycle/);
    assert.doesNotMatch(text, /examples\/plugins\/wide/);
    assert.match(text, /does not change engine ranges/);

    const patch = reminderLines({
        next: "0.3.1",
        migrationRange: ">=0.1.0 <0.4.0",
        scaffoldRange: ">=0.3.1 <0.4.0",
        excludedExamples: pluginsExcludingVersion([
            { file: "examples/plugins/wide/plugin.json", range: ">=0.1.0 <0.4.0" },
        ], "0.3.1"),
    }).join("\n");
    assert.doesNotMatch(patch, /MIGRATION_CEV_SIM_ENGINE_RANGE/);
    assert.doesNotMatch(patch, /examples\/plugins\/wide/);
});
