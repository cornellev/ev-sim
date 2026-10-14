import { useState } from "react";
import { requestUnitReconfiguration } from "../../ScriptManager.js";
import Unit from "../Unit";
import { ATTACHMENT_HOSTS, normalizeHostType } from "./attachmentHosts.js";
import { deriveAttachmentPorts } from "./DeriveFromAttachment.block.js";

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

export { DeriveFromAttachmentBlock } from "./DeriveFromAttachment.block.js";
