/**
 * Upload a canonical model closure into a vehicle stage and read every member
 * back before the editor treats the stage as the draft's model.
 */

import { createVehicleModelImportPlan } from "../model/VehicleModelImportPlan.js";

function mismatch(name) {
    const error = new Error(`Staged member "${name}" does not match the server digest.`);
    error.code = "VEHICLE_STAGE_CONFLICT";
    return error;
}

export async function stageVehicleClosure(files, client) {
    if (!Array.isArray(files) || files.length === 0) throw new Error("A staged model needs at least one file.");
    const stage = await client.createVehicleStage();
    const members = [];
    try {
        for (const file of files) {
            const uploaded = await client.uploadVehicleStageMember(stage.stageId, file.name, file.bytes);
            const remote = await client.readVehicleStageMember(stage.stageId, file.name);
            const sameDigest = remote.sha256 === uploaded.sha256 && remote.sha256 === file.sha256;
            const sameSize = Number(remote.size) === Number(file.size) && Number(uploaded.size) === Number(file.size);
            if (!sameDigest || !sameSize) throw mismatch(file.name);
            members.push({
                name: file.name,
                sha256: uploaded.sha256,
                size: Number(uploaded.size),
                mediaType: uploaded.mediaType,
            });
        }
    } catch (error) {
        await Promise.resolve(client.abandonVehicleStage?.(stage.stageId)).catch(() => {});
        throw error;
    }
    return { stageId: stage.stageId, members };
}

export async function stageVehiclePlan(files, { entryPath, client } = {}) {
    const plan = createVehicleModelImportPlan(files, { entryPath });
    const staged = await stageVehicleClosure([plan.asset, ...plan.dependencies], client);
    return { plan, staged };
}
