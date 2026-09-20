const plugin = {
    register(api) {
        class SteerBlock extends api.UnitBlock {
            register() {
                this.registerInput("x", "float64");
                this.registerInput("y", "float64");
                this.registerInput("yaw", "float64");
                this.registerInput("targetX", "float64");
                this.registerInput("targetY", "float64");
                this.registerOutput("steer", "float64");
                this.registerOutput("speed", "float64");
            }

            valid() {
                return this.hasInput("x") && this.hasInput("y") && this.hasInput("yaw")
                    && this.hasInput("targetX") && this.hasInput("targetY");
            }

            execute() {
                const dx = this.getInput("targetX") - this.getInput("x");
                const dy = this.getInput("targetY") - this.getInput("y");
                const alpha = Math.atan2(dy, dx) - this.getInput("yaw");
                const lookahead = Math.max(this.state.lookahead, 1e-6);
                const steer = Math.atan2(2 * this.state.wheelbase * Math.sin(alpha), lookahead);
                return new api.BlockOutput()
                    .set("steer", steer)
                    .set("speed", this.state.speed);
            }
        }

        api.contributeUnit({ type: "acme.pure-pursuit.SteerBlock", blockClass: SteerBlock });
    },
};

export default plugin;
