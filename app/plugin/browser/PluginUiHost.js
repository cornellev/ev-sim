import React, { Component, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { PLUGIN_UI_API_VERSION } from "../../plugin-api/ui.js";
import { PLUGIN_ERROR_CODES, assertSynchronous, pluginError } from "../PluginErrors.js";
import { clonePluginJson } from "../PluginJson.js";
import Unit from "../../scripting/units/Unit.js";
import PluginSettingsForm from "../../scripting/units/PluginSettingsForm.js";
import { BrowserPluginModuleSource } from "./BrowserPluginModuleSource.js";

const APPROVED_HOOKS = Object.freeze({
    useState,
    useEffect,
    useMemo,
    useCallback,
    useRef,
    useId,
});

export class PluginViewBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    render() {
        if (this.state.error) return this.props.fallback;
        return this.props.children;
    }
}

export function createUiApi({
    plugin,
    contributeUnitView,
    assetUrl,
    log = () => {},
    diagnostics = [],
}) {
    return Object.freeze({
        pluginApi: PLUGIN_UI_API_VERSION,
        plugin: Object.freeze({ ...plugin }),
        React,
        hooks: APPROVED_HOOKS,
        Unit,
        SettingsForm: PluginSettingsForm,
        contributeUnitView: (definition) => contributeUnitView(definition),
        assetUrl: (path) => assetUrl(path),
        log: (level, message, details) => log(level, message, details),
        diagnostics,
    });
}

export class PluginUiHost {
    constructor({ moduleSource = new BrowserPluginModuleSource(), logger = () => {} } = {}) {
        this.moduleSource = moduleSource;
        this.logger = logger;
        this.views = new Map();
        this.diagnostics = new Map();
    }

    get(type) {
        return this.views.get(type) || null;
    }

    diagnostic(type) {
        return this.diagnostics.get(type) || null;
    }

    async loadPackageUi(verified) {
        const plugin = {
            id: verified.document.id,
            version: verified.document.version,
            packageHash: verified.resource.packageHash,
            runtimeHash: verified.resource.runtimeHash,
        };
        const declared = new Set(verified.document.units.map((unit) => unit.type));
        const contributions = [];
        const diagnostics = [];
        if (!verified.document.entry?.ui) return { views: new Map(), diagnostics };
        try {
            const namespace = await this.moduleSource.importUi(verified);
            const registerUi = namespace?.default?.registerUi;
            if (typeof registerUi !== "function") {
                throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin "${plugin.id}" UI must export default.registerUi(uiApi).`, {
                    pluginId: plugin.id,
                    packageHash: plugin.packageHash,
                });
            }
            const api = createUiApi({
                plugin,
                diagnostics,
                log: (level, message, details) => this.logger({
                    level: String(level),
                    message: String(message),
                    details: details === undefined ? null : clonePluginJson(details, `${plugin.id}.ui.log`),
                    pluginId: plugin.id,
                    packageHash: plugin.packageHash,
                }),
                assetUrl: (relativePath) => this.moduleSource.assetUrl(verified, relativePath),
                contributeUnitView: (definition) => {
                    if (!definition || typeof definition !== "object" || typeof definition.type !== "string"
                        || typeof definition.component !== "function") {
                        throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, "Unit view contributions contain type and component.", {
                            pluginId: plugin.id,
                            packageHash: plugin.packageHash,
                        });
                    }
                    if (!declared.has(definition.type)) {
                        throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin registered undeclared unit view "${definition.type}".`, {
                            pluginId: plugin.id,
                            packageHash: plugin.packageHash,
                            contributionId: definition.type,
                        });
                    }
                    if (contributions.some((entry) => entry.type === definition.type)) {
                        throw pluginError(PLUGIN_ERROR_CODES.REGISTRATION, `Plugin registered unit view "${definition.type}" more than once.`, {
                            pluginId: plugin.id,
                            packageHash: plugin.packageHash,
                            contributionId: definition.type,
                        });
                    }
                    contributions.push(definition);
                },
            });
            assertSynchronous(registerUi(api), "registerUi", { pluginId: plugin.id, packageHash: plugin.packageHash });
            for (const contribution of contributions) {
                this.views.set(contribution.type, contribution.component);
            }
        } catch (error) {
            diagnostics.push(error?.message || String(error));
            this.logger({
                level: "error",
                message: error?.message || String(error),
                pluginId: plugin.id,
                packageHash: plugin.packageHash,
            });
        }
        for (const type of declared) {
            if (diagnostics.length) this.diagnostics.set(type, diagnostics.join(" "));
        }
        return { views: this.views, diagnostics };
    }
}
