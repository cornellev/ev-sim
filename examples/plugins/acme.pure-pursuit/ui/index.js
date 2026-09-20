const pluginUi = {
    registerUi(uiApi) {
        const { React, SettingsForm } = uiApi;
        function SteerView(props) {
            return React.createElement(
                "div",
                { "data-plugin-view": "acme.pure-pursuit" },
                React.createElement("p", { className: "text-[11px] text-zinc-300" }, "REP-103 steer helper"),
                React.createElement(SettingsForm, {
                    uuid: props.uuid,
                    settings: props.settings,
                    state: props.state,
                }),
            );
        }
        uiApi.contributeUnitView({ type: "acme.pure-pursuit.SteerBlock", component: SteerView });
    },
};

export default pluginUi;
