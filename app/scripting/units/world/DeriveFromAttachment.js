import Unit from "../Unit";
import { useState } from "react";
import { requestUnitReconfiguration } from "../../ScriptManager.js";
import { ATTACHMENT_HOSTS, normalizeHostType } from "./attachmentHosts.js";
import { deriveAttachmentPorts } from "./DeriveFromAttachment.block.js";

function attachmentUnit(title, hostType) {
    const ports = deriveAttachmentPorts({ hostType });
    function AttachmentUnit({ _uuid }) {
        return (
            <Unit
                title={title}
                hasOptions={false}
                _uuid={_uuid}
                inputs={[]}
                outputs={[...ports.outputs]}
            />
        );
    }
    AttachmentUnit.displayName = `${title.replace(/\s+/g, "")}Unit`;
    return AttachmentUnit;
}

export const GeneralAttachmentUnit = attachmentUnit("General Attachment", "general");
export const RoadAttachmentUnit = attachmentUnit("Road Attachment", "road");
export const GroupAttachmentUnit = attachmentUnit("Group Attachment", "group");
export const BuildingAttachmentUnit = attachmentUnit("Building Attachment", "building");
export const IntersectionAttachmentUnit = attachmentUnit("Intersection Attachment", "intersection");
export const PropAttachmentUnit = attachmentUnit("Prop Attachment", "builtin-prop");
export const AssetAttachmentUnit = attachmentUnit("Asset Attachment", "asset-instance");

export function DeriveFromAttachmentUnit({ _uuid, initialState = {} }) {
    const [hostType, setHostType] = useState(() => normalizeHostType(initialState.hostType) ?? "road");
    const ports = deriveAttachmentPorts({ hostType });

    const commit = (next) => {
        const normalized = normalizeHostType(next) ?? "road";
        const result = requestUnitReconfiguration(_uuid, { state: { hostType: normalized } });
        if (result?.ok !== false) setHostType(normalized);
    };

    return (
        <Unit
            title="Derive From Attachment"
            hasOptions={true}
            _uuid={_uuid}
            inputs={[]}
            outputs={[...ports.outputs]}
        >
            <label className="flex flex-col gap-1.5 text-xs text-zinc-300">
                <span className="text-zinc-400">Host type</span>
                <select
                    aria-label="Host type"
                    value={hostType}
                    className="w-full rounded-sm border border-white/10 bg-[var(--slate-bg)] px-2.5 py-1.5 text-white outline-none"
                    onChange={(event) => commit(event.target.value)}
                >
                    {Object.entries(ATTACHMENT_HOSTS).map(([id, spec]) => (
                        <option key={id} value={id}>{spec.label}</option>
                    ))}
                </select>
            </label>
        </Unit>
    );
}

export {
    AssetAttachmentBlock,
    BuildingAttachmentBlock,
    DeriveFromAttachmentBlock,
    GeneralAttachmentBlock,
    GroupAttachmentBlock,
    IntersectionAttachmentBlock,
    PropAttachmentBlock,
    RoadAttachmentBlock,
} from "./DeriveFromAttachment.block.js";
