use serde_json::{json, Value};
use simcontrol::{Client, ErrorKind, RunConfig};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Debug)]
struct Request {
    method: String,
    path: String,
    content_type: Option<String>,
    body: Option<Value>,
}

struct Reply {
    status: u16,
    body: Option<String>,
    body_delay: Duration,
    location: Option<String>,
}

impl Reply {
    fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            body: Some(body.to_string()),
            body_delay: Duration::ZERO,
            location: None,
        }
    }
}

struct Server {
    url: String,
    requests: Arc<Mutex<Vec<Request>>>,
    stopped: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Server {
    fn new(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stopped = Arc::new(AtomicBool::new(false));
        let captured = requests.clone();
        let stop = stopped.clone();
        let worker = thread::spawn(move || {
            let mut replies: VecDeque<_> = replies.into();
            while !stop.load(Ordering::SeqCst) {
                let mut stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    Err(e) => panic!("accept: {e}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                captured.lock().unwrap().push(read_request(&stream));
                let reply = replies
                    .pop_front()
                    .unwrap_or_else(|| Reply::json(500, json!({"error": "Unexpected request"})));
                if let Some(body) = reply.body {
                    let location = reply
                        .location
                        .map_or(String::new(), |url| format!("Location: {url}\r\n"));
                    let _ = write!(stream, "HTTP/1.1 {} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n", reply.status, body.len(), location);
                    thread::sleep(reply.body_delay);
                    let _ = stream.write_all(body.as_bytes());
                }
            }
        });
        Self {
            url,
            requests,
            stopped,
            worker: Some(worker),
        }
    }

    fn close(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !thread::panicking() {
                result.unwrap();
            }
        }
    }

    fn finish(mut self) -> Vec<Request> {
        self.close();
        std::mem::take(&mut *self.requests.lock().unwrap())
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.close();
    }
}

fn read_request(stream: &TcpStream) -> Request {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap().to_owned();
    let path = parts.next().unwrap().to_owned();
    let mut length = 0;
    let mut content_type = None;
    loop {
        line.clear();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" {
            break;
        }
        let (name, value) = line.split_once(':').unwrap();
        match name.to_ascii_lowercase().as_str() {
            "content-length" => length = value.trim().parse().unwrap(),
            "content-type" => content_type = Some(value.trim().to_owned()),
            _ => {}
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    Request {
        method,
        path,
        content_type,
        body: if body.is_empty() {
            None
        } else {
            Some(serde_json::from_slice(&body).unwrap())
        },
    }
}

fn snapshot(run_id: &str, status: &str) -> Value {
    json!({
        "status": status, "runId": run_id, "manifestId": "saved", "manifestRevision": 1,
        "resolvedHash": "hash-1", "step": 42, "timeNs": "9007199254740993123456789",
        "stepNs": "20000000", "transitioning": false, "degraded": false, "error": null,
        "experimentActive": false, "navigationBlocked": false, "runResult": null
    })
}

fn status(browser_id: &str, run_id: &str) -> Value {
    let mut value = snapshot(run_id, "running");
    value.as_object_mut().unwrap().extend(
        json!({
            "browserId": browser_id, "connected": true, "lastSeenAt": "2026-10-29T12:00:00Z",
            "lastInteractionAt": null, "interactionOrder": 1, "commandId": null
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    value
}

fn receipt(action: &str, state: &str, snapshot: Option<Value>) -> Value {
    json!({
        "commandId": format!("cmd-{action}"), "browserId": "tab-a", "action": action,
        "state": state, "createdAt": "2026-10-29T12:00:00Z", "updatedAt": "2026-10-29T12:00:01Z",
        "error": null, "snapshot": snapshot
    })
}

fn complete(action: &str, run_id: &str, state: &str) -> Reply {
    Reply::json(
        202,
        receipt(action, "succeeded", Some(snapshot(run_id, state))),
    )
}

#[test]
fn discovers_tabs_and_encodes_status_and_receipt_ids() {
    let mut tab = status("tab-a", "run-1");
    tab["isDefault"] = json!(true);
    let server = Server::new(vec![
        Reply::json(200, json!({"browserId": "tab-a", "browsers": [tab]})),
        Reply::json(200, status("tab-a", "run-1")),
        Reply::json(200, status("tab/a &雪", "run-1")),
        Reply::json(200, receipt("start", "running", None)),
    ]);
    let client = Client::new(&format!("{}/", server.url)).unwrap();
    let tabs = client.get_tabs().unwrap();
    assert_eq!(tabs.browser_id.as_deref(), Some("tab-a"));
    assert!(tabs.browsers[0].is_default);
    assert!(tabs.browsers[0].status.connected);
    assert_eq!(
        tabs.browsers[0].status.snapshot.time_ns,
        "9007199254740993123456789"
    );
    assert_eq!(client.get_status(None).unwrap().browser_id, "tab-a");
    assert_eq!(
        client.get_status(Some("tab/a &雪")).unwrap().browser_id,
        "tab/a &雪"
    );
    assert_eq!(client.get_command("cmd/a?b").unwrap().state, "running");
    let requests = server.finish();
    assert_eq!(requests.len(), 4);
    assert!(requests
        .iter()
        .all(|r| r.method == "GET" && r.body.is_none()));
    assert_eq!(requests[0].path, "/api/browser-sim/browsers");
    assert_eq!(requests[1].path, "/api/browser-sim/status");
    assert_eq!(
        requests[2].path,
        "/api/browser-sim/status?browserId=tab%2Fa%20%26%E9%9B%AA"
    );
    assert_eq!(requests[3].path, "/api/browser-sim/commands/cmd%2Fa%3Fb");
}

#[test]
fn empty_tab_list_is_valid() {
    let server = Server::new(vec![Reply::json(
        200,
        json!({"browserId": null, "browsers": []}),
    )]);
    let tabs = Client::new(&server.url).unwrap().get_tabs().unwrap();
    assert!(tabs.browser_id.is_none());
    assert!(tabs.browsers.is_empty());
}

#[test]
fn launch_polls_accepted_and_running_until_acknowledgement() {
    let server = Server::new(vec![
        Reply::json(202, receipt("start", "accepted", None)),
        Reply::json(200, receipt("start", "running", None)),
        Reply::json(
            200,
            receipt("start", "succeeded", Some(snapshot("run-1", "running"))),
        ),
    ]);
    let client = Client::new(&server.url).unwrap();
    let run = client.launch(RunConfig::new("saved")).unwrap();
    assert_eq!(run.browser_id(), "tab-a");
    assert_eq!(run.run_id(), "run-1");
    drop(run); // No stop request on drop.
    let requests = server.finish();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].path, "/api/browser-sim/commands");
    assert_eq!(
        requests[0]
            .content_type
            .as_deref()
            .and_then(|value| value.split(';').next()),
        Some("application/json")
    );
    assert_eq!(
        requests[0].body,
        Some(json!({"action": "start", "manifestId": "saved", "autoplay": true}))
    );
    assert!(requests[1..]
        .iter()
        .all(|r| r.method == "GET" && r.path == "/api/browser-sim/commands/cmd-start"));
}

#[test]
fn lifecycle_stays_on_its_tab_and_reset_updates_the_run_id() {
    let mut stopped = snapshot("run-2", "failed");
    stopped["runResult"] = json!({
        "runId": "run-2", "status": "failed", "completed": true, "passed": false,
        "logId": "log-1", "terminationReason": "assertion-failed", "step": 42,
        "timeNs": "9007199254740993123456789"
    });
    let server = Server::new(vec![
        complete("start", "run-1", "ready"),
        Reply::json(200, json!({"browserId": "tab-b", "browsers": []})),
        Reply::json(200, status("tab-a", "run-1")),
        complete("pause", "run-1", "paused"),
        complete("resume", "run-1", "running"),
        complete("reset", "run-2", "ready"),
        Reply::json(202, receipt("stop", "succeeded", Some(stopped))),
    ]);
    let client = Client::new(&server.url).unwrap();
    let mut config = RunConfig::new("saved");
    config.browser_id = Some("tab-a".into());
    config.autoplay = false;
    let mut run = client.launch(config).unwrap();
    assert_eq!(
        client.get_tabs().unwrap().browser_id.as_deref(),
        Some("tab-b")
    );
    assert_eq!(run.status().unwrap().browser_id, "tab-a");
    assert_eq!(run.pause().unwrap().status, "paused");
    assert_eq!(run.resume().unwrap().status, "running");
    assert_eq!(run.reset().unwrap().status, "ready");
    assert_eq!(run.run_id(), "run-2");
    let result = run.stop().unwrap().run_result.unwrap();
    assert!(!result.passed);
    assert_eq!(result.time_ns, "9007199254740993123456789");
    let requests = server.finish();
    assert_eq!(requests.len(), 7);
    assert_eq!(
        requests[0].body,
        Some(
            json!({"action": "start", "manifestId": "saved", "browserId": "tab-a", "autoplay": false})
        )
    );
    assert_eq!(requests[2].path, "/api/browser-sim/status?browserId=tab-a");
    for (request, action) in requests[3..]
        .iter()
        .zip(["pause", "resume", "reset", "stop"])
    {
        let run_id = if action == "stop" { "run-2" } else { "run-1" };
        assert_eq!(
            request.body,
            Some(json!({"action": action, "browserId": "tab-a", "runId": run_id}))
        );
    }
}

#[test]
fn replacement_run_and_failed_reset_leave_the_handle_unchanged() {
    let mut failed = receipt("reset", "failed", None);
    failed["error"] = json!({"code": "MANIFEST_NOT_FOUND", "message": "Missing manifest"});
    let server = Server::new(vec![
        complete("start", "run-1", "ready"),
        Reply::json(200, status("tab-a", "replacement")),
        Reply::json(202, failed),
        Reply::json(
            409,
            json!({"code": "RUN_ID_MISMATCH", "error": "Stale run"}),
        ),
    ]);
    let mut run = Client::new(&server.url)
        .unwrap()
        .launch(RunConfig::new("saved"))
        .unwrap();
    let error = run.status().unwrap_err();
    assert_eq!(error.kind, ErrorKind::RunReplaced);
    assert_eq!(error.code.as_deref(), Some("RUN_ID_MISMATCH"));
    let error = run.reset().unwrap_err();
    assert_eq!(error.kind, ErrorKind::CommandFailed);
    assert_eq!(error.code.as_deref(), Some("MANIFEST_NOT_FOUND"));
    assert_eq!(error.command_id.as_deref(), Some("cmd-reset"));
    assert_eq!(run.run_id(), "run-1");
    let error = run.stop().unwrap_err();
    assert_eq!(error.status, Some(409));
    assert_eq!(error.code.as_deref(), Some("RUN_ID_MISMATCH"));
    assert_eq!(server.finish()[3].body.as_ref().unwrap()["runId"], "run-1");
}

#[test]
fn failed_and_unknown_receipts_preserve_error_details_without_resubmission() {
    for (state, kind) in [
        ("failed", ErrorKind::CommandFailed),
        ("unknown", ErrorKind::UnknownOutcome),
    ] {
        let mut terminal = receipt("start", state, None);
        terminal["error"] = json!({"code": "BROWSER_UNAVAILABLE", "message": "Tab disconnected"});
        let server = Server::new(vec![
            Reply::json(202, receipt("start", "accepted", None)),
            Reply::json(200, terminal),
        ]);
        let error = Client::new(&server.url)
            .unwrap()
            .launch(RunConfig::new("saved"))
            .unwrap_err();
        assert_eq!(error.kind, kind);
        assert_eq!(error.message, "Tab disconnected");
        assert_eq!(error.code.as_deref(), Some("BROWSER_UNAVAILABLE"));
        assert_eq!(error.command_id.as_deref(), Some("cmd-start"));
        assert_eq!(error.browser_id.as_deref(), Some("tab-a"));
        let requests = server.finish();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests.iter().filter(|r| r.method == "POST").count(), 1);
    }
}

#[test]
fn polling_http_error_keeps_the_accepted_receipt_ids() {
    let server = Server::new(vec![
        Reply::json(202, receipt("start", "accepted", None)),
        Reply::json(
            404,
            json!({"code": "COMMAND_NOT_FOUND", "error": "Receipt expired"}),
        ),
    ]);
    let error = Client::new(&server.url)
        .unwrap()
        .launch(RunConfig::new("saved"))
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Http);
    assert_eq!(error.status, Some(404));
    assert_eq!(error.code.as_deref(), Some("COMMAND_NOT_FOUND"));
    assert_eq!(error.command_id.as_deref(), Some("cmd-start"));
    assert_eq!(error.browser_id.as_deref(), Some("tab-a"));
}

#[test]
fn deadline_expires_without_reposting_or_polling_after_the_deadline() {
    let server = Server::new(vec![Reply::json(202, receipt("start", "accepted", None))]);
    let client = Client::with_timeout(&server.url, Duration::from_millis(50)).unwrap();
    let started = Instant::now();
    let error = client.launch(RunConfig::new("saved")).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Timeout);
    assert_eq!(error.command_id.as_deref(), Some("cmd-start"));
    assert_eq!(error.browser_id.as_deref(), Some("tab-a"));
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(server.finish().len(), 1);
}

#[test]
fn http_deadline_includes_reading_the_response_body() {
    let mut reply = complete("start", "run-1", "running");
    reply.body_delay = Duration::from_millis(300);
    let server = Server::new(vec![reply]);
    let client = Client::with_timeout(&server.url, Duration::from_millis(50)).unwrap();
    let mut config = RunConfig::new("saved");
    config.browser_id = Some("tab-a".into());
    let started = Instant::now();
    let error = client.launch(config).unwrap_err();
    assert!(started.elapsed() < Duration::from_millis(250));
    assert_eq!(error.kind, ErrorKind::Timeout);
    assert_eq!(error.browser_id.as_deref(), Some("tab-a"));
    assert_eq!(server.finish().len(), 1);
}

#[test]
fn lost_submission_response_is_never_retried() {
    let server = Server::new(vec![Reply {
        status: 202,
        body: None,
        body_delay: Duration::ZERO,
        location: None,
    }]);
    let mut config = RunConfig::new("saved");
    config.browser_id = Some("tab-a".into());
    let error = Client::new(&server.url)
        .unwrap()
        .launch(config)
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Transport);
    assert_eq!(error.browser_id.as_deref(), Some("tab-a"));
    assert!(error.command_id.is_none());
    assert_eq!(server.finish().len(), 1);
}

#[test]
fn redirects_are_reported_without_following_or_resubmission() {
    let mut reply = Reply::json(307, json!({"error": "Moved"}));
    reply.location = Some("/api/browser-sim/commands".into());
    let server = Server::new(vec![reply]);
    let error = Client::new(&server.url)
        .unwrap()
        .launch(RunConfig::new("saved"))
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Http);
    assert_eq!(error.status, Some(307));
    assert_eq!(server.finish().len(), 1);
}

#[test]
fn malformed_or_mismatched_completions_never_produce_a_handle() {
    let mut bad_browser = receipt("start", "succeeded", Some(snapshot("run-1", "running")));
    bad_browser["browserId"] = json!("wrong-tab");
    let mut bad_type = receipt("start", "succeeded", Some(snapshot("run-1", "running")));
    bad_type["snapshot"]["timeNs"] = json!(42);
    let mut bad_run = receipt("start", "succeeded", Some(snapshot("run-1", "running")));
    bad_run["snapshot"]["runId"] = Value::Null;
    for response in [
        bad_browser,
        bad_type,
        bad_run,
        receipt("stop", "accepted", None),
        receipt("start", "unexpected", None),
        receipt("start", "succeeded", None),
    ] {
        let expected_command_id = response["commandId"].as_str().unwrap().to_owned();
        let server = Server::new(vec![Reply::json(202, response)]);
        let mut config = RunConfig::new("saved");
        config.browser_id = Some("tab-a".into());
        let error = Client::new(&server.url)
            .unwrap()
            .launch(config)
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidResponse);
        assert_eq!(
            error.command_id.as_deref(),
            Some(expected_command_id.as_str())
        );
        assert_eq!(error.browser_id.as_deref(), Some("tab-a"));
        assert_eq!(server.finish().len(), 1);
    }
}

#[test]
fn receipt_target_cannot_change_while_polling() {
    for field in ["browserId", "commandId", "action"] {
        let mut changed = receipt("start", "succeeded", Some(snapshot("run-1", "running")));
        changed[field] = json!("replacement");
        let server = Server::new(vec![
            Reply::json(202, receipt("start", "accepted", None)),
            Reply::json(200, changed),
        ]);
        let error = Client::new(&server.url)
            .unwrap()
            .launch(RunConfig::new("saved"))
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidResponse);
        assert_eq!(error.command_id.as_deref(), Some("cmd-start"));
        assert_eq!(error.browser_id.as_deref(), Some("tab-a"));
    }
}

#[test]
fn malformed_json_and_non_json_http_errors_are_reported() {
    for (status, kind) in [(200, ErrorKind::InvalidResponse), (502, ErrorKind::Http)] {
        let server = Server::new(vec![Reply {
            status,
            body: Some("upstream failure".into()),
            body_delay: Duration::ZERO,
            location: None,
        }]);
        let error = Client::new(&server.url).unwrap().get_tabs().unwrap_err();
        assert_eq!(error.kind, kind);
        if status == 502 {
            assert_eq!(error.status, Some(502));
            assert_eq!(error.message, "upstream failure");
        }
    }
}

#[test]
fn invalid_origins_and_zero_timeout_are_rejected_before_http() {
    for origin in [
        "localhost:3000",
        "ftp://localhost",
        "http://localhost/path",
        "http://localhost?x=1",
        "http://localhost/#fragment",
        "http://user@localhost",
        "",
    ] {
        assert_eq!(
            Client::new(origin).unwrap_err().kind,
            ErrorKind::InvalidInput,
            "{origin}"
        );
    }
    assert_eq!(
        Client::with_timeout("http://127.0.0.1:3000", Duration::ZERO)
            .unwrap_err()
            .kind,
        ErrorKind::InvalidInput
    );
    assert!(Client::new("https://localhost:3000/").is_ok());
    assert!(Client::new("http://[::1]:3000").is_ok());
}
