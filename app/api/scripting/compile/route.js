export const runtime = "nodejs";

/**
 * POST /api/scripting/compile is owned by Express (`createScriptingRouter`) so
 * compilation can load exact graph pluginLocks from StorageService.
 */
export async function POST() {
    return Response.json({
        ok: false,
        error: "Script compilation is served by the Express scripting router.",
    }, { status: 410 });
}
