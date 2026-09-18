import { useEffect, useState } from "react";
import { storeData } from "../../ScriptManager";
import { sha256ExactBytes } from "../../../simulation/visual/VisualLayer.js";
import { VisualAssetClient } from "../../../3d/environment/visual/VisualAssetClient.js";
import Unit from "../Unit";
import { TEXTURE_ID_TYPE } from "../../types/PortTypes.js";

const CONTROL_CLASS = "w-full rounded-sm border border-white/10 bg-[var(--slate-bg)] px-2.5 py-1.5 text-white outline-none transition-[border-color,box-shadow] duration-150 hover:border-white/20 focus:border-white/30 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]";

export function TextureImportUnit({ _uuid, initialData = "" }) {
    const [value, setValue] = useState(() => initialData ?? "");
    const [error, setError] = useState("");
    const [uploading, setUploading] = useState(false);

    useEffect(() => {
        storeData(_uuid, value);
    }, [value, _uuid]);

    async function onFileChange(event) {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;

        setError("");
        setUploading(true);
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const sha256 = sha256ExactBytes(bytes);
            const mediaType = file.type || "application/octet-stream";
            const client = new VisualAssetClient();
            const session = await client.createUpload({
                asset: {
                    sha256,
                    mediaType,
                    sizeBytes: bytes.byteLength,
                    role: "texture",
                },
                sourceIds: [`script-texture:${_uuid}`],
                dependencies: {},
            });
            const published = await client.putUploadContent(session.id, bytes, { mediaType });
            setValue(String(published.useHash ?? ""));
        } catch (cause) {
            setError(cause?.message ? String(cause.message) : String(cause));
        } finally {
            setUploading(false);
        }
    }

    return (
        <Unit
            title="Texture Import"
            hasOptions={true}
            _uuid={_uuid}
            inputs={[]}
            outputs={[{ label: "out", type: TEXTURE_ID_TYPE }]}
        >
            <label className="flex flex-col gap-1.5 text-xs text-zinc-300">
                <span className="text-zinc-400">Texture ID</span>
                <input
                    type="text"
                    value={value}
                    className={CONTROL_CLASS}
                    placeholder="visual-asset useHash"
                    onChange={(event) => setValue(event.target.value)}
                />
            </label>
            <label className="mt-2 flex flex-col gap-1.5 text-xs text-zinc-300">
                <span className="text-zinc-400">Import image</span>
                <input
                    type="file"
                    accept="image/*"
                    disabled={uploading}
                    className="text-[11px] text-zinc-400 file:mr-2 file:rounded file:border file:border-white/10 file:bg-[var(--slate-surface-2)] file:px-2 file:py-1 file:text-zinc-200"
                    onChange={onFileChange}
                />
            </label>
            {uploading ? <p className="mt-1 text-[11px] text-zinc-400">Uploading…</p> : null}
            {error ? <p className="mt-1 text-[11px] text-red-300">{error}</p> : null}
        </Unit>
    );
}

export { TextureImportBlock } from "./TextureImport.block.js";
