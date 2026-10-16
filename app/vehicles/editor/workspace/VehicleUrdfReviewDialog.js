'use client';

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, DialogSurface, Field } from "../../../ui";
import { GitHubUrdfSession } from "../../urdf/GitHubUrdfSession.js";
import { acceptUrdfImport, manifestFromUrdfImport, planUrdfImport } from "../../urdf/planUrdfImport.js";
import { readUrdfPackage } from "../../urdf/urdfPackage.js";
import { isValidVehicleId } from "../../VehicleManifest.js";

function licenseLabel(license) {
    if (!license || license.status === "none") return "none";
    if (license.spdxId) return license.spdxId;
    if (license.name) return license.name;
    return license.status || "other";
}

async function filesFromList(list) {
    const files = [];
    for (const file of list) {
        const path = file.webkitRelativePath || file.name;
        files.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    return files;
}

export function VehicleUrdfReviewDialog({
    open,
    onOpenChange,
    mode,
    busy,
    defaultId,
    defaultName,
    onCreate,
    onApply,
    returnFocusRef,
}) {
    const sessionRef = useRef(null);
    if (!sessionRef.current) sessionRef.current = new GitHubUrdfSession();
    const [url, setUrl] = useState("");
    const [review, setReview] = useState(null);
    const [plan, setPlan] = useState(null);
    const [error, setError] = useState(null);
    const [acceptAdjustments, setAcceptAdjustments] = useState(false);
    const [steering, setSteering] = useState("");
    const [vehicleId, setVehicleId] = useState(defaultId || "");
    const [vehicleName, setVehicleName] = useState(defaultName || "");
    const [wasOpen, setWasOpen] = useState(open);
    const fileRef = useRef(null);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (!open) {
            setReview(null);
            setPlan(null);
            setError(null);
        }
    }

    useEffect(() => {
        if (!open) sessionRef.current.abort();
    }, [open]);

    const accepted = useMemo(() => {
        if (!plan) return null;
        const angle = steering.trim() === "" ? null : Number(steering);
        return acceptUrdfImport(plan, { acceptAdjustments, maxSteeringAngle: angle });
    }, [plan, acceptAdjustments, steering]);

    const loadPackage = (pkg, sourceReview = null) => {
        setReview(sourceReview);
        setPlan(planUrdfImport(pkg));
        setAcceptAdjustments(false);
        setError(null);
    };

    const onLocalFiles = async (event) => {
        const list = [...(event.target.files ?? [])];
        event.target.value = "";
        if (list.length === 0) return;
        try {
            const files = await filesFromList(list);
            const entry = files.find((file) => file.path.endsWith(".urdf"))?.path;
            if (!entry) throw new Error("Choose a folder or files that include a .urdf.");
            loadPackage(readUrdfPackage({ entryPath: entry, files }));
        } catch (caught) {
            setPlan(null);
            setError(caught.message);
        }
    };

    const inspectGitHub = async () => {
        setError(null);
        const result = await sessionRef.current.inspect(url);
        if (result.ignored) return;
        if (result.error) {
            setError(result.error.message);
            return;
        }
        setReview(result.result?.review ?? null);
        setPlan(null);
    };

    const fetchGitHub = async () => {
        setError(null);
        const result = await sessionRef.current.fetch(url, review?.selectedPath);
        if (result.ignored) return;
        if (result.error) {
            setError(result.error.message);
            return;
        }
        const pkg = sessionRef.current.package;
        if (!pkg) {
            setError("GitHub did not return a URDF package.");
            return;
        }
        loadPackage(pkg, result.result?.review ?? sessionRef.current.review);
    };

    const submit = (kind) => {
        if (!accepted?.ok) {
            setError(accepted?.issues?.[0]?.message || "Accept the URDF review before continuing.");
            return;
        }
        if (kind === "create") {
            if (!isValidVehicleId(vehicleId)) {
                setError("Vehicle id must use lowercase letters, numbers, and single hyphens.");
                return;
            }
            const manifest = manifestFromUrdfImport(plan, accepted, { id: vehicleId.trim(), name: vehicleName.trim() || plan.robotName || vehicleId });
            onCreate({ manifest, closure: plan.closure, plan });
            return;
        }
        onApply({ patch: accepted.patch, closure: plan.closure, plan });
    };

    return (
        <DialogSurface
            open={open}
            onOpenChange={onOpenChange}
            title={mode === "apply" ? "Apply URDF" : "Create from URDF"}
            description="Review the imported geometry before it becomes a vehicle draft."
            className="max-w-2xl"
            onCloseAutoFocus={(event) => {
                if (!returnFocusRef?.current) return;
                event.preventDefault();
                returnFocusRef.current.focus();
            }}
            footer={(
                <div className="flex justify-end gap-2">
                    <Button onClick={() => onOpenChange(false)}>Cancel</Button>
                    {mode === "apply"
                        ? <Button onClick={() => submit("apply")} disabled={busy || !accepted?.ok}>Apply</Button>
                        : <Button onClick={() => submit("create")} disabled={busy || !accepted?.ok}>Create</Button>}
                </div>
            )}
        >
            <div className="space-y-3 text-[12px]">
                <div className="flex flex-wrap gap-2">
                    <Button onClick={() => fileRef.current?.click()} disabled={busy}>Local URDF</Button>
                    <input ref={fileRef} hidden type="file" accept=".urdf,.dae,.stl,.obj,.mtl,.png,.jpg,.jpeg" multiple onChange={onLocalFiles} />
                </div>
                <Field label="GitHub URL">
                    <input className="sf-input" aria-label="GitHub URDF URL" value={url} onChange={(event) => setUrl(event.target.value)} />
                </Field>
                <div className="flex gap-2">
                    <Button onClick={inspectGitHub} disabled={busy || !url.trim()}>Inspect</Button>
                    <Button onClick={fetchGitHub} disabled={busy || !url.trim()}>Fetch</Button>
                </div>
                {review && (
                    <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-[11px]">
                        <dt>Repository</dt><dd className="truncate">{review.repository}</dd>
                        <dt>Commit</dt><dd className="truncate">{review.commitSha}</dd>
                        <dt>Tree</dt><dd className="truncate">{review.treeSha}</dd>
                        <dt>Path</dt><dd className="truncate">{review.selectedPath || "—"}</dd>
                        <dt>License</dt><dd>{licenseLabel(review.license)}</dd>
                    </dl>
                )}
                {plan && (
                    <div className="space-y-2">
                        <p>{plan.robotName || "URDF"} · {plan.closure ? "geometry ready" : "geometry blocked"}</p>
                        {(plan.omissions ?? []).length > 0 && (
                            <ul className="list-disc pl-4 text-[11px] text-[var(--slate-muted)]">
                                {plan.omissions.map((entry, index) => <li key={index}>{entry.message || entry.code || String(entry)}</li>)}
                            </ul>
                        )}
                        {(plan.diagnostics ?? []).filter((entry) => entry.severity !== "info").map((entry, index) => (
                            <p key={index} className="text-[11px] text-[var(--slate-danger)]">{entry.message}</p>
                        ))}
                        <label className="flex items-center gap-2">
                            <input type="checkbox" checked={acceptAdjustments} onChange={(event) => setAcceptAdjustments(event.target.checked)} />
                            Accept measured wheel geometry
                        </label>
                        {plan.steering?.status === "required" && (
                            <Field label="Max steering angle (rad)">
                                <input className="sf-input" aria-label="Max steering angle" value={steering} onChange={(event) => setSteering(event.target.value)} />
                            </Field>
                        )}
                    </div>
                )}
                {mode === "create" && (
                    <div className="grid gap-2 sm:grid-cols-2">
                        <Field label="Vehicle id">
                            <input className="sf-input" aria-label="New URDF vehicle id" value={vehicleId} onChange={(event) => setVehicleId(event.target.value)} />
                        </Field>
                        <Field label="Name">
                            <input className="sf-input" aria-label="New URDF vehicle name" value={vehicleName} onChange={(event) => setVehicleName(event.target.value)} />
                        </Field>
                    </div>
                )}
                {error && <p role="alert" className="text-[var(--slate-danger)]">{error}</p>}
            </div>
        </DialogSurface>
    );
}
