use simcontrol::{Client, RunConfig};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let manifest_id = args
        .next()
        .ok_or("Usage: basic MANIFEST_ID [SERVER_URL] [BROWSER_ID]")?;
    let url = args
        .next()
        .unwrap_or_else(|| "http://127.0.0.1:3000".into());
    let client = Client::new(&url)?;
    let tabs = client.get_tabs()?;
    println!(
        "Tabs: {} (default: {:?})",
        tabs.browsers.len(),
        tabs.browser_id
    );

    let mut config = RunConfig::new(manifest_id);
    config.browser_id = args.next();
    config.autoplay = false;
    let mut sim = client.launch(config)?;
    println!("Tab {}, run {}", sim.browser_id(), sim.run_id());
    sim.resume()?;
    println!("Status: {:?}", sim.status()?.snapshot);
    sim.pause()?;
    sim.reset()?;
    println!("Stopped: {:?}", sim.stop()?);
    Ok(())
}
