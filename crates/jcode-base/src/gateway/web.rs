//! Static asset serving for the jcode web client (PWA).
//!
//! The gateway already owns the two things a remote client needs: `POST /pair`
//! turns a pairing code into a token, and `GET /ws` bridges a browser to a real
//! session. The only missing piece was a client that any phone can load without
//! an app store, so the same listener now also serves an installable web app.
//!
//! Assets are embedded in the binary rather than read from disk: the gateway
//! must work from any working directory, from a released binary, and after the
//! repo it was built from has moved.

/// One embedded asset: request path, content type, bytes.
struct Asset {
    path: &'static str,
    content_type: &'static str,
    body: &'static [u8],
}

const ASSETS: &[Asset] = &[
    Asset {
        path: "/",
        content_type: "text/html; charset=utf-8",
        body: include_bytes!("web/index.html"),
    },
    Asset {
        path: "/index.html",
        content_type: "text/html; charset=utf-8",
        body: include_bytes!("web/index.html"),
    },
    Asset {
        path: "/app.js",
        content_type: "application/javascript; charset=utf-8",
        body: include_bytes!("web/app.js"),
    },
    Asset {
        path: "/app.css",
        content_type: "text/css; charset=utf-8",
        body: include_bytes!("web/app.css"),
    },
    Asset {
        path: "/manifest.webmanifest",
        content_type: "application/manifest+json; charset=utf-8",
        body: include_bytes!("web/manifest.webmanifest"),
    },
    Asset {
        path: "/sw.js",
        content_type: "application/javascript; charset=utf-8",
        body: include_bytes!("web/sw.js"),
    },
    Asset {
        path: "/icon.svg",
        content_type: "image/svg+xml",
        body: include_bytes!("web/icon.svg"),
    },
    Asset {
        path: "/icon-192.png",
        content_type: "image/png",
        body: include_bytes!("web/icon-192.png"),
    },
    Asset {
        path: "/icon-512.png",
        content_type: "image/png",
        body: include_bytes!("web/icon-512.png"),
    },
    Asset {
        path: "/icon-maskable-512.png",
        content_type: "image/png",
        body: include_bytes!("web/icon-maskable-512.png"),
    },
];

/// Look up an embedded asset by request path.
pub(super) fn lookup(path: &str) -> Option<(&'static str, &'static [u8])> {
    ASSETS
        .iter()
        .find(|asset| asset.path == path)
        .map(|asset| (asset.content_type, asset.body))
}

/// A content-addressed ETag for an asset body.
///
/// FNV-1a over the bytes. The assets are embedded at compile time, so the tag
/// changes exactly when the shipped file changes, which is the only property a
/// validator needs. This is not a security boundary, so a non-cryptographic
/// hash is the right cost.
fn etag(body: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in body {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    format!("\"{hash:016x}\"")
}

/// Whether an `If-None-Match` header matches this asset's current tag.
///
/// Handles the comma-separated list form and the `W/` weak prefix that
/// browsers send back, plus `*`.
pub(super) fn matches_etag(if_none_match: &str, tag: &str) -> bool {
    if_none_match.split(',').any(|candidate| {
        let candidate = candidate.trim();
        candidate == "*" || candidate.trim_start_matches("W/") == tag
    })
}

/// Extract the `If-None-Match` value from a raw request head, if present.
pub(super) fn if_none_match(headers_text: &str) -> Option<&str> {
    headers_text.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("if-none-match")
            .then(|| value.trim())
    })
}

/// Build an HTTP response for a static asset.
///
/// The service worker is served `no-cache` so a client can never pin itself to
/// a stale worker that then keeps serving a stale app forever. Everything else
/// is revalidated too, because the app is small and served over a LAN or
/// Tailscale link where correctness beats a few saved kilobytes.
///
/// Revalidation still costs a round trip, but with an `ETag` the round trip
/// returns an empty `304` instead of re-sending the whole client on every
/// launch. Correctness is unchanged: the server still decides what is fresh.
pub(super) fn asset_response(content_type: &str, body: &[u8], if_none_match: Option<&str>) -> Vec<u8> {
    let tag = etag(body);

    if if_none_match.is_some_and(|header| matches_etag(header, &tag)) {
        return format!(
            "HTTP/1.1 304 Not Modified\r\n\
             ETag: {tag}\r\n\
             Cache-Control: no-cache\r\n\
             Connection: close\r\n\r\n"
        )
        .into_bytes();
    }

    let mut response = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: {}\r\n\
         Content-Length: {}\r\n\
         ETag: {}\r\n\
         Cache-Control: no-cache\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Connection: close\r\n\r\n",
        content_type,
        body.len(),
        tag
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_serves_the_app_shell() {
        let (content_type, body) = lookup("/").expect("root asset");
        assert_eq!(content_type, "text/html; charset=utf-8");
        let html = String::from_utf8_lossy(body);
        assert!(
            html.contains("manifest.webmanifest"),
            "shell links manifest"
        );
        assert!(html.contains("app.js"), "shell loads the client");
    }

    #[test]
    fn every_asset_referenced_by_the_manifest_exists() {
        let (_, manifest) = lookup("/manifest.webmanifest").expect("manifest");
        let manifest: serde_json::Value =
            serde_json::from_slice(manifest).expect("manifest is valid JSON");
        let icons = manifest["icons"].as_array().expect("icons array");
        assert!(!icons.is_empty(), "manifest declares icons");
        for icon in icons {
            let src = icon["src"].as_str().expect("icon src");
            assert!(lookup(src).is_some(), "icon {src} is served");
        }
        let start_url = manifest["start_url"].as_str().expect("start_url");
        assert!(
            lookup(start_url).is_some(),
            "start_url {start_url} is served"
        );
    }

    #[test]
    fn service_worker_precache_list_is_all_servable() {
        let (_, sw) = lookup("/sw.js").expect("service worker");
        let sw = String::from_utf8_lossy(sw);
        // Extract the quoted paths from the PRECACHE array literal.
        let start = sw.find("PRECACHE = [").expect("precache list");
        let rest = &sw[start..];
        let end = rest.find(']').expect("precache list end");
        let mut found = 0;
        for chunk in rest[..end].split('"').skip(1).step_by(2) {
            assert!(lookup(chunk).is_some(), "precached {chunk} is served");
            found += 1;
        }
        assert!(found > 0, "precache list is non-empty");
    }

    #[test]
    fn png_icons_are_real_pngs() {
        for path in ["/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"] {
            let (content_type, body) = lookup(path).expect(path);
            assert_eq!(content_type, "image/png");
            assert_eq!(&body[..8], b"\x89PNG\r\n\x1a\n", "{path} has a PNG header");
        }
    }

    #[test]
    fn unknown_paths_do_not_resolve() {
        assert!(lookup("/../../etc/passwd").is_none());
        assert!(lookup("/nope").is_none());
    }

    /// Every embedded asset must be byte-identical to the file on disk, and
    /// every file in the asset directory must actually be served.
    ///
    /// `include_bytes!` bakes the assets into the binary at compile time, so a
    /// stale build would serve an old client while the repo looks correct.
    ///
    /// Be precise about what this catches. Cargo tracks `include_bytes!` inputs
    /// as rebuild dependencies (verified by touching an asset: `jcode-base`
    /// recompiled), so the byte comparison cannot fail under `cargo test` —
    /// editing an asset rebuilds this crate before the assertion runs. It is
    /// kept as a cheap guard against an out-of-band build path that skips that
    /// dependency tracking.
    ///
    /// The directory scan below is the half that genuinely bites, and it was
    /// mutation-tested: adding an unwired `orphan.css` fails this test with an
    /// actionable message.
    #[test]
    fn embedded_assets_match_the_files_on_disk() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/gateway/web");

        for asset in ASSETS {
            // "/" is an alias for index.html and has no file of its own.
            let name = asset.path.trim_start_matches('/');
            if name.is_empty() {
                continue;
            }
            let on_disk =
                std::fs::read(dir.join(name)).unwrap_or_else(|e| panic!("reading {name}: {e}"));
            assert_eq!(
                asset.body,
                &on_disk[..],
                "embedded {} differs from the file on disk",
                asset.path
            );
        }

        // Anything shipped in the directory must actually be served, otherwise
        // it is dead weight in the repo or a missing route.
        for entry in std::fs::read_dir(&dir).expect("web asset dir").flatten() {
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();
            assert!(
                ASSETS
                    .iter()
                    .any(|a| a.path.trim_start_matches('/') == name),
                "{name} exists on disk but is not served; add it to ASSETS or delete it"
            );
        }
    }

    /// The root alias and `/index.html` must never drift apart.
    #[test]
    fn root_and_index_serve_identical_bytes() {
        let (root_type, root) = lookup("/").expect("root");
        let (index_type, index) = lookup("/index.html").expect("index");
        assert_eq!(root, index);
        assert_eq!(root_type, index_type);
    }

    #[test]
    fn asset_response_has_well_formed_headers() {
        let response = asset_response("text/css; charset=utf-8", b"body{}", None);
        let text = String::from_utf8_lossy(&response);
        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(text.contains("Content-Length: 6\r\n"));
        assert!(text.ends_with("\r\n\r\nbody{}"));
    }

    /// Pull the quoted ETag value out of a response head.
    fn tag_of(response: &[u8]) -> String {
        let text = String::from_utf8_lossy(response).into_owned();
        let line = text
            .lines()
            .find(|l| l.starts_with("ETag: "))
            .expect("response carries an ETag");
        line["ETag: ".len()..].trim().to_string()
    }

    #[test]
    fn a_matching_etag_returns_304_without_a_body() {
        let body = b"body{}";
        let first = asset_response("text/css; charset=utf-8", body, None);
        let tag = tag_of(&first);

        let second = asset_response("text/css; charset=utf-8", body, Some(&tag));
        let text = String::from_utf8_lossy(&second);
        assert!(text.starts_with("HTTP/1.1 304 Not Modified\r\n"));
        assert!(
            !text.contains("body{}"),
            "304 must not resend the asset, that is the whole point"
        );
    }

    #[test]
    fn a_stale_etag_returns_the_full_asset() {
        let response = asset_response("text/css; charset=utf-8", b"body{}", Some("\"outdated\""));
        let text = String::from_utf8_lossy(&response);
        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(text.ends_with("\r\n\r\nbody{}"));
    }

    #[test]
    fn etags_track_content_not_content_type() {
        let a = tag_of(&asset_response("text/css; charset=utf-8", b"one", None));
        let b = tag_of(&asset_response("text/css; charset=utf-8", b"two", None));
        assert_ne!(a, b, "different bytes must not share a validator");

        let same = tag_of(&asset_response("text/plain; charset=utf-8", b"one", None));
        assert_eq!(a, same, "the tag validates the body, and only the body");
    }

    /// Browsers echo tags back weak-prefixed and comma-joined.
    #[test]
    fn weak_and_list_form_if_none_match_still_match() {
        let tag = tag_of(&asset_response("text/css; charset=utf-8", b"body{}", None));

        for header in [
            format!("W/{tag}"),
            format!("\"other\", {tag}"),
            format!("W/\"other\", W/{tag}"),
            "*".to_string(),
        ] {
            let response = asset_response("text/css; charset=utf-8", b"body{}", Some(&header));
            assert!(
                String::from_utf8_lossy(&response).starts_with("HTTP/1.1 304"),
                "If-None-Match: {header} should validate"
            );
        }
    }

    #[test]
    fn if_none_match_is_parsed_case_insensitively_from_the_request_head() {
        let head = "GET /app.js HTTP/1.1\r\nHost: x\r\nif-none-match: \"abc\"\r\n";
        assert_eq!(if_none_match(head), Some("\"abc\""));

        let absent = "GET /app.js HTTP/1.1\r\nHost: x\r\n";
        assert_eq!(if_none_match(absent), None);
    }

    /// A stale validator for a *different* asset must never suppress a body.
    #[test]
    fn one_assets_tag_does_not_validate_another() {
        let (_, js) = lookup("/app.js").expect("app.js");
        let (_, css) = lookup("/app.css").expect("app.css");
        let js_tag = tag_of(&asset_response("application/javascript", js, None));

        let response = asset_response("text/css; charset=utf-8", css, Some(&js_tag));
        assert!(
            String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200 OK"),
            "app.js's tag must not validate app.css"
        );
    }
}
