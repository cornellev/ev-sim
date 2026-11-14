mod shm;

use napi::{
    bindgen_prelude::*,
    threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode},
    Env, JsFunction, Status,
};
use napi_derive::napi;
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    future::IntoFuture,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
    time::Duration,
};
use tokio::{
    sync::{Mutex as AsyncMutex, Notify},
    task::JoinHandle,
};
use zenoh::{bytes::ZBytes, qos::CongestionControl, sample::SampleKind, Session};

const MAX_PAYLOAD: usize = 16 * 1024 * 1024;
const MIB: usize = 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostConfig {
    kind: String,
    version: u32,
    connect: Vec<String>,
    shm: ShmConfig,
    queue: QueueConfig,
    connect_timeout_ms: u64,
    publish_timeout_ms: u64,
    close_timeout_ms: u64,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShmConfig {
    mode: String,
    threshold_bytes: usize,
    pool_bytes: usize,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueConfig {
    max_entries: usize,
    max_bytes: usize,
}

impl HostConfig {
    fn validate(&self) -> Result<()> {
        if self.kind != "cev-sim.zenoh-transport-host-config"
            || self.version != 1
            || self.connect.is_empty()
            || self.connect.len() > 16
            || self.connect.iter().collect::<HashSet<_>>().len() != self.connect.len()
            || self.connect.iter().any(|e| {
                !e.starts_with("tcp/")
                    || e.len() > 1024
                    || e.contains(char::is_whitespace)
                    || e.parse::<zenoh::config::EndPoint>().is_err()
            })
            || !["disabled", "preferred", "required"].contains(&self.shm.mode.as_str())
            || self.shm.threshold_bytes < 64 * 1024
            || self.shm.threshold_bytes > MAX_PAYLOAD
            || self.shm.pool_bytes < self.shm.threshold_bytes
            || self.shm.pool_bytes > 128 * MIB
            || self.queue.max_entries == 0
            || self.queue.max_entries > 65536
            || self.queue.max_bytes == 0
            || self.queue.max_bytes > 128 * MIB
            || [
                self.connect_timeout_ms,
                self.publish_timeout_ms,
                self.close_timeout_ms,
            ]
            .iter()
            .any(|&n| n == 0 || n > 60000)
        {
            return Err(Error::new(
                Status::InvalidArg,
                "Invalid bounded native Zenoh configuration",
            ));
        }
        Ok(())
    }
}

#[derive(Default)]
struct Budget {
    entries: usize,
    bytes: usize,
    peak_entries: usize,
    peak_bytes: usize,
}
struct Reservation {
    budget: Arc<Mutex<Budget>>,
    bytes: usize,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        let mut b = self.budget.lock().unwrap();
        b.entries -= 1;
        b.bytes -= self.bytes;
    }
}
fn reserve(budget: &Arc<Mutex<Budget>>, limits: &QueueConfig, bytes: usize) -> Option<Reservation> {
    let mut b = budget.lock().unwrap();
    if b.entries >= limits.max_entries || bytes > limits.max_bytes.saturating_sub(b.bytes) {
        return None;
    }
    b.entries += 1;
    b.bytes += bytes;
    b.peak_entries = b.peak_entries.max(b.entries);
    b.peak_bytes = b.peak_bytes.max(b.bytes);
    Some(Reservation {
        budget: budget.clone(),
        bytes,
    })
}

struct PendingPublication {
    key: String,
    route: String,
    payload: ZBytes,
    generation: u32,
    required: bool,
    _reservation: Reservation,
}
struct PendingInbound {
    route: String,
    payload: ZBytes,
    generation: u32,
    _reservation: Reservation,
}
struct SubscriptionState {
    subscriber: zenoh::pubsub::Subscriber<()>,
    alive: Arc<AtomicBool>,
}
#[derive(Default)]
struct Stats {
    accepted: u64,
    sent: u64,
    received: u64,
    drops: u64,
    canceled: u64,
    failures: u64,
    allocations: u64,
    allocation_failures: u64,
    copies: u64,
    copy_bytes: u64,
    shm_publications: u64,
    network_publications: u64,
    resets: u64,
}
struct State {
    status: &'static str,
    generation: u32,
    outgoing: VecDeque<PendingPublication>,
    incoming: VecDeque<PendingInbound>,
    subscriptions: HashMap<u32, SubscriptionState>,
    next_subscription: u32,
    transports: Vec<(String, bool)>,
    stats: Stats,
    last_error: Option<(String, String)>,
    provider_available: bool,
}
struct Core {
    config: HostConfig,
    state: Mutex<State>,
    budget: Arc<Mutex<Budget>>,
    session: Mutex<Option<Session>>,
    provider: Mutex<Option<shm::Provider>>,
    ready: Notify,
    wake: ThreadsafeFunction<()>,
    wake_pending: AtomicBool,
    worker: Mutex<Option<JoinHandle<()>>>,
    monitor: Mutex<Option<JoinHandle<()>>>,
    lifecycle: AsyncMutex<()>,
}
impl Core {
    fn wake_js(&self) {
        if !self.wake_pending.swap(true, Ordering::SeqCst) {
            let status = self
                .wake
                .call(Ok(()), ThreadsafeFunctionCallMode::NonBlocking);
            if status != Status::Ok {
                self.wake_pending.store(false, Ordering::SeqCst);
            }
        }
    }
    fn failure(&self, code: &str, route: &str) {
        let mut state = self.state.lock().unwrap();
        if ["closing", "closed"].contains(&state.status) {
            return;
        }
        state.status = "failed";
        state.stats.failures += 1;
        state.last_error = Some((
            code.chars().take(1024).collect(),
            route.chars().take(128).collect(),
        ));
        state.outgoing.clear();
        state.incoming.clear();
        drop(state);
        self.ready.notify_waiters();
        self.wake_js();
    }
    fn shutdown(&self) {
        let mut state = self.state.lock().unwrap();
        let close_wake = state.status != "closed";
        state.status = "closed";
        state.provider_available = false;
        state.outgoing.clear();
        state.incoming.clear();
        for sub in state.subscriptions.values() {
            sub.alive.store(false, Ordering::SeqCst);
        }
        state.subscriptions.clear();
        drop(state);
        // Release the JS callback root so closed sessions can be collected.
        if close_wake {
            let _ = self.wake.clone().abort();
        }
        if let Some(task) = self.worker.lock().unwrap().take() {
            task.abort();
        }
        if let Some(task) = self.monitor.lock().unwrap().take() {
            task.abort();
        }
        self.session.lock().unwrap().take();
        self.provider.lock().unwrap().take();
        self.ready.notify_waiters();
    }
    fn start_worker(core: &Arc<Self>) {
        let core = core.clone();
        let owner = core.clone();
        *owner.worker.lock().unwrap() = Some(tokio::spawn(async move {
            loop {
                let notified = core.ready.notified();
                let packet = {
                    let mut s = core.state.lock().unwrap();
                    if s.status != "open" {
                        return;
                    }
                    s.outgoing.pop_front()
                };
                let Some(packet) = packet else {
                    notified.await;
                    continue;
                };
                let session = core.session.lock().unwrap().clone();
                let Some(session) = session else {
                    return;
                };
                let current = core.state.lock().unwrap().generation;
                if packet.generation != current {
                    continue;
                }
                let result = tokio::time::timeout(
                    Duration::from_millis(core.config.publish_timeout_ms),
                    session
                        .put(packet.key.clone(), packet.payload.clone())
                        .congestion_control(CongestionControl::Block)
                        .into_future(),
                )
                .await;
                match result {
                    Ok(Ok(())) => core.state.lock().unwrap().stats.sent += 1,
                    other => {
                        if packet.required {
                            core.failure(&format!("publish-failed: {other:?}"), &packet.route);
                        } else {
                            core.state.lock().unwrap().stats.drops += 1;
                        }
                    }
                }
            }
        }));
    }
}

#[napi]
pub struct NativeSession {
    core: Arc<Core>,
}
impl Drop for NativeSession {
    fn drop(&mut self) {
        self.core.shutdown();
    }
}

#[napi(object)]
pub struct PublicationAcceptance {
    pub ok: bool,
    pub accepted: bool,
    pub code: Option<String>,
    pub fatal: bool,
}
#[napi(object)]
pub struct InboundPacket {
    pub route_id: String,
    pub bytes: Buffer,
    pub generation: u32,
}

#[napi]
pub fn create_session(
    config_json: String,
    callback: JsFunction,
    mut env: Env,
) -> Result<NativeSession> {
    zenoh::init_log_from_env_or("error");
    if config_json.len() > 32768 {
        return Err(Error::new(
            Status::InvalidArg,
            "Native Zenoh configuration exceeds 32 KiB",
        ));
    }
    let config: HostConfig = serde_json::from_str(&config_json)
        .map_err(|e| Error::new(Status::InvalidArg, e.to_string()))?;
    config.validate()?;
    let mut wake: ThreadsafeFunction<(), ErrorStrategy::CalleeHandled> =
        callback.create_threadsafe_function(1, |_| Ok(Vec::<String>::new()))?;
    wake.unref(&env)?;
    let core = Arc::new(Core {
        config,
        budget: Arc::new(Mutex::new(Budget::default())),
        session: Mutex::new(None),
        provider: Mutex::new(None),
        ready: Notify::new(),
        wake,
        wake_pending: AtomicBool::new(false),
        worker: Mutex::new(None),
        monitor: Mutex::new(None),
        lifecycle: AsyncMutex::new(()),
        state: Mutex::new(State {
            status: "created",
            generation: 0,
            outgoing: VecDeque::new(),
            incoming: VecDeque::new(),
            subscriptions: HashMap::new(),
            next_subscription: 0,
            transports: Vec::new(),
            stats: Stats::default(),
            last_error: None,
            provider_available: false,
        }),
    });
    env.add_env_cleanup_hook(Arc::downgrade(&core), |weak: Weak<Core>| {
        if let Some(core) = weak.upgrade() {
            core.shutdown();
        }
    })?;
    Ok(NativeSession { core })
}

#[napi]
impl NativeSession {
    #[napi]
    pub async fn open_session(&self) -> Result<()> {
        let core = &self.core;
        let _guard = core.lifecycle.lock().await;
        if core.state.lock().unwrap().status != "created" {
            return Err(Error::new(
                Status::GenericFailure,
                "Session already opened or closed",
            ));
        }
        let config = zenoh::Config::from_json5(&json!({
            "mode": "client", "connect": { "endpoints": core.config.connect, "timeout_ms": core.config.connect_timeout_ms, "exit_on_failure": true },
            "scouting": { "multicast": { "enabled": false } },
            "transport": { "shared_memory": { "enabled": core.config.shm.mode != "disabled", "mode": "init", "transport_optimization": { "enabled": false } } }
        }).to_string()).map_err(|e| Error::new(Status::InvalidArg, e.to_string()))?;
        let session = tokio::time::timeout(
            Duration::from_millis(core.config.connect_timeout_ms),
            zenoh::open(config).into_future(),
        )
        .await
        .map_err(|_| Error::new(Status::GenericFailure, "Zenoh connection timed out"))?
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(core.config.connect_timeout_ms);
        let transports = loop {
            let transports = session
                .info()
                .transports()
                .await
                .into_iter()
                .map(|t| (t.zid().to_string(), t.is_shm()))
                .collect::<Vec<_>>();
            if !transports.is_empty()
                && (core.config.shm.mode != "required" || transports.iter().all(|(_, shm)| *shm))
            {
                break transports;
            }
            if tokio::time::Instant::now() >= deadline {
                break transports;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        let provider = if core.config.shm.mode == "disabled" {
            None
        } else {
            shm::create(core.config.shm.pool_bytes).ok()
        };
        if transports.is_empty()
            || (core.config.shm.mode == "required"
                && (provider.is_none() || transports.iter().any(|(_, shm)| !shm)))
        {
            let _ = tokio::time::timeout(
                Duration::from_millis(core.config.close_timeout_ms),
                session.close().into_future(),
            )
            .await;
            return Err(Error::new(Status::GenericFailure, format!("Required SHM unavailable on a direct connection (provider={}, transports={transports:?})", provider.is_some())));
        }
        let mut s = core.state.lock().unwrap();
        if s.status != "created" {
            return Err(Error::new(
                Status::GenericFailure,
                "Session canceled while opening",
            ));
        }
        s.provider_available = provider.is_some();
        s.transports = transports;
        s.status = "open";
        drop(s);
        *core.provider.lock().unwrap() = provider;
        *core.session.lock().unwrap() = Some(session.clone());
        Core::start_worker(core);
        let owner = core.clone();
        let monitor = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                if ["closed", "closing", "failed"].contains(&owner.state.lock().unwrap().status) {
                    return;
                }
                let transports = session
                    .info()
                    .transports()
                    .await
                    .into_iter()
                    .map(|t| (t.zid().to_string(), t.is_shm()))
                    .collect::<Vec<_>>();
                if transports.is_empty()
                    || (owner.config.shm.mode == "required"
                        && transports.iter().any(|(_, shm)| !shm))
                {
                    owner.failure("direct-connection-lost", "");
                    return;
                }
                owner.state.lock().unwrap().transports = transports;
            }
        });
        *core.monitor.lock().unwrap() = Some(monitor);
        Ok(())
    }

    #[napi]
    pub fn publish(
        &self,
        key: String,
        bytes: Uint8Array,
        route_id: String,
        generation: u32,
        required: bool,
    ) -> PublicationAcceptance {
        let core = &self.core;
        let rejected = |code: &str| {
            if required {
                core.failure(code, &route_id);
            } else {
                core.state.lock().unwrap().stats.drops += 1;
            }
            PublicationAcceptance {
                ok: false,
                accepted: false,
                code: Some(code.to_string()),
                fatal: required,
            }
        };
        if key.len() > 1024
            || key.contains('*')
            || zenoh::key_expr::OwnedKeyExpr::try_from(key.clone()).is_err()
            || route_id.len() > 128
            || bytes.len() > MAX_PAYLOAD
        {
            return rejected("invalid-publication");
        }
        let mut state = core.state.lock().unwrap();
        if state.status != "open" || state.generation != generation {
            return PublicationAcceptance {
                ok: false,
                accepted: false,
                code: Some("stale-or-closed".into()),
                fatal: state.status == "failed",
            };
        }
        let Some(reservation) = reserve(&core.budget, &core.config.queue, bytes.len()) else {
            drop(state);
            return rejected("queue-full");
        };
        let provider = core.provider.lock().unwrap();
        let use_shm = bytes.len() >= core.config.shm.threshold_bytes
            && provider.is_some()
            && state.transports.iter().any(|(_, shm)| *shm);
        let payload = if use_shm {
            match shm::copy(provider.as_ref().unwrap(), bytes.as_ref()) {
                Ok(payload) => {
                    state.stats.allocations += 1;
                    state.stats.shm_publications += 1;
                    payload
                }
                Err(_) => {
                    state.stats.allocation_failures += 1;
                    drop(provider);
                    drop(state);
                    return rejected("shm-exhausted");
                }
            }
        } else {
            state.stats.network_publications += 1;
            ZBytes::from(bytes.to_vec())
        };
        state.stats.copies += 1;
        state.stats.copy_bytes += bytes.len() as u64;
        state.stats.accepted += 1;
        state.outgoing.push_back(PendingPublication {
            key,
            route: route_id,
            payload,
            generation,
            required,
            _reservation: reservation,
        });
        drop(state);
        core.ready.notify_one();
        PublicationAcceptance {
            ok: true,
            accepted: true,
            code: None,
            fatal: false,
        }
    }

    #[napi]
    pub async fn subscribe(
        &self,
        key: String,
        route_id: String,
        generation: u32,
        required: bool,
    ) -> Result<u32> {
        let core = &self.core;
        let _guard = core.lifecycle.lock().await;
        if key.len() > 1024 || key.contains('*') || route_id.len() > 128 {
            return Err(Error::new(Status::InvalidArg, "Invalid subscription"));
        }
        {
            let s = core.state.lock().unwrap();
            if s.status != "open" || s.generation != generation || s.subscriptions.len() >= 64 {
                return Err(Error::new(
                    Status::GenericFailure,
                    "Stale, closed or full subscription registry",
                ));
            }
        }
        let session = core
            .session
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| Error::new(Status::GenericFailure, "Closed session"))?;
        let alive = Arc::new(AtomicBool::new(true));
        let enabled = alive.clone();
        let owner = Arc::downgrade(core);
        let sub = tokio::time::timeout(
            Duration::from_millis(core.config.connect_timeout_ms),
            session
                .declare_subscriber(key)
                .callback(move |sample| {
                    if !enabled.load(Ordering::SeqCst) || sample.kind() != SampleKind::Put {
                        return;
                    }
                    let Some(owner) = owner.upgrade() else {
                        return;
                    };
                    let mut s = owner.state.lock().unwrap();
                    if s.status != "open" || s.generation != generation {
                        return;
                    }
                    let len = sample.payload().len();
                    let reservation = if len <= MAX_PAYLOAD {
                        reserve(&owner.budget, &owner.config.queue, len)
                    } else {
                        None
                    };
                    let Some(reservation) = reservation else {
                        s.stats.drops += 1;
                        drop(s);
                        if required {
                            owner.failure("inbound-queue-full", &route_id);
                        }
                        return;
                    };
                    s.stats.received += 1;
                    s.incoming.push_back(PendingInbound {
                        route: route_id.clone(),
                        payload: sample.payload().clone(),
                        generation,
                        _reservation: reservation,
                    });
                    drop(s);
                    owner.wake_js();
                })
                .into_future(),
        )
        .await
        .map_err(|_| Error::new(Status::GenericFailure, "Subscription timed out"))?
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        let mut s = core.state.lock().unwrap();
        s.next_subscription = s
            .next_subscription
            .checked_add(1)
            .ok_or_else(|| Error::new(Status::GenericFailure, "Subscription ID exhausted"))?;
        let id = s.next_subscription;
        s.subscriptions.insert(
            id,
            SubscriptionState {
                subscriber: sub,
                alive,
            },
        );
        Ok(id)
    }

    #[napi]
    pub async fn unsubscribe(&self, id: u32) -> Result<()> {
        let _guard = self.core.lifecycle.lock().await;
        let sub = self.core.state.lock().unwrap().subscriptions.remove(&id);
        if let Some(sub) = sub {
            sub.alive.store(false, Ordering::SeqCst);
            tokio::time::timeout(
                Duration::from_millis(self.core.config.close_timeout_ms),
                sub.subscriber.undeclare().into_future(),
            )
            .await
            .map_err(|_| Error::new(Status::GenericFailure, "Unsubscribe timed out"))?
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        }
        Ok(())
    }

    #[napi]
    pub fn drain_inbound(&self) -> Vec<InboundPacket> {
        self.core.wake_pending.store(false, Ordering::SeqCst);
        let mut s = self.core.state.lock().unwrap();
        let packets = s.incoming.drain(..).collect::<Vec<_>>();
        let generation = s.generation;
        let open = s.status == "open";
        packets
            .into_iter()
            .filter(|p| open && p.generation == generation)
            .map(|p| {
                let bytes = p.payload.to_bytes();
                s.stats.copies += 1 + u64::from(matches!(bytes, std::borrow::Cow::Owned(_)));
                s.stats.copy_bytes += bytes.len() as u64
                    * (1 + u64::from(matches!(bytes, std::borrow::Cow::Owned(_))));
                InboundPacket {
                    route_id: p.route,
                    bytes: Buffer::from(bytes.to_vec()),
                    generation: p.generation,
                }
            })
            .collect()
    }

    #[napi]
    pub async fn reset(&self, generation: u32) -> Result<()> {
        let core = &self.core;
        let _guard = core.lifecycle.lock().await;
        let subs = {
            let mut s = core.state.lock().unwrap();
            if s.status != "open" || generation <= s.generation {
                return Err(Error::new(
                    Status::GenericFailure,
                    "Reset requires an open session and a newer generation",
                ));
            }
            s.status = "resetting";
            s.generation = generation;
            s.stats.resets += 1;
            s.stats.canceled += (s.outgoing.len() + s.incoming.len()) as u64;
            s.outgoing.clear();
            s.incoming.clear();
            s.subscriptions
                .drain()
                .map(|(_, sub)| {
                    sub.alive.store(false, Ordering::SeqCst);
                    sub.subscriber
                })
                .collect::<Vec<_>>()
        };
        let task = core.worker.lock().unwrap().take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
        for sub in subs {
            if !matches!(
                tokio::time::timeout(
                    Duration::from_millis(core.config.close_timeout_ms),
                    sub.undeclare().into_future()
                )
                .await,
                Ok(Ok(()))
            ) {
                core.failure("reset-timeout", "");
                return Err(Error::new(Status::GenericFailure, "Reset timed out"));
            }
        }
        let mut s = core.state.lock().unwrap();
        if s.status != "resetting" {
            return Err(Error::new(
                Status::GenericFailure,
                "Connection failed during reset",
            ));
        }
        s.status = "open";
        drop(s);
        Core::start_worker(core);
        Ok(())
    }

    #[napi]
    pub fn diagnostics(&self) -> String {
        let s = self.core.state.lock().unwrap();
        let b = self.core.budget.lock().unwrap();
        let provider = self.core.provider.lock().unwrap();
        let available = provider
            .as_ref()
            .map(|p| {
                p.garbage_collect();
                p.available()
            })
            .unwrap_or(0);
        let stats = &s.stats;
        json!({ "available": s.status == "open", "state": s.status, "generation": s.generation, "zenohVersion": "1.10.2", "napiVersion": 8,
            "shmProviderAvailable": s.provider_available, "poolReservedBytes": if s.provider_available { self.core.config.shm.pool_bytes } else { 0 },
            "sdkShmOverheadReservedBytes": if s.provider_available { 4*MIB } else { 0 }, "poolAvailableBytes": available,
            "queueEntries": b.entries, "queueBytes": b.bytes, "queuePeakEntries": b.peak_entries, "queuePeakBytes": b.peak_bytes,
            "subscriptions": s.subscriptions.len(), "transports": s.transports.iter().map(|(id, shm)| json!({"id":id,"shm":shm})).collect::<Vec<_>>(),
            "lastError": s.last_error.as_ref().map(|(code, route)| json!({"code":code,"routeId":route})),
            "accepted": stats.accepted.to_string(), "sent": stats.sent.to_string(), "received": stats.received.to_string(),
            "drops": stats.drops.to_string(), "canceled": stats.canceled.to_string(), "failures": stats.failures.to_string(), "resets": stats.resets.to_string(),
            "allocations": stats.allocations.to_string(), "allocationFailures": stats.allocation_failures.to_string(),
            "copies": stats.copies.to_string(), "copyBytes": stats.copy_bytes.to_string(), "shmPublications": stats.shm_publications.to_string(), "networkPublications": stats.network_publications.to_string()
        }).to_string()
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        let core = &self.core;
        let _guard = core.lifecycle.lock().await;
        let session = core.session.lock().unwrap().take();
        let worker = core.worker.lock().unwrap().take();
        let monitor = core.monitor.lock().unwrap().take();
        for task in [&worker, &monitor].into_iter().flatten() {
            task.abort();
        }
        core.shutdown();
        for task in [worker, monitor].into_iter().flatten() {
            let _ = task.await;
        }
        if let Some(session) = session {
            tokio::time::timeout(
                Duration::from_millis(core.config.close_timeout_ms),
                session.close().into_future(),
            )
            .await
            .map_err(|_| Error::new(Status::GenericFailure, "Close timed out"))?
            .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queue_budget_includes_in_flight_work() {
        let budget = Arc::new(Mutex::new(Budget::default()));
        let limits = QueueConfig {
            max_entries: 2,
            max_bytes: 8,
        };
        let first = reserve(&budget, &limits, 8).unwrap();
        assert!(reserve(&budget, &limits, 1).is_none());
        drop(first);
        let empty = reserve(&budget, &limits, 0).unwrap();
        let full = reserve(&budget, &limits, 8).unwrap();
        assert!(reserve(&budget, &limits, 0).is_none());
        drop(empty);
        drop(full);
        assert_eq!(budget.lock().unwrap().bytes, 0);
    }
}
