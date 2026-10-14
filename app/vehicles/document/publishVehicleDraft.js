/**
 * Save the session's captured draft through the publication API.
 * A failed save keeps the draft and any staged-resource reference.
 */
export async function publishVehicleDraft(session, client, { operationId } = {}) {
    if (!operationId) throw new Error("operationId is required.");
    const capture = session.beginSave();
    const stage = session.stagedResources;
    try {
        if (stage?.stageId && Array.isArray(stage.members)) {
            for (const member of stage.members) {
                const remote = await client.readVehicleStageMember(stage.stageId, member.name);
                if (remote.sha256 !== member.sha256 || Number(remote.size) !== Number(member.size)) {
                    const error = new Error(`Staged member "${member.name}" does not match the server digest.`);
                    error.code = "VEHICLE_STAGE_CONFLICT";
                    throw error;
                }
            }
        }
        const stored = await client.saveVehicleManifest(
            capture.manifest.id,
            capture.manifest,
            session.baseline.revision,
            { stageId: stage?.stageId ?? null, operationId },
        );
        return {
            ...session.acknowledgeSave({
                generation: capture.generation,
                revision: stored.revision,
                definitionHash: stored.definitionHash,
            }),
            stored,
        };
    } catch (error) {
        session.failSave();
        throw error;
    }
}
