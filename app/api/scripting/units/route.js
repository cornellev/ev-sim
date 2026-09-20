export const runtime = "nodejs";

/**
 * GET /api/scripting/units is owned by Express (`createScriptingRouter`) so the
 * catalog can include the revisioned plugin library from StorageService.
 */
export async function GET() {
    return Response.json({
        ok: false,
        error: "Unit catalog is served by the Express scripting router.",
        units: [],
    }, { status: 410 });
}
