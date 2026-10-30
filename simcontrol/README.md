# simcontrol

A small blocking Rust client for the ev-sim browser simulation API.
Start the usual simulator server (`npm run dev` or `npm start`), open its page,
and save a run manifest first. The client controls that open page; it does not
start a server or browser process.

## Install locally

Add this to your application's `Cargo.toml`, adjusting the path to your checkout:

```toml
[dependencies]
simcontrol = { path = "../ev-sim/simcontrol" }
```

## Use

```rust,no_run
use simcontrol::{Client, RunConfig};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new("http://127.0.0.1:3000")?;
    let tabs = client.get_tabs()?;
    println!("Default tab: {:?}", tabs.browser_id);

    let mut config = RunConfig::new("igvc-default");
    // Optional: target an exact tab rather than the server-selected default.
    config.browser_id = tabs.browser_id;
    config.autoplay = false;

    let mut sim = client.launch(config)?;
    println!("Tab {}, run {}", sim.browser_id(), sim.run_id());
    sim.resume()?;
    println!("Time: {} ns", sim.status()?.snapshot.time_ns);
    sim.pause()?;
    sim.reset()?; // Prepares the latest saved revision; updates sim.run_id().
    let stopped = sim.stop()?;
    println!("Simulation result: {:?}", stopped.run_result);
    Ok(())
}
```

`RunConfig::new` defaults to autoplay and leaves tab selection to the server.
`launch` waits until the browser has prepared/started the run, not until the
episode finishes. Each handle retains its own browser and run IDs, so changing
tab focus never retargets its methods. `status` rejects a replacement run, and
lifecycle commands use the server's stale-run guards. `reset` leaves the new
run ready without autoplay; failed resets leave the handle's run ID unchanged.

`get_tabs()` returns `Tabs { browser_id, browsers }`. Each tab has `is_default`
and `status`, containing browser metadata and a `snapshot` of the simulation.
Use `client.get_status(None)` for the server's current default tab, or
`client.get_status(Some(browser_id))` for a specific page. Clock values remain
decimal strings, including values larger than JavaScript's safe integer range.

## Deadlines and errors

Lifecycle calls poll receipts every 200 ms and have a 120-second total deadline.
Use `Client::with_timeout(url, Duration::from_secs(30))` to change that deadline.
Individual HTTP exchanges have a 10-second limit, shortened to the remaining
lifecycle deadline where applicable. Methods block the calling thread.

Errors expose `kind`, `message`, optional HTTP `status`, server `code`, and known
`command_id` / `browser_id`. Use `client.get_command(command_id)` to inspect a
receipt after a timeout or interrupted polling. Receipts are temporary server
records; a restart or expiry can make them unavailable.

Commands are never automatically resubmitted. A transport failure during
submission can leave the outcome uncertain before a command ID is received.
Timeouts and `UnknownOutcome` errors do not cancel execution. Inspect the tab
or known receipt before issuing more commands; do not blindly repeat an
uncertain command. Dropping a client or run handle does not stop a simulation.

A successful lifecycle acknowledgement can contain an unsuccessful simulation
result. Inspect `Snapshot::run_result` separately from the method's `Result`.

This package uses the existing [browser API](../docs/browser-sim-api.md).
It does not author manifests, transport sensor data, or use the private browser
bridge endpoints.

## Develop

From the repository root:

```sh
cargo test --manifest-path simcontrol/Cargo.toml --locked
cargo fmt --manifest-path simcontrol/Cargo.toml -- --check
cargo clippy --manifest-path simcontrol/Cargo.toml --locked --all-targets -- -D warnings
cargo build --manifest-path simcontrol/Cargo.toml --locked --examples
cargo run --manifest-path simcontrol/Cargo.toml --example basic -- igvc-default
```

The example accepts optional server URL and browser ID arguments after the
manifest ID. Tests use a local mock HTTP server and need no simulator or GPU.
