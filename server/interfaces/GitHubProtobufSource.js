import { parseGitHubVehicleUrl } from "../../app/vehicles/urdf/github/parseGitHubUrl.js";
import { gitSubmoduleAncestor, gitTreeIssue } from "../../app/vehicles/urdf/github/gitTree.js";
import { assertProtoPath, PROTOBUF_LIMITS } from "../../app/interfaces/ProtobufSchema.js";
import { GitHubUrdfClient } from "../vehicles/GitHubUrdfClient.js";
import { loadProtoSources, PROTOBUF_SOURCE_LIMITS, resolveProtoSelection } from "./ProtobufSourceLoader.js";

export class GitHubProtobufSource {
    constructor({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
        this.fetchImpl = fetchImpl;
        this.now = now;
    }

    async resolveCommit(source, { signal } = {}) {
        if (typeof source.url !== "string" || source.url.length > 2048) throw new Error("Select a public GitHub repository or file URL.");
        const parsed = parseGitHubVehicleUrl(source.url);
        if (!parsed.ok) throw new Error(parsed.diagnostics[0].message);
        let reference = parsed.url;
        if (source.ref !== undefined) {
            if (reference.kind !== "repository" || typeof source.ref !== "string" || !source.ref.length || source.ref.length > 256
                || /[\s?#\\\u0000-\u001f]/.test(source.ref) || source.ref.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Use an explicit GitHub ref with a repository URL.");
            const entry = assertProtoPath(source.entryFiles?.[0]);
            reference = { ...reference, kind: "blob", refPath: `${source.ref}/${entry}` };
        }
        const client = new GitHubUrdfClient({
            fetchImpl: this.fetchImpl, now: this.now, signal,
            limits: { maxFiles: PROTOBUF_LIMITS.files, maxFileBytes: PROTOBUF_SOURCE_LIMITS.fileBytes, maxPackageBytes: PROTOBUF_SOURCE_LIMITS.totalBytes },
        });
        const pin = await client.pin(reference);
        const requestedSha = reference.refPath?.split("/")[0];
        if (/^[a-f0-9]{40}$/i.test(requestedSha) && pin.commitSha !== requestedSha.toLowerCase()) throw new Error("GitHub resolved a different commit than the requested SHA.");
        return { ...pin, client };
    }

    async fetchImportClosure(pin, { entryFiles, includeDirs = [] } = {}) {
        const selected = entryFiles ?? (pin.path ? [pin.path] : []);
        const selection = resolveProtoSelection(selected, includeDirs);
        const tree = await pin.client.tree(pin);
        const schema = await loadProtoSources(selection.names, { readSource: async (name) => {
            const paths = selection.roots.map((root) => root ? `${root}/${name}` : name);
            for (const file of paths) {
                const parent = gitSubmoduleAncestor(tree.entries, file);
                if (parent) throw new Error(`Protobuf import enters submodule "${parent.path}".`);
            }
            const matches = paths.filter((file) => tree.entries.has(file));
            if (matches.length !== 1) throw new Error(`${matches.length ? "Ambiguous" : "Unresolved"} protobuf import "${name}".`);
            const file = matches[0];
            const entry = tree.entries.get(file);
            const issue = gitTreeIssue(entry, file);
            if (issue || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)
                || !/^[a-f0-9]{40}$/.test(entry.sha)) throw new Error(issue?.message ?? `Invalid GitHub protobuf file "${file}".`);
            return { path: file, bytes: await pin.client.blob(pin, entry) };
        } });
        return {
            ...schema,
            source: {
                schemaId: null, kind: "github", repository: { owner: pin.owner, repo: pin.repo },
                requestedRef: pin.requestedRef, resolvedCommitSha: pin.commitSha,
                entryFiles: [...selected], includeDirs: [...includeDirs], files: schema.files,
            },
        };
    }
}
