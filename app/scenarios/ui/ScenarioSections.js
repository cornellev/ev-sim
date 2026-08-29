'use client';

import { useEffect, useMemo, useState } from "react";
import {
    IconActivity,
    IconCar,
    IconClock,
    IconFlag3,
    IconArrowsMaximize,
    IconArrowsMinimize,
    IconInfoCircle,
    IconMap2,
    IconPlus,
    IconRoute,
    IconTrash,
} from "@tabler/icons-react";

import {
    AdvancedFields,
    Button,
    Field,
    NativeSelect,
    SegmentedControl,
    Switch,
    Textarea,
    TextInput,
} from "../../ui";
import {
    COMPLETION_OPTIONS,
    CONTROLLER_OPTIONS,
    OUTCOME_OPTIONS,
    TRIGGER_ACTIONS,
    TRIGGER_CONDITIONS,
    terminalTrigger,
} from "./scenarioUiModel.js";
import ScenarioMapViewport from "./ScenarioMapViewport.js";
import styles from "./ScenarioWorkspace.module.css";

function nextId(prefix, values) {
    let index = values.length + 1;
    const ids = new Set(values.map((value) => value.id));
    while (ids.has(`${prefix}-${index}`)) index += 1;
    return `${prefix}-${index}`;
}

function controllerOutputLabel(outputs = [], target) {
    const mapping = outputs.find((entry) => (entry.target ?? entry.command) === target);
    return mapping?.output ?? mapping?.source ?? mapping?.port ?? mapping?.label ?? "";
}

function withControllerOutput(outputs = [], target, label) {
    const remaining = outputs.filter((entry) => (entry.target ?? entry.command) !== target);
    return label.trim() ? [...remaining, { output: label.trim(), target }] : remaining;
}

function zoneDepth(zone, zones) {
    const byId = new Map(zones.map((entry) => [entry.id, entry]));
    const visited = new Set([zone.id]);
    let depth = 0;
    let parentId = zone.parentId;
    while (parentId && byId.has(parentId) && !visited.has(parentId)) {
        visited.add(parentId);
        depth += 1;
        parentId = byId.get(parentId).parentId;
    }
    return depth;
}

function parseTypedValue(raw) {
    const value = String(raw);
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;
    const numeric = Number(value);
    return value.trim() !== "" && Number.isFinite(numeric) ? numeric : value;
}

function SectionHeading({ eyebrow, title, detail, action }) {
    return (
        <header className={styles.sectionHeading}>
            <div>
                <span className={styles.eyebrow}>{eyebrow}</span>
                <h2>{title}</h2>
                {detail && <p>{detail}</p>}
            </div>
            {action}
        </header>
    );
}

function EmptyState({ icon: Icon, title, detail, action }) {
    return (
        <div className={styles.sectionEmpty}>
            <Icon size={22} stroke={1.45} aria-hidden="true" />
            <strong>{title}</strong>
            <p>{detail}</p>
            {action}
        </div>
    );
}

function RemoveButton({ label, onClick, disabled = false }) {
    return (
        <button type="button" className={styles.removeButton} onClick={onClick} disabled={disabled} aria-label={label}>
            <IconTrash size={14} stroke={1.7} aria-hidden="true" />
        </button>
    );
}

export function OverviewSection({ scenario, environments, folders, onUpdate }) {
    const addParameter = () => {
        const id = nextId("parameter", scenario.parameters);
        onUpdate(["parameters"], [...scenario.parameters, {
            id,
            name: `Parameter ${scenario.parameters.length + 1}`,
            description: "",
            type: "float64",
            default: 0,
            target: { kind: "scenario-signal", path: `scenario.${id}` },
        }]);
    };
    const addSensorAlias = () => {
        const id = nextId("sensor", scenario.sensorAliases);
        onUpdate(["sensorAliases"], [...scenario.sensorAliases, { id, name: `Sensor ${scenario.sensorAliases.length + 1}`, type: null }]);
    };

    return (
        <div className={styles.sectionStack}>
            <SectionHeading
                eyebrow=""
                title="Overview"
                detail=""
            />
            <section className={styles.formPanel} aria-label="Scenario details">
                <div className={styles.formGrid}>
                    <Field label="Name" required><TextInput value={scenario.name} onChange={(event) => onUpdate(["name"], event.target.value)} /></Field>
                    <Field label="Environment" required>
                        <NativeSelect value={scenario.environment.id} onChange={(event) => onUpdate(["environment"], { ...scenario.environment, id: event.target.value, expectedHash: null })}>
                            {environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name || environment.id}</option>)}
                        </NativeSelect>
                    </Field>
                    <Field label="Folder">
                        <NativeSelect value={scenario.folderId || ""} onChange={(event) => onUpdate(["folderId"], event.target.value || null)}>
                            <option value="">Unfiled</option>
                            {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                        </NativeSelect>
                    </Field>
                    <Field label="Stable ID"><TextInput value={scenario.id} readOnly /></Field>
                    <Field label="Description" className={styles.spanTwo}>
                        <Textarea value={scenario.description} onChange={(event) => onUpdate(["description"], event.target.value)} placeholder="What does this scenario prove?" />
                    </Field>
                </div>
            </section>

            <div className={styles.splitHeading}>
                <div><h3>Declared parameters</h3><p>For reliability, declare all that are used within the scenario.</p></div>
                <Button size="compact" onClick={addParameter}><IconPlus size={14} stroke={1.75} /> Add parameter</Button>
            </div>
            {scenario.parameters.length === 0 ? (
                <EmptyState icon={IconActivity} title="No declared parameters" detail="Add a parameter when an experiment needs to vary a scenario value." />
            ) : (
                <div className={styles.cardGrid}>
                    {scenario.parameters.map((parameter, index) => (
                        <article className={styles.configCard} key={parameter.id}>
                            <div className={styles.cardTopline}><span>PARAM {String(index + 1).padStart(2, "0")}</span><RemoveButton label={`Remove ${parameter.name}`} onClick={() => onUpdate(["parameters"], scenario.parameters.filter((entry) => entry.id !== parameter.id))} /></div>
                            <div className={styles.formGrid}>
                                <Field label="Name"><TextInput value={parameter.name} onChange={(event) => onUpdate(["parameters", index, "name"], event.target.value)} /></Field>
                                <Field label="Type">
                                    <NativeSelect value={parameter.type} onChange={(event) => onUpdate(["parameters", index, "type"], event.target.value)}>
                                        <option value="float64">float64</option><option value="int32">int32</option><option value="boolean">boolean</option><option value="string">string</option>
                                    </NativeSelect>
                                </Field>
                                <Field label="Default value"><TextInput value={String(parameter.default ?? "")} onChange={(event) => onUpdate(["parameters", index, "default"], parameter.type === "boolean" ? event.target.value === "true" : ["float64", "int32"].includes(parameter.type) ? Number(event.target.value) : event.target.value)} /></Field>
                                <AdvancedFields label="Parameter targeting">
                                <Field label="Target kind">
                                    <NativeSelect value={parameter.target?.kind || "scenario-signal"} onChange={(event) => onUpdate(["parameters", index, "target"], { ...parameter.target, kind: event.target.value })}>
                                        <option value="scenario-signal">Scenario signal</option><option value="script-input">Script input</option><option value="scalar-field">Scalar field</option>
                                    </NativeSelect>
                                </Field>
                                {parameter.target?.kind === "script-input" ? <><Field label="Script ID"><TextInput value={parameter.target?.scriptId || ""} onChange={(event) => onUpdate(["parameters", index, "target"], { ...parameter.target, scriptId: event.target.value })} /></Field><Field label="Input label"><TextInput value={parameter.target?.input || ""} onChange={(event) => onUpdate(["parameters", index, "target"], { ...parameter.target, input: event.target.value })} /></Field></> : <Field label="Target path" className={styles.spanTwo}><TextInput value={parameter.target?.path || ""} placeholder={parameter.target?.kind === "scenario-signal" ? "scenario.custom_flag" : "routes.0.initialSpeedMps"} onChange={(event) => onUpdate(["parameters", index, "target"], { ...parameter.target, path: event.target.value })} /></Field>}
                                {["float64", "int32"].includes(parameter.type) && <><Field label="Minimum"><TextInput type="number" value={parameter.minimum ?? ""} onChange={(event) => onUpdate(["parameters", index, "minimum"], event.target.value === "" ? null : Number(event.target.value))} /></Field><Field label="Maximum"><TextInput type="number" value={parameter.maximum ?? ""} onChange={(event) => onUpdate(["parameters", index, "maximum"], event.target.value === "" ? null : Number(event.target.value))} /></Field></>}
                                </AdvancedFields>
                            </div>
                        </article>
                    ))}
                </div>
            )}

            <div className={styles.splitHeading}>
                <div><h3>Sensor aliases</h3><p>Stable names used by triggers without coupling the scenario to a sensor instance.</p></div>
                <Button size="compact" onClick={addSensorAlias}><IconPlus size={14} stroke={1.75} /> Add alias</Button>
            </div>
            {scenario.sensorAliases.map((alias, index) => (
                <div className={styles.inlineRecord} key={alias.id}>
                    <Field label="Alias ID"><TextInput value={alias.id} onChange={(event) => onUpdate(["sensorAliases", index, "id"], event.target.value)} /></Field>
                    <Field label="Name"><TextInput value={alias.name} onChange={(event) => onUpdate(["sensorAliases", index, "name"], event.target.value)} /></Field>
                    <Field label="Required type"><TextInput value={alias.type || ""} placeholder="Any" onChange={(event) => onUpdate(["sensorAliases", index, "type"], event.target.value || null)} /></Field>
                    <RemoveButton label={`Remove ${alias.name}`} onClick={() => onUpdate(["sensorAliases"], scenario.sensorAliases.filter((entry) => entry.id !== alias.id))} />
                </div>
            ))}
        </div>
    );
}

export function RoutesSection({ scenario, onUpdate, onAddActor, onEditRoute }) {
    return (
        <div className={styles.sectionStack}>
            <SectionHeading
                eyebrow=""
                title="Routes"
                detail=""
                action={<Button size="compact" onClick={onAddActor}><IconPlus size={14} stroke={1.75} /> Add actor route</Button>}
            />
            <div className={styles.routeCards}>
                {scenario.routes.map((route, index) => {
                    const actor = scenario.actors.find((entry) => entry.id === route.actorId);
                    const activation = route.controller.activation || { kind: "start", flag: null };
                    return (
                        <article className={styles.routeCard} key={route.id}>
                            <header>
                                <div className={styles.roleMarker}>{actor?.role === "ego" ? "EGO" : `A${index}`}</div>
                                <div><h3>{route.name}</h3><p>{route.waypoints.length} waypoints · {route.verification ? "verified" : "verification required"}</p></div>
                                <div className={styles.routeActions}><Button size="compact" onClick={() => onEditRoute?.(index)}><IconMap2 size={13} /> Edit route</Button>{index > 0 && <RemoveButton label={`Remove route ${route.name}`} onClick={() => onUpdate(["routes"], scenario.routes.filter((entry) => entry.id !== route.id))} />}</div>
                            </header>
                            <div className={styles.formGrid}>
                                <Field label="Route name"><TextInput value={route.name} onChange={(event) => onUpdate(["routes", index, "name"], event.target.value)} /></Field>
                                <Field label="Vehicle role">
                                    <NativeSelect value={route.actorId} onChange={(event) => onUpdate(["routes", index, "actorId"], event.target.value)}>
                                        {scenario.actors.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.role === "ego" ? " (Ego)" : ""}</option>)}
                                    </NativeSelect>
                                </Field>
                                <Field label="Initial speed (m/s)"><TextInput type="number" min="0" step="0.1" value={route.initialSpeedMps} onChange={(event) => onUpdate(["routes", index, "initialSpeedMps"], Number(event.target.value))} /></Field>
                                <Field label="Controller">
                                    <NativeSelect value={route.controller.kind} onChange={(event) => onUpdate(["routes", index, "controller"], { ...route.controller, kind: event.target.value })}>
                                        {CONTROLLER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                                    </NativeSelect>
                                </Field>
                                <Field label="Starts">
                                    <NativeSelect value={activation.kind} onChange={(event) => onUpdate(["routes", index, "controller", "activation"], { kind: event.target.value, flag: event.target.value === "flag" ? activation.flag || "scenario.start_actor" : null })}>
                                        <option value="start">At scenario start</option><option value="flag">When scenario flag is true</option>
                                    </NativeSelect>
                                </Field>
                                {activation.kind === "flag" && <Field label="Activation flag"><TextInput value={activation.flag || ""} onChange={(event) => onUpdate(["routes", index, "controller", "activation", "flag"], event.target.value)} /></Field>}
                                {["script", "script-with-route"].includes(route.controller.kind) && <Field label="Script ID"><TextInput value={route.controller.scriptId || ""} onChange={(event) => onUpdate(["routes", index, "controller", "scriptId"], event.target.value || null)} /></Field>}
                                {["script", "script-with-route"].includes(route.controller.kind) && <><Field label="Speed output"><TextInput value={controllerOutputLabel(route.controller.outputs, "speed")} placeholder="speed" onChange={(event) => onUpdate(["routes", index, "controller", "outputs"], withControllerOutput(route.controller.outputs, "speed", event.target.value))} /></Field><Field label="Steering output"><TextInput value={controllerOutputLabel(route.controller.outputs, "steering")} placeholder="steering" onChange={(event) => onUpdate(["routes", index, "controller", "outputs"], withControllerOutput(route.controller.outputs, "steering", event.target.value))} /></Field></>}
                                {route.controller.kind === "external-ros" && <Field label="Ackermann topic ID"><TextInput value={route.controller.topicId || ""} placeholder={route.actorId === "ego" ? "/ackdrive" : "/actors/command"} onChange={(event) => onUpdate(["routes", index, "controller", "topicId"], event.target.value || null)} /></Field>}
                            </div>
                        </article>
                    );
                })}
            </div>
        </div>
    );
}

export function ActorsSection({ scenario, vehicleCatalog = [], onUpdate, onAddActor }) {
    const removeActor = (actorId) => {
        onUpdate(["actors"], scenario.actors.filter((actor) => actor.id !== actorId));
        onUpdate(["routes"], scenario.routes.filter((route) => route.actorId !== actorId));
    };
    return (
        <div className={styles.sectionStack}>
            <SectionHeading eyebrow="" title="Actors" detail="" action={<Button size="compact" onClick={onAddActor}><IconPlus size={14} stroke={1.75} /> Add actor</Button>} />
            <div className={styles.actorGrid}>
                {scenario.actors.map((actor, index) => (
                    <article className={styles.actorCard} key={actor.id} data-ego={index === 0 || undefined}>
                        <header><IconCar size={18} stroke={1.55} aria-hidden="true" /><span>{index === 0 ? "Primary role" : `Actor ${index}`}</span>{index > 0 && <RemoveButton label={`Remove ${actor.name}`} onClick={() => removeActor(actor.id)} />}</header>
                        <h3>{actor.name}</h3>
                        <div className={styles.formStack}>
                            <Field label="Name"><TextInput value={actor.name} onChange={(event) => onUpdate(["actors", index, "name"], event.target.value)} /></Field>
                            <Field label="Role"><TextInput value={index === 0 ? "Ego" : actor.role} readOnly /></Field>
                            {index === 0 ? <p className={styles.mutedNote}>The Ego vehicle is assigned by the run configuration.</p> : <Field label="Vehicle" required><NativeSelect value={actor.vehicleId || ""} onChange={(event) => onUpdate(["actors", index, "vehicleId"], event.target.value || null)}><option value="">Select a vehicle</option>{actor.vehicleId && !vehicleCatalog.some((entry) => entry.id === actor.vehicleId) && <option value={actor.vehicleId}>{actor.vehicleId} (unavailable)</option>}{vehicleCatalog.map((entry) => <option key={entry.id} value={entry.id}>{entry.name || entry.id}</option>)}</NativeSelect></Field>}
                            <Switch label="Enabled" checked={actor.enabled !== false} onCheckedChange={(value) => onUpdate(["actors", index, "enabled"], value)} />
                        </div>
                    </article>
                ))}
            </div>
        </div>
    );
}

function TriggerActionEditor({ action, index, scenario, onChange, onRemove, canRemove }) {
    const set = (key, value) => onChange({ ...action, [key]: value });
    return (
        <article className={styles.triggerActionEditor}>
            <header><span>ACTION {index + 1}</span><NativeSelect aria-label={`Trigger action ${index + 1}`} value={action.kind} onChange={(event) => set("kind", event.target.value)}>{TRIGGER_ACTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</NativeSelect><RemoveButton label={`Remove action ${index + 1}`} disabled={!canRemove} onClick={onRemove} /></header>
            <AdvancedFields label="Action parameters">
            <div className={styles.formGrid}>
                {action.kind === "set-flag" && <><Field label="Scenario flag"><TextInput value={action.flag || ""} onChange={(event) => set("flag", event.target.value)} /></Field><Field label="Value"><NativeSelect value={String(action.value ?? true)} onChange={(event) => set("value", event.target.value === "true")}><option value="true">True</option><option value="false">False</option></NativeSelect></Field></>}
                {action.kind === "set-signal" && <><Field label="Signal path"><TextInput value={action.path || ""} onChange={(event) => set("path", event.target.value)} /></Field><Field label="Value"><TextInput value={String(action.value ?? "")} onChange={(event) => set("value", parseTypedValue(event.target.value))} /></Field></>}
                {action.kind === "run-script" && <><Field label="Script ID"><TextInput value={action.scriptId || ""} onChange={(event) => set("scriptId", event.target.value || null)} /></Field><Field label="On script error"><NativeSelect value={action.onError || "fail"} onChange={(event) => set("onError", event.target.value)}><option value="fail">Fail scenario</option><option value="continue">Diagnostic only</option></NativeSelect></Field></>}
                {action.kind === "actor-command" && <><Field label="Actor"><NativeSelect value={action.actorId || "ego"} onChange={(event) => set("actorId", event.target.value)}>{scenario.actors.map((actor) => <option key={actor.id} value={actor.id}>{actor.name}</option>)}</NativeSelect></Field><Field label="Duration (seconds)"><TextInput type="number" min="0" step="0.1" value={(action.durationNs || 0) / 1e9} onChange={(event) => set("durationNs", Number(event.target.value) * 1e9)} /></Field><Field label="Speed (m/s)"><TextInput type="number" step="0.1" value={action.speedMps || 0} onChange={(event) => set("speedMps", Number(event.target.value))} /></Field><Field label="Steering (rad)"><TextInput type="number" step="0.01" value={action.steeringRad || 0} onChange={(event) => set("steeringRad", Number(event.target.value))} /></Field></>}
                {action.kind === "sensor-state" && <><Field label="Sensor alias"><NativeSelect value={action.sensorAlias || ""} onChange={(event) => set("sensorAlias", event.target.value)}><option value="">Select alias</option>{scenario.sensorAliases.map((alias) => <option key={alias.id} value={alias.id}>{alias.name}</option>)}</NativeSelect></Field><Field label="Duration (seconds)"><TextInput type="number" min="0" step="0.1" value={(action.durationNs || 0) / 1e9} onChange={(event) => set("durationNs", Number(event.target.value) * 1e9)} /></Field><Field label="Sensor state"><NativeSelect value={action.enabled === false ? "disabled" : "enabled"} onChange={(event) => set("enabled", event.target.value === "enabled")}><option value="enabled">Enabled</option><option value="disabled">Disabled</option></NativeSelect></Field><Field label="Dropout probability"><TextInput type="number" min="0" max="1" step="0.05" value={action.dropoutProbability || 0} onChange={(event) => set("dropoutProbability", Number(event.target.value))} /></Field></>}
                {action.kind === "finish" && <p className={styles.mutedNote}>This will cause the scenario to end.</p>}
            </div>
            </AdvancedFields>
        </article>
    );
}

export function ZonesSection({ scenario, environment, onUpdate }) {
    const [view, setView] = useState("map");
    const [mapTool, setMapTool] = useState("draw");
    const [draftZone, setDraftZone] = useState(null);
    const [selectedZoneId, setSelectedZoneId] = useState(null);
    const [mapFullscreen, setMapFullscreen] = useState(false);
    const selectedZone = scenario.zones.find((zone) => zone.id === selectedZoneId) || null;
    const setZoneView = (nextView) => {
        if (nextView !== "map") setMapFullscreen(false);
        setView(nextView);
    };
    const deleteZone = (zoneId) => {
        onUpdate(["zones"], scenario.zones.filter((zone) => zone.id !== zoneId));
        setSelectedZoneId(null);
    };
    const showZoneDetails = () => {
        setMapFullscreen(false);
        setView("cards");
    };
    useEffect(() => {
        if (!mapFullscreen) return undefined;
        const onKeyDown = (event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setMapFullscreen(false);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [mapFullscreen]);
    const addZone = () => {
        const id = nextId("zone", scenario.zones);
        onUpdate(["zones"], [...scenario.zones, { id, name: `Zone ${scenario.zones.length + 1}`, parentId: null, center: { x: 0, y: 1.5, z: 0 }, size: { x: 8, y: 3, z: 8 } }]);
    };
    const addTrigger = () => {
        const id = nextId("trigger", scenario.triggers);
        onUpdate(["triggers"], [...scenario.triggers, { id, name: `Trigger ${scenario.triggers.length + 1}`, enabled: true, once: true, condition: { kind: "time", actorId: "ego", timeNs: 5e9 }, actions: [{ kind: "finish" }] }]);
    };
    const finishZone = (current, context) => {
        const start = context?.start?.world;
        setDraftZone(null);
        if (!start || !current || context.distancePx < 8) return;
        const width = Math.abs(current.x - start.x);
        const depth = Math.abs(current.z - start.z);
        if (width < 0.1 || depth < 0.1) return;
        const id = nextId("zone", scenario.zones);
        onUpdate(["zones"], [...scenario.zones, {
            id,
            name: `Zone ${scenario.zones.length + 1}`,
            parentId: null,
            center: { x: (start.x + current.x) / 2, y: 1.5, z: (start.z + current.z) / 2 },
            size: { x: width, y: 3, z: depth },
        }]);
        setSelectedZoneId(id);
    };
    return (
        <div className={`${styles.sectionStack} ${mapFullscreen ? styles.zoneFullscreen : ""}`.trim()} data-zone-map-fullscreen={mapFullscreen || undefined}>
            <SectionHeading
                eyebrow=""
                title="Zones & triggers"
                detail=""
                action={<SegmentedControl label="Zone view" value={view} onValueChange={setZoneView} items={[{ value: "map", label: "Map" }, { value: "cards", label: "Cards" }]} />}
            />
            <div className={styles.splitHeading}><div><h3>Zones</h3></div><Button size="compact" onClick={addZone}><IconPlus size={14} stroke={1.75} /> Add zone</Button></div>
            {view === "map" ? (
                <div className={styles.zoneMap}>
                    <ScenarioMapViewport
                        environment={environment}
                        ariaLabel="Scenario zone map. Drag to draw a world-space zone."
                        interaction={mapTool}
                        onDrawStart={(start) => setDraftZone({ start, current: start })}
                        onDrawMove={(current) => setDraftZone((draft) => draft ? { ...draft, current } : null)}
                        onDrawEnd={finishZone}
                    >
                        {({ toScreen }) => (
                            <>
                                {scenario.zones.map((zone, index) => {
                                    const min = toScreen({ x: zone.center.x - zone.size.x / 2, z: zone.center.z - zone.size.z / 2 });
                                    const max = toScreen({ x: zone.center.x + zone.size.x / 2, z: zone.center.z + zone.size.z / 2 });
                                    const center = toScreen(zone.center);
                                    return (
                                        <g
                                            key={zone.id}
                                            className={styles.zoneShape}
                                            data-map-interactive
                                            data-zone-id={zone.id}
                                            data-selected={zone.id === selectedZoneId || undefined}
                                            role="button"
                                            tabIndex={0}
                                            aria-label={`Select ${zone.name}`}
                                            onPointerDown={(event) => { event.stopPropagation(); setSelectedZoneId(zone.id); }}
                                            onKeyDown={(event) => {
                                                if (!["Enter", " "].includes(event.key)) return;
                                                event.preventDefault();
                                                setSelectedZoneId(zone.id);
                                            }}
                                        >
                                            <rect x={Math.min(min.x, max.x)} y={Math.min(min.y, max.y)} width={Math.max(2, Math.abs(max.x - min.x))} height={Math.max(2, Math.abs(max.y - min.y))} />
                                            <text x={center.x} y={center.y}>{index + 1}. {zone.name}</text>
                                        </g>
                                    );
                                })}
                                {draftZone && (() => {
                                    const start = toScreen(draftZone.start);
                                    const current = toScreen(draftZone.current);
                                    return <rect className={styles.zoneDraft} x={Math.min(start.x, current.x)} y={Math.min(start.y, current.y)} width={Math.abs(current.x - start.x)} height={Math.abs(current.y - start.y)} />;
                                })()}
                            </>
                        )}
                    </ScenarioMapViewport>
                    <div className={styles.zoneMapTools} data-map-control>
                        <SegmentedControl label="Map interaction" value={mapTool} onValueChange={setMapTool} items={[{ value: "draw", label: "Draw zone" }, { value: "pan", label: "Pan" }]} />
                    </div>
                    <aside className={styles.zoneInspector} aria-label="Zone inspector">
                        {selectedZone ? (
                            <>
                                <div><span>Selected zone</span><strong>{selectedZone.name}</strong></div>
                                <div className={styles.zoneInspectorActions}>
                                    <button type="button" onClick={() => deleteZone(selectedZone.id)} aria-label={`Delete ${selectedZone.name}`}><IconTrash size={14} stroke={1.75} /> Delete</button>
                                    <button type="button" onClick={showZoneDetails}><IconInfoCircle size={14} stroke={1.75} /> Details</button>
                                </div>
                            </>
                        ) : <p>Select a zone on the map or in the hierarchy.</p>}
                    </aside>
                    <aside className={styles.zoneHierarchy}>
                        <div className={styles.zoneHierarchyHeader}>
                            <strong>Zone hierarchy</strong>
                            <button
                                type="button"
                                aria-label={mapFullscreen ? "Collapse zone map" : "Expand zone map"}
                                aria-pressed={mapFullscreen}
                                onClick={() => setMapFullscreen((current) => !current)}
                            >
                                {mapFullscreen ? <IconArrowsMinimize size={14} stroke={1.75} /> : <IconArrowsMaximize size={14} stroke={1.75} />}
                            </button>
                        </div>
                        {scenario.zones.length === 0 ? <p>No zones yet</p> : scenario.zones.map((zone) => (
                            <button
                                type="button"
                                key={zone.id}
                                data-selected={zone.id === selectedZoneId || undefined}
                                onClick={() => setSelectedZoneId(zone.id)}
                                style={{ paddingLeft: `${8 + zoneDepth(zone, scenario.zones) * 12}px` }}
                            >
                                {zone.name}
                            </button>
                        ))}
                    </aside>
                </div>
            ) : scenario.zones.length === 0 ? <EmptyState icon={IconMap2} title="No zones" detail="Add a world-space box for a finish area or spatial trigger." action={<Button size="compact" onClick={addZone}>Add first zone</Button>} /> : (
                <div className={styles.cardGrid}>
                    {scenario.zones.map((zone, index) => (
                        <article className={styles.configCard} key={zone.id}>
                            <div className={styles.cardTopline}><span>ZONE {String(index + 1).padStart(2, "0")}</span><RemoveButton label={`Remove ${zone.name}`} onClick={() => deleteZone(zone.id)} /></div>
                            <Field label="Name"><TextInput value={zone.name} onChange={(event) => onUpdate(["zones", index, "name"], event.target.value)} /></Field>
                            <Field label="Parent zone"><NativeSelect value={zone.parentId || ""} onChange={(event) => onUpdate(["zones", index, "parentId"], event.target.value || null)}><option value="">Top level</option>{scenario.zones.filter((entry) => entry.id !== zone.id).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</NativeSelect></Field>
                            <div className={styles.vectorGrid}>{["x", "y", "z"].map((axis) => <Field key={axis} label={`Center ${axis.toUpperCase()}`}><TextInput type="number" step="0.1" value={zone.center[axis]} onChange={(event) => onUpdate(["zones", index, "center", axis], Number(event.target.value))} /></Field>)}</div>
                            <div className={styles.vectorGrid}>{["x", "y", "z"].map((axis) => <Field key={axis} label={`Size ${axis.toUpperCase()}`}><TextInput type="number" min="0.1" step="0.1" value={zone.size[axis]} onChange={(event) => onUpdate(["zones", index, "size", axis], Number(event.target.value))} /></Field>)}</div>
                        </article>
                    ))}
                </div>
            )}

            <div className={styles.splitHeading}><div><h3>Trigger events</h3></div><Button size="compact" onClick={addTrigger}><IconPlus size={14} stroke={1.75} /> Add trigger</Button></div>
            {scenario.triggers.length === 0 ? <EmptyState icon={IconActivity} title="No trigger events" detail="Add a time, step, signal, flag, distance, or zone event." /> : (
                <div className={styles.triggerList}>
                    {scenario.triggers.map((trigger, index) => {
                        return (
                            <article className={styles.triggerCard} key={trigger.id}>
                                <header>
                                    <span className={styles.triggerIndex}>{index + 1}</span>
                                    <TextInput aria-label={`Trigger ${index + 1} nickname`} value={trigger.name} onChange={(event) => onUpdate(["triggers", index, "name"], event.target.value)} />
                                    <Switch label="Enabled" checked={trigger.enabled !== false} onCheckedChange={(value) => onUpdate(["triggers", index, "enabled"], value)} />
                                    <RemoveButton label={`Remove ${trigger.name}`} onClick={() => onUpdate(["triggers"], scenario.triggers.filter((entry) => entry.id !== trigger.id))} />
                                </header>
                                <div className={styles.triggerFlow}>
                                    <div><span>WHEN</span><NativeSelect aria-label="Trigger condition" value={trigger.condition.kind} onChange={(event) => onUpdate(["triggers", index, "condition"], { ...trigger.condition, kind: event.target.value })}>{TRIGGER_CONDITIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</NativeSelect></div>
                                    <Switch label="Repeat while true" checked={trigger.once === false} onCheckedChange={(value) => onUpdate(["triggers", index, "once"], !value)} />
                                    {trigger.condition.kind === "time" && <Field label="Time (seconds)"><TextInput type="number" min="0" step="0.1" value={(trigger.condition.timeNs || 0) / 1e9} onChange={(event) => onUpdate(["triggers", index, "condition", "timeNs"], Number(event.target.value) * 1e9)} /></Field>}
                                    {trigger.condition.kind === "step" && <Field label="Step"><TextInput type="number" min="0" value={trigger.condition.step || 0} onChange={(event) => onUpdate(["triggers", index, "condition", "step"], Number(event.target.value))} /></Field>}
                                    {["zone-enter", "zone-exit"].includes(trigger.condition.kind) && <><Field label="Actor"><NativeSelect value={trigger.condition.actorId || "ego"} onChange={(event) => onUpdate(["triggers", index, "condition", "actorId"], event.target.value)}>{scenario.actors.map((actor) => <option key={actor.id} value={actor.id}>{actor.name}</option>)}</NativeSelect></Field><Field label="Zone"><NativeSelect value={trigger.condition.zoneId || ""} onChange={(event) => onUpdate(["triggers", index, "condition", "zoneId"], event.target.value)}><option value="">Select zone</option>{scenario.zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</NativeSelect></Field></>}
                                    {trigger.condition.kind === "signal" && <><Field label="Signal path"><TextInput value={trigger.condition.path || ""} onChange={(event) => onUpdate(["triggers", index, "condition", "path"], event.target.value)} /></Field><Field label="Comparison"><NativeSelect value={trigger.condition.operator || "eq"} onChange={(event) => onUpdate(["triggers", index, "condition", "operator"], event.target.value)}><option value="eq">Equals</option><option value="neq">Not equal</option><option value="lt">Less than</option><option value="lte">Less or equal</option><option value="gt">Greater than</option><option value="gte">Greater or equal</option></NativeSelect></Field><Field label="Expected value"><TextInput value={String(trigger.condition.expected ?? true)} onChange={(event) => onUpdate(["triggers", index, "condition", "expected"], parseTypedValue(event.target.value))} /></Field></>}
                                    {trigger.condition.kind === "flag" && <><Field label="Scenario flag"><TextInput value={trigger.condition.flag || ""} onChange={(event) => onUpdate(["triggers", index, "condition", "flag"], event.target.value)} /></Field><Field label="Expected"><NativeSelect value={String(trigger.condition.expected ?? true)} onChange={(event) => onUpdate(["triggers", index, "condition", "expected"], event.target.value === "true")}><option value="true">True</option><option value="false">False</option></NativeSelect></Field></>}
                                    {trigger.condition.kind === "actor-distance" && <><Field label="Actor"><NativeSelect value={trigger.condition.actorId || "ego"} onChange={(event) => onUpdate(["triggers", index, "condition", "actorId"], event.target.value)}>{scenario.actors.map((actor) => <option key={actor.id} value={actor.id}>{actor.name}</option>)}</NativeSelect></Field><Field label="Other actor"><NativeSelect value={trigger.condition.otherActorId || ""} onChange={(event) => onUpdate(["triggers", index, "condition", "otherActorId"], event.target.value)}><option value="">Select actor</option>{scenario.actors.filter((actor) => actor.id !== trigger.condition.actorId).map((actor) => <option key={actor.id} value={actor.id}>{actor.name}</option>)}</NativeSelect></Field><Field label="Threshold (m)"><TextInput type="number" min="0" step="0.1" value={trigger.condition.thresholdM || 0} onChange={(event) => onUpdate(["triggers", index, "condition", "thresholdM"], Number(event.target.value))} /></Field></>}
                                </div>
                                <div className={styles.triggerActionsHeading}><span>THEN</span><Button size="compact" onClick={() => onUpdate(["triggers", index, "actions"], [...(trigger.actions || []), { kind: "set-flag", flag: "scenario.custom_flag", value: true }])}><IconPlus size={13} /> Add action</Button></div>
                                <div className={styles.triggerActions}>{(trigger.actions?.length ? trigger.actions : [{ kind: "finish" }]).map((action, actionIndex, actions) => <TriggerActionEditor key={`${trigger.id}-action-${actionIndex}`} action={action} index={actionIndex} scenario={scenario} canRemove={actions.length > 1} onChange={(next) => onUpdate(["triggers", index, "actions", actionIndex], next)} onRemove={() => onUpdate(["triggers", index, "actions"], trigger.actions.filter((_, candidate) => candidate !== actionIndex))} />)}</div>
                            </article>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export function TimelineSection({ scenario }) {
    const timed = useMemo(() => scenario.triggers.filter((trigger) => ["time", "step"].includes(trigger.condition.kind)).sort((left, right) => (left.condition.timeNs || left.condition.step || 0) - (right.condition.timeNs || right.condition.step || 0)), [scenario.triggers]);
    const conditional = scenario.triggers.filter((trigger) => !["time", "step"].includes(trigger.condition.kind));
    return (
        <div className={styles.sectionStack}>
            <SectionHeading eyebrow="" title="Timeline" 
            detail="" 
            />
            <section className={styles.timelinePanel}>
                <div className={styles.timelineTrack}>
                    <div className={styles.timelineOrigin}><span>0s</span><i /></div>
                    {timed.map((trigger) => <div className={styles.timelineEvent} key={trigger.id}><span>{trigger.condition.kind === "time" ? `${((trigger.condition.timeNs || 0) / 1e9).toFixed(1)}s` : `step ${trigger.condition.step || 0}`}</span><i /><strong>{trigger.name}</strong></div>)}
                    <div className={styles.timelineFinish}><span>•••</span><i><IconFlag3 size={13} /></i><strong>Finish</strong></div>
                </div>
            </section>
            <div className={styles.splitHeading}><div><h3>Conditional events</h3></div><span className={styles.countBadge}>{conditional.length}</span></div>
            {conditional.length === 0 ? <EmptyState icon={IconClock} title="No conditional events" detail="Zone, signal, flag, and actor-distance events appear here." /> : <div className={styles.conditionalList}>{conditional.map((trigger) => <article key={trigger.id}><IconActivity size={15} stroke={1.7} /><div><strong>{trigger.name}</strong><p>{TRIGGER_CONDITIONS.find((entry) => entry.value === trigger.condition.kind)?.label || trigger.condition.kind}</p></div><span>{terminalTrigger(trigger) ? "finishes" : "action"}</span></article>)}</div>}
        </div>
    );
}

export function CompletionSection({ scenario, onUpdate }) {
    const [kind, setKind] = useState("max-duration");
    const finishTriggers = scenario.triggers.filter(terminalTrigger);
    const conditions = scenario.completion?.conditions || [];
    const addCondition = () => {
        const id = nextId("completion", conditions);
        onUpdate(["completion", "conditions"], [...conditions, { id, name: COMPLETION_OPTIONS.find((entry) => entry.value === kind)?.label || "Completion", kind, durationNs: 30e9, scriptId: null, cadence: { kind: "every-step", everyN: 1, triggerId: null }, onError: "fail" }]);
    };
    return (
        <div className={styles.sectionStack}>
            <SectionHeading eyebrow="" title="Completion" 
                detail="" 
            />
            {finishTriggers.map((trigger) => <article className={styles.linkedCompletion} key={trigger.id}><IconFlag3 size={18} stroke={1.55} /><div><span>Linked finish trigger</span><strong>{trigger.name}</strong><p>{TRIGGER_CONDITIONS.find((entry) => entry.value === trigger.condition.kind)?.label}</p></div></article>)}
            <div className={styles.addBar}><NativeSelect aria-label="Completion condition type" value={kind} onChange={(event) => setKind(event.target.value)}>{COMPLETION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</NativeSelect><Button variant="primary" onClick={addCondition}><IconPlus size={14} stroke={1.75} /> Add condition</Button></div>
            {conditions.length === 0 && finishTriggers.length === 0 ? <EmptyState icon={IconFlag3} title="No termination condition" detail="A valid scenario must have at least one completion condition or finish trigger." /> : (
                <div className={styles.cardGrid}>
                    {conditions.map((condition, index) => (
                        <article className={styles.configCard} key={condition.id}>
                            <div className={styles.cardTopline}><span>{condition.kind.replaceAll("-", " ")}</span><RemoveButton label={`Remove ${condition.name}`} onClick={() => onUpdate(["completion", "conditions"], conditions.filter((entry) => entry.id !== condition.id))} /></div>
                            <div className={styles.formGrid}>
                                <Field label="Name"><TextInput value={condition.name} onChange={(event) => onUpdate(["completion", "conditions", index, "name"], event.target.value)} /></Field>
                                {condition.kind === "max-duration" && <Field label="Maximum duration (seconds)"><TextInput type="number" min="0" step="0.1" value={(condition.durationNs || 0) / 1e9} onChange={(event) => onUpdate(["completion", "conditions", index, "durationNs"], Number(event.target.value) * 1e9)} /></Field>}
                                {condition.kind === "script" && <>
                                    <Field label="Predicate script ID"><TextInput value={condition.scriptId || ""} onChange={(event) => onUpdate(["completion", "conditions", index, "scriptId"], event.target.value || null)} /></Field>
                                    <Field label="Cadence"><NativeSelect value={condition.cadence?.kind || "every-step"} onChange={(event) => onUpdate(["completion", "conditions", index, "cadence"], { ...condition.cadence, kind: event.target.value })}><option value="every-step">Every step</option><option value="every-n-steps">Every N steps</option><option value="trigger">From trigger</option></NativeSelect></Field>
                                    {condition.cadence?.kind === "every-n-steps" && <Field label="Every N steps"><TextInput type="number" min="1" step="1" value={condition.cadence.everyN || 1} onChange={(event) => onUpdate(["completion", "conditions", index, "cadence", "everyN"], Math.max(1, Number(event.target.value) || 1))} /></Field>}
                                    {condition.cadence?.kind === "trigger" && <Field label="Invocation trigger"><NativeSelect value={condition.cadence.triggerId || ""} onChange={(event) => onUpdate(["completion", "conditions", index, "cadence", "triggerId"], event.target.value || null)}><option value="">Select trigger</option>{scenario.triggers.map((trigger) => <option key={trigger.id} value={trigger.id}>{trigger.name}</option>)}</NativeSelect></Field>}
                                    <Field label="On script error"><NativeSelect value={condition.onError || "fail"} onChange={(event) => onUpdate(["completion", "conditions", index, "onError"], event.target.value)}><option value="fail">Fail scenario</option><option value="continue">Diagnostic only</option></NativeSelect></Field>
                                </>}
                            </div>
                        </article>
                    ))}
                </div>
            )}
        </div>
    );
}

export function OutcomesSection({ scenario, onUpdate }) {
    const [kind, setKind] = useState("no-collisions");
    const finishZoneIds = new Set(scenario.triggers.filter((trigger) => (
        ["zone-enter", "zone-exit"].includes(trigger.condition?.kind)
        && trigger.actions?.some((action) => action.kind === "finish")
    )).map((trigger) => trigger.condition.zoneId));
    const finishZones = scenario.zones.filter((zone) => finishZoneIds.has(zone.id));
    const addOutcome = () => {
        const id = nextId("outcome", scenario.expectedOutcomes);
        onUpdate(["expectedOutcomes"], [...scenario.expectedOutcomes, { id, name: OUTCOME_OPTIONS.find((entry) => entry.value === kind)?.label || "Expected outcome", kind, actorId: "ego", zoneId: kind === "finish-zone" ? finishZones[0]?.id || null : null, routeId: scenario.routes[0]?.id || null, thresholdM: 1, flag: "", scriptId: null, required: true, onError: "fail" }]);
    };
    return (
        <div className={styles.sectionStack}>
            <SectionHeading eyebrow="" title="Expected outcomes" detail="" />
            <div className={styles.addBar}><NativeSelect aria-label="Expected outcome type" value={kind} onChange={(event) => setKind(event.target.value)}>{OUTCOME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</NativeSelect><Button variant="primary" onClick={addOutcome}><IconPlus size={14} stroke={1.75} /> Add outcome</Button></div>
            {scenario.expectedOutcomes.length === 0 ? <EmptyState icon={IconCheckPlaceholder} title="No expected outcomes" detail="No expected outcomes has been created for this scenario -- it's recommended to add some for proper experimentation." /> : (
                <div className={styles.outcomeList}>
                    {scenario.expectedOutcomes.map((outcome, index) => (
                        <article className={styles.outcomeCard} key={outcome.id}>
                            <span className={styles.outcomeStatus}>PENDING</span>
                            <div className={styles.outcomeBody}>
                                <TextInput aria-label={`Outcome ${index + 1} name`} value={outcome.name} onChange={(event) => onUpdate(["expectedOutcomes", index, "name"], event.target.value)} />
                                <p>{OUTCOME_OPTIONS.find((entry) => entry.value === outcome.kind)?.label || outcome.kind}</p>
                                {outcome.kind === "finish-zone" && <Field label="Finish zone"><NativeSelect value={outcome.zoneId || ""} onChange={(event) => onUpdate(["expectedOutcomes", index, "zoneId"], event.target.value || null)}><option value="">Select a finish zone</option>{finishZones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</NativeSelect></Field>}
                                {outcome.kind === "final-waypoint-distance" && <div className={styles.formGrid}><Field label="Actor"><NativeSelect value={outcome.actorId || "ego"} onChange={(event) => onUpdate(["expectedOutcomes", index, "actorId"], event.target.value)}>{scenario.actors.map((actor) => <option key={actor.id} value={actor.id}>{actor.name}</option>)}</NativeSelect></Field><Field label="Route"><NativeSelect value={outcome.routeId || ""} onChange={(event) => { const routeId = event.target.value || null; const route = scenario.routes.find((entry) => entry.id === routeId); onUpdate(["expectedOutcomes", index], { ...outcome, routeId, actorId: route?.actorId || outcome.actorId }); }}><option value="">Actor route</option>{scenario.routes.map((route) => <option key={route.id} value={route.id}>{route.name}</option>)}</NativeSelect></Field><Field label="Threshold (m)"><TextInput type="number" min="0" step="0.1" value={outcome.thresholdM} onChange={(event) => onUpdate(["expectedOutcomes", index, "thresholdM"], Number(event.target.value))} /></Field></div>}
                                {outcome.kind === "flag-true" && <Field label="Scenario flag"><TextInput value={outcome.flag || ""} onChange={(event) => onUpdate(["expectedOutcomes", index, "flag"], event.target.value)} /></Field>}
                                {outcome.kind === "script" && <div className={styles.formGrid}><Field label="Boolean script ID"><TextInput value={outcome.scriptId || ""} onChange={(event) => onUpdate(["expectedOutcomes", index, "scriptId"], event.target.value || null)} /></Field><Field label="On script error"><NativeSelect value={outcome.onError || "fail"} onChange={(event) => onUpdate(["expectedOutcomes", index, "onError"], event.target.value)}><option value="fail">Fail outcome</option><option value="continue">Diagnostic only</option></NativeSelect></Field></div>}
                            </div>
                            <span className={styles.outcomeContract}>Required</span>
                            <RemoveButton label={`Remove ${outcome.name}`} onClick={() => onUpdate(["expectedOutcomes"], scenario.expectedOutcomes.filter((entry) => entry.id !== outcome.id))} />
                        </article>
                    ))}
                </div>
            )}
        </div>
    );
}

function IconCheckPlaceholder(props) {
    return <IconRoute {...props} />;
}
