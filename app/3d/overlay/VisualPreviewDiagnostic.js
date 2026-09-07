'use client';

import { useEffect, useState } from "react";
import { IconAlertTriangle, IconLoader2, IconRefresh } from "@tabler/icons-react";

const MESSAGES = {
    VISUAL_PREVIEW_ACCESS_MISSING: "Visual preview needs a descriptor access hash.",
    VISUAL_PREVIEW_DESCRIPTOR_MISSING: "Visual-layer descriptor is missing.",
    VISUAL_PREVIEW_ASSET_MISSING: "A required visual asset is missing.",
    VISUAL_PREVIEW_RIGHTS_DENIED: "Display rights deny this visual preview.",
    VISUAL_PREVIEW_MATERIAL_MISMATCH: "glTF materials do not match the descriptor.",
    VISUAL_PREVIEW_DECODER_FAILED: "A visual asset could not be decoded.",
    VISUAL_PREVIEW_HASH_MISMATCH: "Visual asset bytes did not match their digest.",
    VISUAL_PREVIEW_URI_REJECTED: "A glTF URI is not a closed digest reference.",
    VISUAL_PREVIEW_BINDING_INVALID: "A visual binding does not match metric truth.",
    VISUAL_PREVIEW_WORLD_MISMATCH: "Visual layer is bound to a different world.",
    VISUAL_PREVIEW_UNSUPPORTED_RENDERER: "KTX2 transcoding is unavailable on this renderer.",
    VISUAL_PREVIEW_MEDIA_MISMATCH: "Visual asset media type did not match its record.",
    VISUAL_PREVIEW_SIZE_MISMATCH: "Visual asset size did not match its record.",
};

export function VisualPreviewDiagnostic({ data }) {
    const [snapshot, setSnapshot] = useState(() => data?.visualPreview?.() ?? { status: "idle", error: null });

    useEffect(() => data?.subscribeVisualPreview?.(setSnapshot), [data]);

    if (!snapshot || snapshot.status === "idle" || snapshot.status === "ready") return null;

    const code = snapshot.error?.code;
    const message = MESSAGES[code] ?? snapshot.error?.message ?? "Visual preview is unavailable.";
    const loading = snapshot.status === "loading";

    return (
        <div
            className="pointer-events-auto fixed bottom-3 left-1/2 z-30 w-[min(36rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-950/90 px-3 py-2 text-xs text-zinc-100 shadow-[0_16px_45px_rgba(0,0,0,0.38)]"
            role="status"
            aria-live="polite"
        >
            <div className="flex items-start gap-2">
                {loading
                    ? <IconLoader2 className="mt-0.5 shrink-0 animate-spin" size={14} />
                    : <IconAlertTriangle className="mt-0.5 shrink-0 text-amber-300" size={14} />}
                <div className="min-w-0 flex-1">
                    <div className="font-medium">
                        {loading ? "Loading visual preview" : "Visual preview unavailable"}
                    </div>
                    <div className="mt-0.5 text-zinc-400">{message}</div>
                    {code && <div className="mt-0.5 font-mono text-[11px] text-zinc-500">{code}</div>}
                </div>
                {!loading && (
                    <button
                        type="button"
                        className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius)] border border-zinc-700/80 px-2 py-1 text-[11px] text-zinc-100 hover:bg-zinc-800/80"
                        onClick={() => data?.simulation?.()?.environmentRuntime?.loader?.retryPreview?.()}
                    >
                        <IconRefresh size={12} />
                        Retry
                    </button>
                )}
            </div>
        </div>
    );
}
