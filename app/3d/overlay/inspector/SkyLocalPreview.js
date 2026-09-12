'use client';

import { useEffect, useState } from "react";
import { Button } from "../../../ui";
import { cn } from "../ui/cn";

/**
 * Sky runtime status and the local-image preview. Authored sky values are
 * generic fields committed through the bus; the local preview is session-only
 * runtime state on `EnvironmentSkyState` and never persists.
 */
export function SkyLocalPreview({ data }) {
    const [snapshot, setSnapshot] = useState(null);
    useEffect(() => {
        const sky = data?.sky?.() ?? data?.environment?.()?.sky?.();
        return sky?.subscribe?.(setSnapshot);
    }, [data]);
    const sky = data?.sky?.() ?? data?.environment?.()?.sky?.();
    if (!snapshot || !sky) return null;
    const status = snapshot.runtime?.status ?? "idle";
    const error = status === "error";
    const loading = status === "loading";

    const choose = (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        sky.setImageLocalPreview(URL.createObjectURL(file), file.name);
        data?.simulation?.()?.render?.();
        event.target.value = "";
    };
    const clear = () => {
        const url = snapshot.image?.localPreviewUrl;
        sky.clearImageLocalPreview();
        if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
        data?.simulation?.()?.render?.();
    };

    return (
        <div className="space-y-2 py-1">
            <div
                role="status"
                className={cn(
                    "flex items-center justify-between gap-2 rounded-[var(--radius)] border px-2 py-1.5 text-[11px]",
                    error ? "border-[var(--slate-danger-border)] text-[var(--slate-danger)]" : "border-[var(--slate-border-60)] text-[var(--slate-fg-2)]",
                )}
            >
                <span>{error ? "Sky error" : loading ? "Preparing sky" : "Sky ready"}</span>
                <span className="truncate text-[var(--slate-muted)]">{snapshot.runtime?.error || (loading ? "Loading atmosphere resources" : "Live preview")}</span>
            </div>
            <div className="rounded-[var(--radius)] border border-[var(--slate-border-60)] p-2">
                <p className="text-[12px] text-[var(--slate-fg-2)]">Local image preview</p>
                <p className="mt-0.5 text-[11px] text-[var(--slate-muted)]">Test an equirectangular image without writing a managed asset. Preview only; not saved.</p>
                <div className="mt-2 flex items-center gap-2">
                    <label className="inline-flex h-7 cursor-pointer items-center rounded-[var(--radius)] border border-[var(--slate-border-70)] bg-[var(--slate-surface-3)] px-2.5 text-[12px] text-[var(--slate-fg)] hover:bg-[var(--slate-surface-hover)] focus-within:ring-2 focus-within:ring-[var(--slate-ring)]">
                        Choose file
                        <input type="file" accept=".exr,.hdr,image/*" onChange={choose} className="sr-only" aria-label="Choose a local sky image" />
                    </label>
                    {snapshot.image?.localPreviewUrl && <Button size="compact" variant="ghost" onClick={clear}>Clear preview</Button>}
                </div>
                <p className="mt-2 truncate font-mono text-[11px] text-[var(--slate-muted)]">{snapshot.image?.localPreviewName ?? "No local preview selected."}</p>
            </div>
        </div>
    );
}
