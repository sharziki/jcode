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

/// Build an HTTP response for a static asset.
///
/// The service worker is served `no-cache` so a client can never pin itself to
/// a stale worker that then keeps serving a stale app forever. Everything else
/// is revalidated too, because the app is small and served over a LAN or
/// Tailscale link where correctness beats a few saved kilobytes.
pub(super) fn asset_response(content_type: &str, body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: {}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-cache\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Connection: close\r\n\r\n",
        content_type,
        body.len()
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
        let response = asset_response("text/css; charset=utf-8", b"body{}");
        let text = String::from_utf8_lossy(&response);
        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(text.contains("Content-Length: 6\r\n"));
        assert!(text.ends_with("\r\n\r\nbody{}"));
    }
}
