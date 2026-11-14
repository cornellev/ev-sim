use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    io::{self, BufRead},
    sync::{Arc, Mutex},
};
use zenoh::{bytes::ZBytes, Wait};

fn fingerprint(payload: &ZBytes) -> u64 {
    let mut hash = DefaultHasher::new();
    payload.to_bytes().hash(&mut hash);
    hash.finish()
}
fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let option = |name: &str| {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let key = option("--key").ok_or("--key required")?;
    let hold: usize = option("--hold").unwrap_or("1".into()).parse()?;
    if hold > 64 {
        return Err("hold count exceeds 64".into());
    }
    let shm = option("--shm").unwrap_or("true".into()) == "true";
    let mut config = serde_json::json!({"scouting":{"multicast":{"enabled":false}}, "transport":{"shared_memory":{"enabled":shm,"transport_optimization":{"enabled":false}}}});
    if let Some(endpoint) = option("--listen") {
        config["mode"] = "peer".into();
        config["listen"] = serde_json::json!({"endpoints":[endpoint]});
    } else {
        config["mode"] = "client".into();
        config["connect"] = serde_json::json!({"endpoints":[option("--connect").ok_or("--connect required")?],"timeout_ms":5000,"exit_on_failure":true});
    }
    let session = zenoh::open(zenoh::Config::from_json5(&config.to_string())?).wait()?;
    let held = Arc::new(Mutex::new(Vec::<(ZBytes, u64)>::new()));
    let records = held.clone();
    let subscriber = session.declare_subscriber(key).callback(move |sample| {
        let mut records = records.lock().unwrap();
        if records.len() < hold { records.push((sample.payload().clone(), fingerprint(sample.payload()))); }
        let integrity = records.iter().all(|(bytes, expected)| fingerprint(bytes) == *expected);
        let bytes = sample.payload().to_bytes();
        println!("{}", serde_json::json!({"kind":"sample","length":sample.payload().len(),"firstByte":bytes.first(),"lastByte":bytes.last(),"shm":sample.payload().as_shm().is_some(),
            "held":records.len(),"heldIntegrity":integrity,"fingerprint":fingerprint(sample.payload()).to_string()}));
    }).wait()?;
    println!(
        "{}",
        serde_json::json!({"kind":"ready","zenohVersion":"1.10.2"})
    );
    for line in io::stdin().lock().lines() {
        match line?.as_str() {
            "check" => {
                let records = held.lock().unwrap();
                println!(
                    "{}",
                    serde_json::json!({"kind":"checked","held":records.len(),"heldIntegrity":records.iter().all(|(bytes, expected)| fingerprint(bytes) == *expected)})
                );
            }
            "release" => {
                held.lock().unwrap().clear();
                println!("{}", serde_json::json!({"kind":"released"}));
            }
            "close" => break,
            _ => return Err("unknown consumer instruction".into()),
        }
    }
    subscriber.undeclare().wait()?;
    held.lock().unwrap().clear();
    session.close().wait()?;
    println!("{}", serde_json::json!({"kind":"closed"}));
    Ok(())
}
