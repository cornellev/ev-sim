//! Blocking control of an already-open ev-sim browser tab.
//!
//! Start the simulator server and open its page before using this client.
//! Lifecycle methods wait for browser acknowledgement. Dropping a [`Run`]
//! does not stop it, and a timeout does not cancel a command.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    fmt, thread,
    time::{Duration, Instant},
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

pub type Result<T> = std::result::Result<T, Error>;

/// Options for starting a saved run manifest.
#[derive(Debug, Clone)]
pub struct RunConfig {
    pub manifest_id: String,
    /// Omit to use the server's most recently interacted-with connected tab.
    pub browser_id: Option<String>,
    pub autoplay: bool,
}

impl RunConfig {
    pub fn new(manifest_id: impl Into<String>) -> Self {
        Self {
            manifest_id: manifest_id.into(),
            browser_id: None,
            autoplay: true,
        }
    }
}

/// The simulation state acknowledged by the browser. Clock values stay strings.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub status: String,
    pub run_id: Option<String>,
    pub manifest_id: Option<String>,
    pub manifest_revision: Option<u64>,
    pub resolved_hash: Option<String>,
    pub step: u64,
    pub time_ns: String,
    pub step_ns: String,
    pub transitioning: bool,
    pub degraded: bool,
    pub error: Option<String>,
    pub experiment_active: bool,
    pub navigation_blocked: bool,
    pub run_result: Option<RunResult>,
}

/// Simulation success is independent of whether its lifecycle command succeeded.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub run_id: Option<String>,
    pub status: String,
    pub completed: bool,
    pub passed: bool,
    pub log_id: Option<String>,
    pub termination_reason: Option<String>,
    pub step: u64,
    pub time_ns: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub browser_id: String,
    pub connected: bool,
    pub last_seen_at: String,
    pub last_interaction_at: Option<String>,
    pub interaction_order: u64,
    pub command_id: Option<String>,
    #[serde(flatten)]
    pub snapshot: Snapshot,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub is_default: bool,
    #[serde(flatten)]
    pub status: Status,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tabs {
    /// The server's current default tab, if any.
    pub browser_id: Option<String>,
    pub browsers: Vec<Tab>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandReceipt {
    pub command_id: String,
    pub browser_id: String,
    pub action: String,
    pub state: String,
    pub created_at: String,
    pub updated_at: String,
    pub error: Option<CommandError>,
    pub snapshot: Option<Snapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ErrorKind {
    InvalidInput,
    Http,
    Transport,
    InvalidResponse,
    CommandFailed,
    UnknownOutcome,
    Timeout,
    RunReplaced,
}

/// Errors retain receipt IDs when known, for inspection through `get_command`.
#[derive(Debug)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
    pub status: Option<u16>,
    pub code: Option<String>,
    pub command_id: Option<String>,
    pub browser_id: Option<String>,
}

impl Error {
    fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            status: None,
            code: None,
            command_id: None,
            browser_id: None,
        }
    }

    fn context(mut self, command_id: Option<&str>, browser_id: Option<&str>) -> Self {
        if let Some(id) = command_id {
            self.command_id = Some(id.into());
        }
        if let Some(id) = browser_id {
            self.browser_id = Some(id.into());
        }
        self
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(code) = &self.code {
            write!(f, "{code}: ")?;
        }
        write!(f, "{}", self.message)?;
        if let Some(id) = &self.command_id {
            write!(f, " (command {id})")?;
        }
        Ok(())
    }
}

impl std::error::Error for Error {}

/// A reusable blocking HTTP client. Clones share the HTTP connection pool.
#[derive(Debug, Clone)]
pub struct Client {
    base_url: String,
    agent: ureq::Agent,
    timeout: Duration,
}

impl Client {
    /// Connect to a server origin, for example `http://127.0.0.1:3000`.
    /// Construction validates the origin without making an HTTP request.
    pub fn new(base_url: &str) -> Result<Self> {
        Self::with_timeout(base_url, COMMAND_TIMEOUT)
    }

    /// Set the total deadline for each lifecycle call, including submission.
    pub fn with_timeout(base_url: &str, timeout: Duration) -> Result<Self> {
        let invalid = || {
            Error::new(
                ErrorKind::InvalidInput,
                "Expected an http(s) server origin and a positive timeout.",
            )
        };
        let uri: ureq::http::Uri = base_url.parse().map_err(|_| invalid())?;
        if !matches!(uri.scheme_str(), Some("http" | "https"))
            || uri.authority().is_none()
            || uri.authority().is_some_and(|a| a.as_str().contains('@'))
            || !matches!(uri.path(), "" | "/")
            || uri.query().is_some()
            || base_url.contains('#')
            || timeout.is_zero()
        {
            return Err(invalid());
        }
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            // Never redirect or replay a lifecycle submission.
            .max_redirects(0)
            .build()
            .into();
        Ok(Self {
            base_url: format!("{}/api/browser-sim", base_url.trim_end_matches('/')),
            agent,
            timeout,
        })
    }

    pub fn get_tabs(&self) -> Result<Tabs> {
        self.request("/browsers", None, HTTP_TIMEOUT)
    }

    pub fn get_status(&self, browser_id: Option<&str>) -> Result<Status> {
        let path = browser_id.map_or_else(
            || "/status".into(),
            |id| format!("/status?browserId={}", encode(id)),
        );
        self.request(&path, None, HTTP_TIMEOUT)
            .map_err(|e| e.context(None, browser_id))
    }

    pub fn get_command(&self, command_id: &str) -> Result<CommandReceipt> {
        self.request(
            &format!("/commands/{}", encode(command_id)),
            None,
            HTTP_TIMEOUT,
        )
        .map_err(|e| e.context(Some(command_id), None))
    }

    /// Start a saved manifest and wait for acknowledgement, not episode completion.
    pub fn launch(&self, config: RunConfig) -> Result<Run> {
        let command = Command {
            action: "start",
            browser_id: config.browser_id.as_deref(),
            manifest_id: Some(&config.manifest_id),
            run_id: None,
            autoplay: Some(config.autoplay),
        };
        let (browser_id, run_id, _) = self.execute(&command)?;
        Ok(Run {
            client: self.clone(),
            browser_id,
            run_id,
        })
    }

    fn request<T: DeserializeOwned>(
        &self,
        path: &str,
        command: Option<&Command<'_>>,
        timeout: Duration,
    ) -> Result<T> {
        let url = format!("{}{path}", self.base_url);
        let response = match command {
            Some(command) => self
                .agent
                .post(&url)
                .config()
                .timeout_global(Some(timeout))
                .build()
                .send_json(command),
            None => self
                .agent
                .get(&url)
                .config()
                .timeout_global(Some(timeout))
                .build()
                .call(),
        };
        let mut response = response.map_err(transport_error)?;
        let status = response.status().as_u16();
        let body = response.body_mut().read_to_string().map_err(|e| {
            let mut error = transport_error(e);
            error.status = Some(status);
            error
        })?;
        let json = serde_json::from_str::<serde_json::Value>(&body);
        if !(200..300).contains(&status) {
            let mut error = Error::new(ErrorKind::Http, &body);
            error.status = Some(status);
            if let Ok(json) = json {
                error.code = json["code"].as_str().map(String::from);
                if let Some(message) = json["error"].as_str() {
                    error.message = message.into();
                }
            }
            return Err(error);
        }
        let json = json.map_err(|e| {
            let mut error = Error::new(ErrorKind::InvalidResponse, e.to_string());
            error.status = Some(status);
            error
        })?;
        let command_id = json["commandId"].as_str().map(String::from);
        let browser_id = json["browserId"].as_str().map(String::from);
        serde_json::from_value(json).map_err(|e| {
            let mut error = Error::new(ErrorKind::InvalidResponse, e.to_string())
                .context(command_id.as_deref(), browser_id.as_deref());
            error.status = Some(status);
            error
        })
    }

    fn execute(&self, command: &Command<'_>) -> Result<(String, String, Snapshot)> {
        let started = Instant::now();
        let mut receipt: CommandReceipt = self
            .request("/commands", Some(command), self.timeout.min(HTTP_TIMEOUT))
            .map_err(|e| e.context(None, command.browser_id))?;
        let command_id = receipt.command_id.clone();
        let browser_id = receipt.browser_id.clone();
        let context =
            |e: Error| e.context(Some(&command_id), command.browser_id.or(Some(&browser_id)));
        let invalid = |message: &str| context(Error::new(ErrorKind::InvalidResponse, message));
        loop {
            if command_id.is_empty()
                || browser_id.is_empty()
                || receipt.command_id != command_id
                || receipt.browser_id != browser_id
                || command.browser_id.is_some_and(|id| id != browser_id)
                || receipt.action != command.action
            {
                return Err(invalid(
                    "Receipt does not match the submitted command or browser.",
                ));
            }
            match receipt.state.as_str() {
                "succeeded" => {
                    if receipt.error.is_some() {
                        return Err(invalid("Succeeded receipt contains a command error."));
                    }
                    let snapshot = receipt
                        .snapshot
                        .ok_or_else(|| invalid("Succeeded receipt has no snapshot."))?;
                    let run_id = snapshot
                        .run_id
                        .as_deref()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(|| invalid("Succeeded receipt has no run ID."))?
                        .to_owned();
                    if !matches!(command.action, "start" | "reset")
                        && command.run_id != Some(&run_id)
                    {
                        return Err(invalid("Completion snapshot belongs to a different run."));
                    }
                    return Ok((browser_id, run_id, snapshot));
                }
                "failed" | "unknown" => {
                    let kind = if receipt.state == "unknown" {
                        ErrorKind::UnknownOutcome
                    } else {
                        ErrorKind::CommandFailed
                    };
                    let mut error =
                        context(Error::new(kind, format!("Command {}.", receipt.state)));
                    if let Some(detail) = receipt.error {
                        error.code = Some(detail.code);
                        error.message = detail.message;
                    }
                    return Err(error);
                }
                "accepted" | "running" => {}
                _ => return Err(invalid("Unrecognized command receipt state.")),
            }
            let remaining = self.timeout.saturating_sub(started.elapsed());
            thread::sleep(POLL_INTERVAL.min(remaining));
            let remaining = self.timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Err(context(Error::new(
                    ErrorKind::Timeout,
                    "Command deadline elapsed; execution may still be in progress.",
                )));
            }
            receipt = self
                .request(
                    &format!("/commands/{}", encode(&command_id)),
                    None,
                    remaining.min(HTTP_TIMEOUT),
                )
                .map_err(context)?;
        }
    }
}

/// One run in one browser tab. Dropping the handle leaves the simulation running.
#[derive(Debug)]
pub struct Run {
    client: Client,
    browser_id: String,
    run_id: String,
}

impl Run {
    pub fn browser_id(&self) -> &str {
        &self.browser_id
    }
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn status(&self) -> Result<Status> {
        let status = self.client.get_status(Some(&self.browser_id))?;
        if status.browser_id != self.browser_id
            || status.snapshot.run_id.as_deref() != Some(&self.run_id)
        {
            let mut error = Error::new(
                ErrorKind::RunReplaced,
                "This handle's run is no longer current in its tab.",
            )
            .context(None, Some(&self.browser_id));
            error.code = Some("RUN_ID_MISMATCH".into());
            return Err(error);
        }
        Ok(status)
    }

    pub fn pause(&mut self) -> Result<Snapshot> {
        self.command("pause")
    }
    pub fn resume(&mut self) -> Result<Snapshot> {
        self.command("resume")
    }
    pub fn stop(&mut self) -> Result<Snapshot> {
        self.command("stop")
    }

    /// Prepare the latest saved manifest revision without autoplay, updating the run ID.
    pub fn reset(&mut self) -> Result<Snapshot> {
        self.command("reset")
    }

    fn command(&mut self, action: &'static str) -> Result<Snapshot> {
        let command = Command {
            action,
            browser_id: Some(&self.browser_id),
            run_id: Some(&self.run_id),
            manifest_id: None,
            autoplay: None,
        };
        let (_, run_id, snapshot) = self.client.execute(&command)?;
        self.run_id = run_id;
        Ok(snapshot)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Command<'a> {
    action: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    browser_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    autoplay: Option<bool>,
}

fn transport_error(error: ureq::Error) -> Error {
    let kind = if matches!(error, ureq::Error::Timeout(_)) {
        ErrorKind::Timeout
    } else {
        ErrorKind::Transport
    };
    Error::new(kind, error.to_string())
}

fn encode(value: &str) -> String {
    let mut encoded = String::new();
    const HEX: &[u8] = b"0123456789ABCDEF";
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 15) as usize] as char);
        }
    }
    encoded
}
