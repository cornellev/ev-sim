import { registerBuiltInBlocks } from "@/app/scripting/registerBuiltInBlocks";
import { getRegisteredBlockType } from "@/app/scripting/BlockRegistry";
import { restoreManagerFromGraph } from "@/app/scripting/GraphDocument";

export const runtime = "nodejs";

/**
 * POST /api/scripting/compile
 * Body: { graph, name? }
 * Compiles a visual-script graph into a v2 artifact (or returns the error).
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
        const artifact = manager.compile(name);
        return Response.json({ ok: true, artifact });
    } catch (error) {
        return Response.json({
            ok: false,
            error: error?.message || String(error),
        });
    }
}
