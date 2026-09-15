import { registerBuiltInBlocks } from "@/app/scripting/registerBuiltInBlocks";
import { getRegisteredBlockType } from "@/app/scripting/BlockRegistry";
import { restoreManagerFromGraph, formatRestoreErrors } from "@/app/scripting/GraphDocument";

export const runtime = "nodejs";

/**
 * POST /api/scripting/compile
 * Body: { graph, name? }
 * Compiles a visual-script graph into a v3 artifact (or returns the error).
 * Response remains `{ ok, artifact }` with `artifact.version === 3`. The runtime
 * also accepts frozen v2 artifacts.
 */
export async function POST(request) {
    try {
        const body = await request.json();
        const graph = body?.graph;
        const name = body?.name || "compiled-program";

        if (!graph || typeof graph !== "object") {
            return Response.json({ ok: false, error: "Missing graph." }, { status: 400 });
        }

        registerBuiltInBlocks();
        const manager = restoreManagerFromGraph(graph, getRegisteredBlockType);
        if (manager.restoreErrors?.length) {
            throw new Error(formatRestoreErrors(manager.restoreErrors));
        }
        const artifact = manager.compile(name);
        return Response.json({ ok: true, artifact });
    } catch (error) {
        return Response.json({
            ok: false,
            error: error?.message || String(error),
        });
    }
}
