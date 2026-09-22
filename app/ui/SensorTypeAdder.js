'use client';

import { useState } from "react";
import { IconPlus } from "@tabler/icons-react";

import {
    sensorCatalogEntryKey,
    sensorCatalogEntryLabel,
} from "../plugin/PluginSensorAuthoring.js";
import { Button } from "./Button.js";
import { NativeSelect } from "./FormControls.js";

export default function SensorTypeAdder({ entries = [], onAdd }) {
    const [selectedKey, setSelectedKey] = useState("");
    const selected = entries.find((entry) => sensorCatalogEntryKey(entry) === selectedKey) ?? entries[0] ?? null;
    const activeKey = selected ? sensorCatalogEntryKey(selected) : "";

    return (
        <div className="flex flex-wrap items-center gap-1.5">
            <NativeSelect
                aria-label="Sensor type"
                value={activeKey}
                disabled={entries.length === 0}
                onChange={(event) => setSelectedKey(event.target.value)}
            >
                {entries.map((entry) => {
                    const key = sensorCatalogEntryKey(entry);
                    return (
                        <option key={key} value={key}>
                            {sensorCatalogEntryLabel(entry)}
                        </option>
                    );
                })}
            </NativeSelect>
            <Button
                size="compact"
                disabled={!selected}
                onClick={() => {
                    if (!selected) return;
                    Promise.resolve(onAdd?.(selected)).catch(() => {});
                }}
            >
                <IconPlus size={14} stroke={1.75} />
                Add sensor
            </Button>
        </div>
    );
}
