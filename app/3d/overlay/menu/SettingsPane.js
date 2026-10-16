'use client';

import { AdvancedSwitch, AuthoringModeProvider } from "../../../ui";

export function SettingsPane() {
    return (
        <AuthoringModeProvider>
            <div className="sf-workspace-menu__body">
                <section className="sf-workspace-menu__section">
                    <h2 className="sf-workspace-menu__section-title">Authoring</h2>
                    <div className="sf-workspace-menu__setting">
                        <AdvancedSwitch description="Show calibration, timing, schema, and other fields that are hidden in simple mode." />
                    </div>
                </section>
            </div>
        </AuthoringModeProvider>
    );
}
