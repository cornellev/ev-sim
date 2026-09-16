'use client';

import { useState } from "react";
import { IconArrowsMoveHorizontal, IconColumnInsertLeft, IconColumnInsertRight, IconTrash } from "@tabler/icons-react";
import { IconButton, NativeSelect } from "../../../ui";
import { ROAD_MARKINGS } from "../../../roads/RoadLaneModel.js";
import { insertRoadLane, removeRoadLane, setRoadLane } from "../../editor/commands/roadCommands.js";
import { issuesByPath, issuesForField } from "../../editor/presentation/fieldModel.js";
import { useNumberInput } from "../fields/NumberField";
import { cn } from "../ui/cn";

const SVG_WIDTH = 240;
const LANE_HEIGHT = 44;
const SHOULDER_HEIGHT = 30;
const PADDING_Y = 10;
const SVG_HEIGHT = LANE_HEIGHT + PADDING_Y * 2;
const DIRECTION_OPTIONS = Object.freeze([
    { value: "1", label: "Forward" },
    { value: "-1", label: "Backward" },
    { value: "0", label: "Shared" },
]);
const WIDTH_DESCRIPTOR = Object.freeze({ path: ["width"], label: "Width", control: "number", units: "m", min: 0.5, step: 0.1 });
const AUTO_MARKING = "auto";

function directionLabel(direction) {
    return direction === 0 ? "shared" : direction === -1 ? "backward" : "forward";
}

/** Marking style for a boundary: authored value, or the automatic style by adjacency. */
function resolveMarking(marking, opposing) {
    if (marking) return marking;
    return opposing ? "dashed_yellow" : "dashed_white";
}

function markingStroke(marking) {
    if (!marking || marking === "none") return null;
    return {
        stroke: marking.endsWith("yellow") ? "#facc15" : "#f4f4f5",
        strokeDasharray: marking.startsWith("dashed") ? "6 4" : undefined,
        strokeWidth: 2,
    };
}

/** Compact one-line lane editor row; every control names its lane for assistive tech. */
function LaneRow({ lane, laneCount, selected, disabled, issues, onSelect, onDirection, onWidth, onMarking, onInsert, onRemove }) {
    const widthId = `road-lane-width-${lane.id}`;
    const widthIssues = issuesForField(issues, { path: ["lanes", lane.index, "width"] });
    const { input, scrubHandlers } = useNumberInput({
        id: widthId,
        descriptor: WIDTH_DESCRIPTOR,
        value: lane.width,
        disabled,
        issues: widthIssues,
        onCommit: onWidth,
        ariaLabel: `Lane ${lane.id} width`,
        className: "w-[64px]",
    });
    const rowIssues = issuesForField(issues, { path: ["lanes", lane.index] });
    const issue = rowIssues.find((entry) => entry.severity === "error") ?? rowIssues[0] ?? null;
    const leftmost = lane.index === laneCount - 1;
    return (
        <li
            className={cn("rounded-[var(--radius)] px-1 py-1", selected && "bg-[var(--slate-surface-2)]")}
            data-road-lane-row={lane.id}
            data-lane-selected={selected || undefined}
            aria-current={selected || undefined}
        >
            <div className="flex items-center gap-1">
                <button
                    type="button"
                    onClick={onSelect}
                    aria-pressed={selected}
                    aria-label={`Select lane ${lane.id}`}
                    className={cn(
                        "h-7 min-w-[56px] shrink-0 rounded-[var(--radius)] border px-1.5 text-left font-mono text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--slate-ring)]",
                        selected
                            ? "border-[var(--slate-ring)] text-[var(--slate-fg)]"
                            : "border-[var(--slate-border-60)] text-[var(--slate-fg-2)] hover:text-[var(--slate-fg)]",
                    )}
                >
                    {lane.id}
                </button>
                <NativeSelect
                    aria-label={`Lane ${lane.id} direction`}
                    className="sf-input--compact w-[92px]"
                    value={String(lane.direction)}
                    disabled={disabled}
                    onChange={(event) => onDirection(Number(event.target.value))}
                    onKeyDown={(event) => event.stopPropagation()}
                >
                    {DIRECTION_OPTIONS.filter((option) => option.value !== "0" || laneCount === 1).map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                </NativeSelect>
                <span
                    className={cn("flex items-center", scrubHandlers && "cursor-ew-resize")}
                    title={`Lane ${lane.id} width — drag to adjust`}
                    {...(scrubHandlers ?? {})}
                >
                    <IconArrowsMoveHorizontal size={13} stroke={1.75} aria-hidden="true" className="text-[var(--slate-muted)]" />
                </span>
                {input}
                <span className="text-[11px] text-[var(--slate-muted)]" aria-hidden="true">m</span>
                {!leftmost && (
                    <NativeSelect
                        aria-label={`Lane ${lane.id} left marking`}
                        className="sf-input--compact w-[104px]"
                        value={lane.markingLeft ?? AUTO_MARKING}
                        disabled={disabled}
                        onChange={(event) => onMarking(event.target.value === AUTO_MARKING ? null : event.target.value)}
                        onKeyDown={(event) => event.stopPropagation()}
                    >
                        <option value={AUTO_MARKING}>auto</option>
                        {ROAD_MARKINGS.map((marking) => <option key={marking} value={marking}>{marking}</option>)}
                    </NativeSelect>
                )}
                <span className="flex-1" />
                <IconButton label={`Insert lane right of ${lane.id}`} size="compact" variant="ghost" className="sf-icon-button--tight" disabled={disabled} onClick={() => onInsert("right")}>
                    <IconColumnInsertRight size={14} stroke={1.75} />
                </IconButton>
                <IconButton label={`Insert lane left of ${lane.id}`} size="compact" variant="ghost" className="sf-icon-button--tight" disabled={disabled} onClick={() => onInsert("left")}>
                    <IconColumnInsertLeft size={14} stroke={1.75} />
                </IconButton>
                <IconButton label={`Remove lane ${lane.id}`} size="compact" variant="ghost" className="sf-icon-button--tight" disabled={disabled || laneCount <= 1} onClick={onRemove}>
                    <IconTrash size={14} stroke={1.75} />
                </IconButton>
            </div>
            {issue && (
                <p role="alert" className="mt-0.5 text-[11px] leading-snug text-[var(--slate-danger)]">{issue.message}</p>
            )}
        </li>
    );
}

/**
 * ED-05 `RoadDisplay`: the road cross-section as seen travelling start → end
 * (rightmost lane, physical index 0, on the right), plus one editing row per
 * lane. Every interaction is an ordinary road command through the bus, so
 * validation, undo, and persistence match numeric field edits exactly.
 */
export function RoadDisplaySection({ data, section, onResult }) {
    const document = data?.environment?.()?.getDocument?.();
    const record = document?.getObject?.(section.edgeId) ?? null;
    const disabled = record?.components?.locked === true;
    const selection = data?.selection?.();
    const selectedLaneId = selection?.sub?.kind === "road-lane" && selection.sub.edgeId === section.edgeId ? selection.sub.laneId : null;
    const [issueIndex, setIssueIndex] = useIssueIndex(section);
    const run = (command) => {
        const result = data?.commands?.()?.execute(command);
        data?.simulation?.()?.render?.();
        setIssueIndex(result?.ok ? new Map() : issuesByPath((result?.issues ?? []).map(stripEdgePath)));
        onResult?.(result);
        return result?.ok === true;
    };
    const selectLane = (laneId) => selection?.select?.(section.edgeId, { mode: "replace", sub: { kind: "road-lane", edgeId: section.edgeId, laneId } });

    const { lanes, dividers, width, shoulderWidth, borders } = section;
    const total = width + shoulderWidth * 2;
    const scale = SVG_WIDTH / Math.max(total, 1e-6);
    // The diagram looks along the travel direction, so the rightmost lane
    // (offset +W/2) sits at the right edge of the drawing.
    const xForOffset = (rightOffset) => (SVG_WIDTH / 2) + rightOffset * scale;
    const laneRects = lanes.map((lane) => {
        const half = lane.width / 2;
        return { lane, x: xForOffset(lane.offset - half), width: lane.width * scale };
    });
    const summary = `${lanes.length} lane${lanes.length === 1 ? "" : "s"}, ${width.toFixed(2)} m: ${lanes.map((lane) => `${lane.id} ${directionLabel(lane.direction)} ${lane.width.toFixed(2)} m`).join(", ")}`;

    return (
        <div className="space-y-2 py-1 text-[12px]" data-road-display={section.edgeId} data-lanes-explicit={section.explicit || undefined} data-lane-count={lanes.length}>
            <svg
                role="img"
                aria-label={`Road cross-section: ${summary}`}
                viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
                width="100%"
                height={SVG_HEIGHT}
                className="block overflow-visible"
            >
                {shoulderWidth > 0 && [
                    <rect key="shoulder-left" x={0} y={PADDING_Y + (LANE_HEIGHT - SHOULDER_HEIGHT) / 2} width={shoulderWidth * scale} height={SHOULDER_HEIGHT} fill="#3f3f46" />,
                    <rect key="shoulder-right" x={SVG_WIDTH - shoulderWidth * scale} y={PADDING_Y + (LANE_HEIGHT - SHOULDER_HEIGHT) / 2} width={shoulderWidth * scale} height={SHOULDER_HEIGHT} fill="#3f3f46" />,
                ]}
                {laneRects.map(({ lane, x, width: laneWidth }) => {
                    const selected = lane.id === selectedLaneId;
                    const cx = x + laneWidth / 2;
                    const cy = PADDING_Y + LANE_HEIGHT / 2;
                    const arrows = lane.direction === 0 ? [1, -1] : [lane.direction];
                    return (
                        <g
                            key={lane.id}
                            data-road-lane={lane.id}
                            data-lane-direction={lane.direction}
                            data-lane-selected={selected || undefined}
                            onClick={() => selectLane(lane.id)}
                            className="cursor-pointer"
                        >
                            <rect x={x} y={PADDING_Y} width={laneWidth} height={LANE_HEIGHT} fill={selected ? "#075985" : "#52525b"} />
                            {arrows.map((direction, arrowIndex) => {
                                const offset = arrows.length === 1 ? 0 : (arrowIndex === 0 ? -6 : 6);
                                const tip = direction === 1 ? cy - 9 : cy + 9;
                                const base = direction === 1 ? cy + 5 : cy - 5;
                                return (
                                    <polygon
                                        key={direction}
                                        data-lane-arrow={direction}
                                        points={`${cx + offset},${tip} ${cx + offset - 5},${base} ${cx + offset + 5},${base}`}
                                        fill={selected ? "#e0f2fe" : "#f4f4f5"}
                                        opacity={0.9}
                                    />
                                );
                            })}
                        </g>
                    );
                })}
                {dividers.map((divider) => {
                    const marking = resolveMarking(divider.marking, divider.opposing);
                    const stroke = markingStroke(marking);
                    const x = xForOffset(divider.rightOffset);
                    return (
                        <line
                            key={divider.dividerIndex}
                            data-lane-divider={divider.opposing ? "opposing" : "same-direction"}
                            data-lane-marking={marking}
                            x1={x}
                            y1={PADDING_Y}
                            x2={x}
                            y2={PADDING_Y + LANE_HEIGHT}
                            stroke={stroke?.stroke ?? "transparent"}
                            strokeWidth={stroke?.strokeWidth ?? 0}
                            strokeDasharray={stroke?.strokeDasharray}
                        />
                    );
                })}
                {[["left", -width / 2, borders.left], ["right", width / 2, borders.right]].map(([side, offset, marking]) => {
                    const stroke = markingStroke(marking ?? "solid_white");
                    const x = xForOffset(offset);
                    return stroke ? (
                        <line key={side} data-road-border={side} x1={x} y1={PADDING_Y} x2={x} y2={PADDING_Y + LANE_HEIGHT} stroke={stroke.stroke} strokeWidth={stroke.strokeWidth} strokeDasharray={stroke.strokeDasharray} />
                    ) : null;
                })}
            </svg>
            <p className="text-[11px] text-[var(--slate-muted)]">
                {section.explicit ? "Explicit lanes" : "Derived from lane count"} · {width.toFixed(2)} m · looking start → end, rightmost lane on the right.
            </p>
            <ul className="space-y-0.5" aria-label="Lanes, rightmost first">
                {lanes.map((lane) => (
                    <LaneRow
                        key={lane.id}
                        lane={lane}
                        laneCount={lanes.length}
                        selected={lane.id === selectedLaneId}
                        disabled={disabled}
                        issues={issueIndex}
                        onSelect={() => selectLane(lane.id)}
                        onDirection={(direction) => run(setRoadLane({ edgeId: section.edgeId, laneId: lane.id, patch: { direction } }))}
                        onWidth={(value) => run(setRoadLane({ edgeId: section.edgeId, laneId: lane.id, patch: { width: value } }))}
                        onMarking={(marking) => run(setRoadLane({ edgeId: section.edgeId, laneId: lane.id, patch: { markingLeft: marking } }))}
                        onInsert={(side) => {
                            const result = data?.commands?.()?.execute(insertRoadLane({ edgeId: section.edgeId, at: { laneId: lane.id, side } }));
                            data?.simulation?.()?.render?.();
                            setIssueIndex(result?.ok ? new Map() : issuesByPath((result?.issues ?? []).map(stripEdgePath)));
                            onResult?.(result);
                            if (result?.ok && result.result?.laneId) selectLane(result.result.laneId);
                        }}
                        onRemove={() => {
                            if (run(removeRoadLane({ edgeId: section.edgeId, laneId: lane.id })) && selectedLaneId === lane.id) selection?.setSub?.(null);
                        }}
                    />
                ))}
            </ul>
            {(issueIndex.get("lanes") ?? []).map((issue, index) => (
                <p key={index} role="alert" className="text-[11px] leading-snug text-[var(--slate-danger)]">{issue.message}</p>
            ))}
        </div>
    );
}

/** Domain issues arrive as `roads.edges.<i>.lanes...`; keep the edge-relative tail. */
function stripEdgePath(issue) {
    const path = Array.isArray(issue?.path) ? issue.path : [];
    const lanes = path.indexOf("lanes");
    if (lanes >= 0) return { ...issue, path: path.slice(lanes) };
    return issue;
}

/** Issue index keyed by edge-relative path; stale issues drop when the section's edge changes. */
function useIssueIndex(section) {
    const [state, setState] = useState({ edgeId: section.edgeId, index: new Map() });
    const index = state.edgeId === section.edgeId ? state.index : new Map();
    return [index, (next) => setState({ edgeId: section.edgeId, index: next })];
}
