use super::*;
use tokio_tungstenite::tungstenite::handshake::server::Request;

/// Redirect `JCODE_HOME` at a throwaway directory for the duration of a test.
///
/// `DeviceRegistry::pair_device` and `generate_pairing_code` call `save()`,
/// which writes `~/.jcode/devices.json` even when the registry was built with
/// `DeviceRegistry::default()`. Without this, running the test suite wrote a
/// paired device named "iPhone" into the developer's *real* registry, granting
/// a fabricated credential access to their live gateway. Observed on a real
/// machine, not hypothetical.
///
/// The returned guard holds the shared test-env lock and restores the previous
/// `JCODE_HOME` on drop, so these tests cannot race other env-mutating tests.
struct IsolatedHome {
    _dir: tempfile::TempDir,
    previous: Option<std::ffi::OsString>,
    _guard: std::sync::MutexGuard<'static, ()>,
}

impl Drop for IsolatedHome {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => crate::env::set_var("JCODE_HOME", value),
            None => crate::env::remove_var("JCODE_HOME"),
        }
    }
}

fn isolated_home() -> IsolatedHome {
    let guard = crate::storage::lock_test_env();
    let dir = tempfile::TempDir::new().expect("temp jcode home");
    let previous = std::env::var_os("JCODE_HOME");
    crate::env::set_var("JCODE_HOME", dir.path());
    IsolatedHome {
        _dir: dir,
        previous,
        _guard: guard,
    }
}

#[test]
fn test_device_registry_pairing() {
    let _home = isolated_home();
    let mut registry = DeviceRegistry::default();

    // Generate pairing code
    let code = registry.generate_pairing_code();
    assert_eq!(code.len(), 6);
    assert_eq!(registry.pending_codes.len(), 1);

    // Validate correct code
    assert!(registry.validate_code(&code));
    assert_eq!(registry.pending_codes.len(), 0); // consumed

    // Validate again should fail (consumed)
    assert!(!registry.validate_code(&code));
}

#[test]
fn test_device_registry_token_auth() {
    let _home = isolated_home();
    let mut registry = DeviceRegistry::default();

    // Pair a device
    let token = registry.pair_device("test-device-1".to_string(), "Test iPhone".to_string(), None);

    // Validate correct token
    assert!(registry.validate_token(&token).is_some());
    let device = registry.validate_token(&token).unwrap();
    assert_eq!(device.name, "Test iPhone");
    assert_eq!(device.id, "test-device-1");

    // Validate wrong token
    assert!(registry.validate_token("wrong-token").is_none());

    // Token hash should be stored, not raw token
    assert!(registry.devices[0].token_hash.starts_with("sha256:"));
}

#[test]
fn test_device_re_pairing() {
    let _home = isolated_home();
    let mut registry = DeviceRegistry::default();

    // Pair same device twice
    let token1 = registry.pair_device("device-1".to_string(), "iPhone v1".to_string(), None);
    let token2 = registry.pair_device("device-1".to_string(), "iPhone v2".to_string(), None);

    // Only one device entry (old one replaced)
    assert_eq!(registry.devices.len(), 1);
    assert_eq!(registry.devices[0].name, "iPhone v2");

    // Old token should be invalid
    assert!(registry.validate_token(&token1).is_none());
    // New token should be valid
    assert!(registry.validate_token(&token2).is_some());
}

#[test]
fn test_parse_bearer_token() {
    assert_eq!(parse_bearer_token("Bearer abc"), Some("abc"));
    assert_eq!(parse_bearer_token("bearer abc"), Some("abc"));
    assert_eq!(parse_bearer_token("BEARER abc"), Some("abc"));
    assert_eq!(parse_bearer_token("Bearer"), None);
    assert_eq!(parse_bearer_token("Basic abc"), None);
    assert_eq!(parse_bearer_token("Bearer abc def"), None);
}

#[test]
fn test_parse_query_token() {
    assert_eq!(parse_query_token("token=abc"), Some("abc"));
    assert_eq!(parse_query_token("foo=bar&token=abc123"), Some("abc123"));
    assert_eq!(parse_query_token("token="), None);
    assert_eq!(parse_query_token("foo=bar"), None);
}

#[test]
fn test_hex_token_validation() {
    assert!(is_valid_hex_token(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    ));
    assert!(!is_valid_hex_token("abc"));
    assert!(!is_valid_hex_token(
        "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
    ));
}

#[test]
fn test_extract_ws_auth_prefers_header_and_falls_back_to_query() {
    let token_a = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let token_b = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    let header_request = Request::builder()
        .uri("ws://example.com/ws")
        .header("authorization", format!("Bearer {token_a}"))
        .body(())
        .expect("request");
    let header_auth = extract_ws_auth(&header_request).expect("header auth");
    assert_eq!(header_auth.token, token_a);
    assert_eq!(header_auth.source, WsAuthSource::Header);

    let query_request = Request::builder()
        .uri(format!("ws://example.com/ws?token={token_b}"))
        .body(())
        .expect("request");
    let query_auth = extract_ws_auth(&query_request).expect("query auth");
    assert_eq!(query_auth.token, token_b);
    assert_eq!(query_auth.source, WsAuthSource::Query);
}

#[test]
fn test_extract_ws_auth_rejects_conflicting_sources() {
    let token_a = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let token_b = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    let request = Request::builder()
        .uri(format!("ws://example.com/ws?token={token_b}"))
        .header("authorization", format!("Bearer {token_a}"))
        .body(())
        .expect("request");
    assert!(extract_ws_auth(&request).is_err());
}

#[test]
fn test_find_header_end() {
    assert_eq!(
        super::find_header_end(b"POST /pair HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}"),
        Some(38)
    );
    assert_eq!(
        super::find_header_end(b"POST /pair HTTP/1.1\r\nContent-"),
        None
    );
    assert_eq!(super::find_header_end(b""), None);
}

#[test]
fn test_authorize_ws_device_valid_token() {
    let _home = isolated_home();
    let mut registry = DeviceRegistry::default();
    let token = registry.pair_device("dev-1".to_string(), "iPhone".to_string(), None);

    let device = auth::authorize_ws_device(&registry, &token).expect("valid token authorizes");
    assert_eq!(device.name, "iPhone");
    assert_eq!(device.id, "dev-1");
}

#[test]
fn test_authorize_ws_device_rejects_unknown_and_revoked_with_401() {
    let _home = isolated_home();
    let mut registry = DeviceRegistry::default();
    let token = registry.pair_device("dev-1".to_string(), "iPhone".to_string(), None);

    // Unknown token -> 401 at handshake time.
    let unknown = "a".repeat(64);
    let err =
        auth::authorize_ws_device(&registry, &unknown).expect_err("unknown token must be rejected");
    assert_eq!(err.status(), 401);
    assert!(
        err.body()
            .as_deref()
            .unwrap_or_default()
            .contains("re-pair"),
        "401 body should tell the client to re-pair"
    );

    // Revoked device -> same 401 path.
    registry.devices.retain(|d| d.id != "dev-1");
    let err =
        auth::authorize_ws_device(&registry, &token).expect_err("revoked token must be rejected");
    assert_eq!(err.status(), 401);
}

// ---------------------------------------------------------------------------
// Web client routing
// ---------------------------------------------------------------------------

#[test]
fn test_sessions_limit_is_clamped_to_a_safe_range() {
    use super::parse_limit_param;

    // A missing or unparseable limit still returns a useful page of sessions.
    assert_eq!(parse_limit_param("/sessions"), 50);
    assert_eq!(parse_limit_param("/sessions?limit=abc"), 50);
    assert_eq!(parse_limit_param("/sessions?other=3"), 50);

    assert_eq!(parse_limit_param("/sessions?limit=10"), 10);
    assert_eq!(parse_limit_param("/sessions?foo=1&limit=25"), 25);

    // A client must never be able to walk an entire install in one request,
    // and zero would return an empty list the user cannot act on.
    assert_eq!(parse_limit_param("/sessions?limit=100000"), 500);
    assert_eq!(parse_limit_param("/sessions?limit=0"), 1);
}

#[test]
fn test_web_assets_resolve_only_for_known_paths() {
    // The app shell and its dependencies are served...
    for path in [
        "/",
        "/index.html",
        "/app.js",
        "/app.css",
        "/sw.js",
        "/manifest.webmanifest",
        "/icon.svg",
        "/icon-192.png",
    ] {
        assert!(
            super::web::lookup(path).is_some(),
            "{path} should be served"
        );
    }

    // ...and nothing else is. `lookup` matches an explicit allowlist, so no
    // request path can ever escape into the filesystem.
    for path in [
        "/../Cargo.toml",
        "/../../etc/passwd",
        "/app.js/../../secret",
        "/sessions",
        "/ws",
    ] {
        assert!(
            super::web::lookup(path).is_none(),
            "{path} must not resolve to an asset"
        );
    }
}

#[test]
fn test_sessions_metadata_contract_preserves_null_unknowns_and_title_fallback() {
    let entry = crate::recent_session_index::RecentSessionMetadata {
        session_id: "session_crab".into(),
        friendly_name: Some("crab".into()),
        updated_at_ms: 42,
        saved: true,
        ..Default::default()
    };
    let value = session_list_value(&entry, false);
    assert_eq!(value["title"], "New conversation");
    assert_eq!(value["friendly_name"], "crab");
    assert!(value["preview"].is_null());
    assert!(value["model"].is_null());
    assert!(value["message_count"].is_null());
    assert_eq!(value["updated_at_ms"], 42);
    assert_eq!(value["saved"], true);
    assert_eq!(value["live"], false);
    let value = session_list_value(
        &crate::recent_session_index::RecentSessionMetadata {
            first_prompt: Some("Actual prompt".into()),
            preview: Some("Real reply".into()),
            model: Some("actual-model".into()),
            message_count: Some(2),
            last_active_at_ms: Some(100),
            ..entry
        },
        true,
    );
    assert_eq!(value["title"], "Actual prompt");
    assert_eq!(value["preview"], "Real reply");
    assert_eq!(value["model"], "actual-model");
    assert_eq!(value["message_count"], 2);
    assert_eq!(value["updated_at_ms"], 100);
    assert_eq!(value["live"], true);
}

#[tokio::test]
async fn test_sessions_index_failure_is_not_empty_success() {
    let home = isolated_home();
    let mut registry = DeviceRegistry::default();
    let token = registry.pair_device("test-device".into(), "test".into(), None);
    std::fs::create_dir(home._dir.path().join("session-metadata-v1.sqlite3")).unwrap();
    let headers = format!("Authorization: Bearer {token}");
    let response = handle_sessions_request(
        &headers,
        "/sessions",
        &Arc::new(tokio::sync::RwLock::new(registry)),
    )
    .await;
    let response = String::from_utf8(response).unwrap();
    assert!(response.starts_with("HTTP/1.1 500"), "{response}");
    assert!(response.contains("Session metadata unavailable"));
    assert!(!response.contains("\"sessions\":[]"));
}

#[tokio::test]
async fn test_sessions_endpoint_uses_real_pid_liveness_and_indexed_metadata() {
    let _home = isolated_home();
    let mut registry = DeviceRegistry::default();
    let token = registry.pair_device("metadata-test".into(), "test".into(), None);
    for (id, pid) in [("session_live", std::process::id()), ("session_stale", 0)] {
        crate::recent_session_index::upsert(&crate::recent_session_index::RecentSessionMetadata {
            session_id: id.into(),
            first_prompt: Some("Real first prompt".into()),
            preview: Some("Last conversational reply".into()),
            model: Some("real-model".into()),
            message_count: Some(2),
            saved: true,
            updated_at_ms: 5,
            ..Default::default()
        })
        .unwrap();
        jcode_storage::register_active_pid(id, pid);
    }
    let response = handle_sessions_request(
        &format!("Authorization: Bearer {token}"),
        "/sessions",
        &Arc::new(tokio::sync::RwLock::new(registry)),
    )
    .await;
    let response = String::from_utf8(response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let body: serde_json::Value =
        serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
    let entries = body["sessions"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    for entry in entries {
        assert_eq!(entry["title"], "Real first prompt");
        assert_eq!(entry["preview"], "Last conversational reply");
        assert_eq!(entry["message_count"], 2);
        assert_eq!(entry["saved"], true);
        assert_eq!(entry["live"], entry["id"] == "session_live");
    }
}

#[test]
fn test_sessions_report_newest_activity_not_just_last_resume() {
    // `last_active_at_ms` is stamped only when a session is created or resumed.
    // Preferring it unconditionally froze every row at the last daemon restart:
    // the conversation kept moving, the list kept saying "32m ago", and the
    // timestamps aged on screen while the user watched.
    let base = crate::recent_session_index::RecentSessionMetadata {
        session_id: "session_horse".into(),
        ..Default::default()
    };

    // Turns persisted long after the resume stamp: report the turn.
    let value = session_list_value(
        &crate::recent_session_index::RecentSessionMetadata {
            updated_at_ms: 9_000,
            last_active_at_ms: Some(1_000),
            ..base.clone()
        },
        true,
    );
    assert_eq!(value["updated_at_ms"], 9_000);

    // A fresh resume with no new turns is still genuinely recent: report it.
    let value = session_list_value(
        &crate::recent_session_index::RecentSessionMetadata {
            updated_at_ms: 1_000,
            last_active_at_ms: Some(9_000),
            ..base.clone()
        },
        true,
    );
    assert_eq!(value["updated_at_ms"], 9_000);

    // Never indexed for activity: fall back without panicking.
    let value = session_list_value(
        &crate::recent_session_index::RecentSessionMetadata {
            updated_at_ms: 7_000,
            last_active_at_ms: None,
            ..base
        },
        false,
    );
    assert_eq!(value["updated_at_ms"], 7_000);
}

/// The web client downloads `history.images` and never reads it: every
/// `images` reference in app.js is outbound, for uploading. Measured here,
/// that dead weight is 77% of session bytes (84.8MB of 110MB across the 15
/// largest sessions), crossing a phone connection on every chat open.
///
/// These tests pin both halves: the bytes really go, and nothing else does.
#[test]
fn history_images_are_elided_for_the_browser() {
    let big = "A".repeat(50_000);
    let payload = serde_json::json!({
        "type": "history",
        "id": 7,
        "session_id": "session_x",
        "messages": [{"role": "user", "content": "hi"}],
        "images": [
            {"media_type": "image/png", "data": big, "anchor": {"message_index": 3}},
            {"media_type": "image/jpeg", "data": "QUJD"}
        ]
    })
    .to_string();
    let before = payload.len();

    let after = strip_history_images(payload);
    assert!(
        after.len() < before / 10,
        "payload should collapse: {before} -> {}",
        after.len()
    );

    let value: serde_json::Value = serde_json::from_str(&after).expect("valid json");
    let images = value["images"].as_array().expect("images array");

    // Length is preserved so a client can still tell how many images exist.
    assert_eq!(images.len(), 2);
    // Bytes are gone, but the metadata a lazy fetch would need survives.
    assert_eq!(images[0]["data"], "");
    assert_eq!(images[0]["elided"], true);
    assert_eq!(images[0]["media_type"], "image/png");
    assert_eq!(images[0]["byte_length"], 50_000);
    assert_eq!(images[0]["anchor"]["message_index"], 3);
    assert_eq!(images[1]["media_type"], "image/jpeg");

    // Everything outside `images` must be untouched.
    assert_eq!(value["id"], 7);
    assert_eq!(value["session_id"], "session_x");
    assert_eq!(value["messages"][0]["content"], "hi");
}

#[test]
fn non_history_events_pass_through_byte_for_byte() {
    // Deltas are the hot path and the overwhelming majority of traffic. A
    // re-serialize here would reorder keys and burn CPU per token.
    for payload in [
        r#"{"type":"text_delta","text":"hello"}"#,
        // Mentions images but is not a history event: must not be rewritten.
        r#"{"type":"message","images":[["image/png","QUJD"]]}"#,
        // A history event with no images needs no work.
        r#"{"type":"history","id":1,"messages":[]}"#,
        // Malformed JSON must be forwarded, never dropped or panicked on.
        r#"{"type":"history","images":[ truncated"#,
        "",
    ] {
        assert_eq!(
            strip_history_images(payload.to_string()),
            payload,
            "should pass through unchanged: {payload}"
        );
    }
}

#[test]
fn an_empty_images_array_is_left_alone() {
    let payload = r#"{"type":"history","id":2,"images":[],"messages":[]}"#.to_string();
    assert_eq!(strip_history_images(payload.clone()), payload);
}
