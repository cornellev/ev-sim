const pluginUi = {
    registerUi(uiApi) {
        const { React, SettingsForm } = uiApi;
        function ScaleView(props) {
            return React.createElement(
                "div",
                { "data-plugin-view": "acme.ui-scale" },
                React.createElement("p", { className: "text-[11px] text-zinc-300" }, `Custom factor ${props.state.factor}`),
                React.createElement(SettingsForm, {
                    uuid: props.uuid,
                    settings: props.settings,
                    state: props.state,
                }),
            );
        }
        uiApi.contributeUnitView({ type: "acme.ui-scale.ScaleBlock", component: ScaleView });
    },
};

export default pluginUi;
