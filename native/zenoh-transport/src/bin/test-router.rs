// Same-lock SDK router for local integration; release gates also run against zenohd.
use std::io::{self, BufRead};
use zenoh::Wait;
fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.iter().any(|arg| arg == "--version") {
        println!("Zenoh SDK test router 1.10.2");
        return Ok(());
    }
    let endpoint = args
        .iter()
        .position(|arg| arg == "--listen")
        .and_then(|i| args.get(i + 1))
        .ok_or("--listen required")?;
    let config = serde_json::json!({"mode":"router", "listen":{"endpoints":[endpoint]}, "scouting":{"multicast":{"enabled":false}},
        "transport":{"shared_memory":{"enabled":true,"transport_optimization":{"enabled":false}}}});
    let session = zenoh::open(zenoh::Config::from_json5(&config.to_string())?).wait()?;
    println!(
        "{}",
        serde_json::json!({"kind":"ready","zenohVersion":"1.10.2"})
    );
    for line in io::stdin().lock().lines() {
        if line? == "close" {
            break;
        }
    }
    session.close().wait()?;
    Ok(())
}
