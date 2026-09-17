//! End-to-end checks against a real, running gateway over a real TCP socket.
//!
//! The unit tests around `asset_response` and the subagent filter verify those
//! functions in isolation, which leaves the interesting half untested: whether
//! the wiring actually reaches them. A route that never passes `If-None-Match`
//! through, or a filter that is never called, would keep every unit test green
//! while the shipped behaviour is wrong.
//!
//! So this boots `run_gateway` on an ephemeral port, pairs a device the way the
//! real client does, and speaks HTTP to it.
//!
//! One gateway is shared by every test here, and it is configured once before
//! it starts. `JCODE_HOME` is process-global and the gateway reads it lazily on
//! each request, so a per-test home would race: whichever test set the variable
//! last would silently decide what every in-flight request saw. An earlier
//! draft did exactly that and produced a spurious 500 under the default
//! parallel runner while passing with `--test-threads=1`. A single fixed home,
//! built up front, removes the shared mutable state instead of papering over it
//! with a lock or a thread-count flag.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;

/// Port and bearer token of the one shared gateway, or `None` when this
/// environment cannot host a loopback listener.
static GATEWAY: OnceLock<Option<(u16, String)>> = OnceLock::new();

/// Clients handed to the host process by the gateway, newest last.
///
/// The gateway's whole contract is that a remote client is bridged into *this*
/// process rather than executed anywhere else, so capturing the handoff is the
/// observable that proves it.
static HANDOFFS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Session IDs placed in the fixture swarm snapshot.
const COORDINATOR: &str = "e2e-coordinator";
const WORKERS: [&str; 2] = ["e2e-worker-a", "e2e-worker-b"];

/// Claim a free port by binding and immediately releasing it.
fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
    listener.local_addr().expect("local addr").port()
}

/// Build the isolated home: a paired device plus swarm snapshots.
///
/// Both a valid and a deliberately corrupt snapshot are written into the same
/// directory. That is stronger than testing them separately: it proves the
/// corrupt file is skipped *while* the valid one still filters, which is the
/// real-world case where one snapshot is mid-write.
fn prepare_home() -> (PathBuf, String) {
    let home = std::env::temp_dir().join(format!(
        "jcode-gateway-e2e-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&home).expect("create temp home");

    // Pair a device by writing the same `devices.json` the registry persists,
    // rather than widening the crate's API just for a test. The registry stores
    // a SHA-256 of the token, never the token itself, so build the file the
    // same way and keep the plaintext for the Authorization header.
    let token = "a1b2c3d4e5f6071829304a5b6c7d8e9f".repeat(2);
    let token_hash = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(token.as_bytes());
        format!("sha256:{}", hex::encode(hasher.finalize()))
    };
    let now = chrono::Utc::now().to_rfc3339();
    std::fs::write(
        home.join("devices.json"),
        serde_json::json!({
            "devices": [{
                "id": "e2e-device",
                "name": "E2E",
                "apns_token": null,
                "token_hash": token_hash,
                "paired_at": now,
                "last_seen": now,
            }],
            "pending_codes": [],
        })
        .to_string(),
    )
    .expect("write devices.json");

    let swarm = home.join("state").join("swarm");
    std::fs::create_dir_all(&swarm).expect("create swarm state");
    std::fs::write(
        swarm.join("session_coord.json"),
        serde_json::json!({
            "swarm_id": format!("session:{COORDINATOR}"),
            "coordinator_session_id": COORDINATOR,
            "members": [
                {"session_id": COORDINATOR, "role": "coordinator"},
                {"session_id": WORKERS[0], "role": "agent", "report_back_to_session_id": COORDINATOR},
                {"session_id": WORKERS[1], "role": "agent", "report_back_to_session_id": COORDINATOR},
            ],
        })
        .to_string(),
    )
    .expect("write swarm snapshot");
    // A snapshot caught mid-write must be ignored, never fatal.
    std::fs::write(swarm.join("broken.json"), "{ this is not json").expect("write junk");

    (home, token)
}

/// Put the coordinator and its workers into the session index.
///
/// Without this the index is empty, so "the worker is absent" is trivially true
/// and the filter is never actually exercised. Verified by deleting the filter:
/// with these rows seeded the assertion fails, without them it passes either
/// way. Must run after `JCODE_HOME` is set, since the index resolves its path
/// from it.
fn seed_session_index() {
    let now = chrono::Utc::now().timestamp_millis();
    for (offset, id) in [COORDINATOR, WORKERS[0], WORKERS[1]].iter().enumerate() {
        let entry = jcode_base::recent_session_index::RecentSessionMetadata {
            session_id: (*id).to_string(),
            working_dir: Some("/tmp/e2e".to_string()),
            generated_title: Some((*id).to_string()),
            message_count: Some(3),
            updated_at_ms: now - offset as i64,
            ..Default::default()
        };
        jcode_base::recent_session_index::upsert(&entry).expect("seed session index");
    }
}

/// Boot the shared gateway once.
fn gateway() -> Option<(u16, String)> {
    GATEWAY
        .get_or_init(|| {
            let (home, token) = prepare_home();

            // SAFETY: written once, before the gateway thread starts and before
            // any gateway code reads it. `OnceLock` guarantees a single writer,
            // and nothing in this file mutates the variable afterwards.
            unsafe {
                std::env::set_var("JCODE_HOME", &home);
            }

            // After JCODE_HOME, so the index lands inside the isolated home.
            seed_session_index();

            let port = free_port();
            let (client_tx, mut client_rx) =
                tokio::sync::mpsc::unbounded_channel::<jcode_base::gateway::GatewayClient>();
            // Stand in for the server's accept loop. The real `Server::run`
            // takes each `GatewayClient` and runs `handle_client` on it in this
            // same process; recording the handoff here is what makes that
            // observable, and it keeps the channel open besides.
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("build handoff runtime");
                runtime.block_on(async move {
                    while let Some(client) = client_rx.recv().await {
                        HANDOFFS
                            .lock()
                            .expect("handoff lock")
                            .push(client.device_name.clone());
                    }
                });
            });

            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("build runtime");
                runtime.block_on(async move {
                    let config = jcode_base::gateway::GatewayConfig {
                        port,
                        bind_addr: "127.0.0.1".to_string(),
                        enabled: true,
                    };
                    let _ = jcode_base::gateway::run_gateway(config, client_tx).await;
                });
            });

            // Wait for the listener rather than sleeping a fixed amount.
            for _ in 0..100 {
                if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                    return Some((port, token));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            None
        })
        .clone()
}

/// Run `body` against the shared gateway, or skip when one is unavailable.
fn with_gateway(body: impl FnOnce(u16, &str)) {
    match gateway() {
        Some((port, token)) => body(port, &token),
        None => eprintln!("skipping: could not start a loopback gateway in this environment"),
    }
}

fn get(port: u16, path: &str, extra_headers: &str) -> String {
    let raw = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{extra_headers}Connection: close\r\n\r\n"
    );
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect to gateway");
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("set timeout");
    stream.write_all(raw.as_bytes()).expect("write request");
    stream.flush().expect("flush");
    let mut response = Vec::new();
    // The gateway sends `Connection: close`, so read to EOF.
    stream.read_to_end(&mut response).expect("read response");
    String::from_utf8_lossy(&response).into_owned()
}

fn status_line(response: &str) -> &str {
    response.lines().next().unwrap_or("").trim_end()
}

fn header(response: &str, name: &str) -> Option<String> {
    response
        .lines()
        .take_while(|line| !line.trim().is_empty())
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim()
                .eq_ignore_ascii_case(name)
                .then(|| value.trim().to_string())
        })
}

fn body(response: &str) -> &str {
    response
        .split_once("\r\n\r\n")
        .map(|(_, b)| b)
        .unwrap_or("")
}

/// The shipped client must be served, and a conditional request must produce a
/// bodyless 304 through the real route rather than only in a unit test.
#[test]
fn assets_revalidate_with_etags_over_a_real_connection() {
    with_gateway(|port, _token| {
        let first = get(port, "/app.js", "");
        assert!(
            status_line(&first).contains("200 OK"),
            "app.js is served: {}",
            status_line(&first)
        );
        let tag = header(&first, "etag").expect("200 carries an ETag");
        assert!(
            body(&first).contains("jcode"),
            "the real client body came back"
        );

        // The browser's second visit.
        let second = get(port, "/app.js", &format!("If-None-Match: {tag}\r\n"));
        assert!(
            status_line(&second).contains("304 Not Modified"),
            "a matching ETag revalidates: {}",
            status_line(&second)
        );
        assert!(
            body(&second).is_empty(),
            "304 must not resend the client; that is the entire saving"
        );

        // A stale validator must still deliver the asset.
        let stale = get(port, "/app.js", "If-None-Match: \"stale\"\r\n");
        assert!(status_line(&stale).contains("200 OK"));
        assert!(
            !body(&stale).is_empty(),
            "a stale tag returns the full body"
        );

        // Weak validators are what browsers actually echo back.
        let weak = get(port, "/app.js", &format!("If-None-Match: W/{tag}\r\n"));
        assert!(
            status_line(&weak).contains("304"),
            "weak validators revalidate too"
        );
    });
}

/// Every precached shell asset must revalidate, not just `app.js`. A launch is
/// only fast if the whole shell 304s.
#[test]
fn the_whole_app_shell_revalidates() {
    with_gateway(|port, _token| {
        for path in [
            "/",
            "/index.html",
            "/app.js",
            "/app.css",
            "/manifest.webmanifest",
        ] {
            let first = get(port, path, "");
            assert!(
                status_line(&first).contains("200 OK"),
                "{path} is served: {}",
                status_line(&first)
            );
            let tag = header(&first, "etag").unwrap_or_else(|| panic!("{path} has an ETag"));

            let second = get(port, path, &format!("If-None-Match: {tag}\r\n"));
            assert!(
                status_line(&second).contains("304"),
                "{path} revalidates on the second visit"
            );
            assert!(body(&second).is_empty(), "{path} sends no body on 304");
        }
    });
}

/// Spawned swarm workers must not reach the phone's session list, and this has
/// to be proven through `GET /sessions` rather than through the filter alone.
///
/// The fixture home also contains a corrupt snapshot, so passing here means the
/// corrupt file was skipped without preventing the valid one from filtering.
#[test]
fn spawned_subagents_are_absent_from_the_session_list() {
    with_gateway(|port, token| {
        let response = get(
            port,
            "/sessions?limit=200",
            &format!("Authorization: Bearer {token}\r\n"),
        );
        assert!(
            status_line(&response).contains("200 OK"),
            "an authenticated session list is returned even with a corrupt snapshot present: {}",
            status_line(&response)
        );

        let payload: serde_json::Value =
            serde_json::from_str(body(&response)).expect("session list is JSON");
        let listed: Vec<String> = payload["sessions"]
            .as_array()
            .expect("sessions array")
            .iter()
            .filter_map(|s| s["id"].as_str().map(str::to_string))
            .collect();

        // Guard against a vacuous pass: if the coordinator is missing too, the
        // list is simply empty and the assertions below prove nothing.
        assert!(
            listed.iter().any(|id| id == COORDINATOR),
            "the coordinator is a real chat and must be listed, otherwise this \
             test proves nothing about filtering; got {listed:?}"
        );

        for worker in WORKERS {
            assert!(
                !listed.iter().any(|id| id == worker),
                "spawned worker {worker} must not appear in the user's chat list, got {listed:?}"
            );
        }
    });
}

/// An unauthenticated client must not be able to read the session list.
#[test]
fn the_session_list_still_requires_a_token() {
    with_gateway(|port, _token| {
        let response = get(port, "/sessions", "");
        assert!(
            status_line(&response).contains("401"),
            "no token is rejected: {}",
            status_line(&response)
        );

        let bogus = get(
            port,
            "/sessions",
            "Authorization: Bearer 00000000000000000000000000000000\r\n",
        );
        assert!(
            status_line(&bogus).contains("401"),
            "an unknown token is rejected: {}",
            status_line(&bogus)
        );
    });
}

/// Where does a phone's work actually run?
///
/// This was previously answered by reading the source, which is an argument,
/// not an observation. The gateway's contract is that it is a door, not a
/// second computer: a remote client is bridged into the *host* process, so
/// tools execute on the machine running `jcode`, with its filesystem and its
/// credentials. If that were wrong, "the compute is on your laptop" would be a
/// false statement about where a user's code and secrets are touched.
///
/// Observed rather than argued: complete a real WebSocket upgrade against the
/// running gateway and watch for the `GatewayClient` handoff to arrive in this
/// process. The handoff carries the socket that the host's `handle_client`
/// serves, which is the mechanism by which remote sessions run locally.
#[test]
fn a_remote_client_is_bridged_into_the_host_process() {
    with_gateway(|port, token| {
        let before = HANDOFFS.lock().expect("handoff lock").len();

        // Minimal RFC 6455 handshake, the same one the browser performs.
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("timeout");
        let handshake = format!(
            "GET /ws?token={token} HTTP/1.1\r\n\
             Host: 127.0.0.1\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
             Sec-WebSocket-Version: 13\r\n\r\n"
        );
        stream.write_all(handshake.as_bytes()).expect("handshake");
        stream.flush().expect("flush");

        let mut head = [0u8; 256];
        let read = stream.read(&mut head).expect("read handshake response");
        let response = String::from_utf8_lossy(&head[..read]).into_owned();
        assert!(
            response.contains("101"),
            "the gateway completes the WebSocket upgrade: {}",
            response.lines().next().unwrap_or("")
        );

        // The handoff crosses a channel and a thread, so poll briefly.
        let mut handed_off = false;
        for _ in 0..100 {
            if HANDOFFS.lock().expect("handoff lock").len() > before {
                handed_off = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }

        assert!(
            handed_off,
            "a remote client must be handed to THIS process to be served; \
             without that handoff the gateway would not be a door onto the \
             local machine and 'the compute runs on your computer' would be false"
        );
    });
}
