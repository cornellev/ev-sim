'use client';

import { useSyncExternalStore } from "react";

import {
    chooseRunConfigMode,
    readResolvedRunConfigMode,
    RUN_CONFIG_MODE_FALLBACK,
    subscribeRunConfigMode,
} from "../../../config/runConfigMode.js";
import { AdvancedSwitch, AuthoringModeProvider, SegmentedControl } from "../../../ui";

export function SettingsPane() {
    const mode = useSyncExternalStore(subscribeRunConfigMode, readResolvedRunConfigMode, () => RUN_CONFIG_MODE_FALLBACK);
    return (
        <AuthoringModeProvider>
            <div className="sf-workspace-menu__body">
                <section className="sf-workspace-menu__section">
                    <h2 className="sf-workspace-menu__section-title">Authoring</h2>
                    <div className="sf-workspace-menu__setting">
                        <AdvancedSwitch description="Show calibration, timing, schema, and other fields that are hidden in simple mode." />
                    </div>
                </section>
                <section className="sf-workspace-menu__section">
                    <h2 className="sf-workspace-menu__section-title">Run configuration</h2>
                    <div className="sf-workspace-menu__setting">
                        <p className="sf-switch-copy__description">Simple and Advanced show the same run.</p>
                        <SegmentedControl
                            label="Run configuration view"
                            value={mode}
                            items={[{ value: "simple", label: "Simple" }, { value: "advanced", label: "Advanced" }]}
                            onValueChange={chooseRunConfigMode}
                        />
                    </div>
                </section>
            </div>
        </AuthoringModeProvider>
    );
}
