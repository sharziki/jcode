//! Which sessions are the user's own chats, and which are spawned subagents.
//!
//! The gateway's session list is a phone-sized surface, so it must show the
//! conversations a person actually started. Swarm workers are spawned by the
//! agent, are usually headless, and report back to a coordinator rather than to
//! a human. Listing them buries real chats under machine-generated ones.
//!
//! Membership lives in the durable swarm snapshots under `state/swarm`, not in
//! the session index, so this reads those snapshots and returns the set of
//! session IDs to hide. It is deliberately best-effort: an unreadable or
//! malformed snapshot hides nothing, because wrongly hiding a real conversation
//! is far worse than showing an extra worker.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Deserialize)]
struct Snapshot {
    #[serde(default)]
    members: Vec<Member>,
}

#[derive(Deserialize)]
struct Member {
    session_id: String,
    /// "agent" for spawned workers, "coordinator" for the session a human drives.
    #[serde(default)]
    role: Option<String>,
    /// Set when this session reports completion to another session, which only
    /// happens for spawned work.
    #[serde(default)]
    report_back_to_session_id: Option<String>,
}

impl Member {
    /// Whether this member is a spawned worker rather than a human's own chat.
    ///
    /// `role` is authoritative when present. Older snapshots predate it, so
    /// reporting back to a *different* session is accepted as the fallback
    /// signal. A coordinator never reports back, so it is never caught by this.
    fn is_subagent(&self) -> bool {
        match self.role.as_deref().map(str::trim) {
            Some("agent") => true,
            // An explicit non-agent role, such as "coordinator", is a human's
            // session. Trust it and stop, rather than second-guessing via the
            // report-back heuristic below.
            Some(role) if !role.is_empty() => false,
            _ => self
                .report_back_to_session_id
                .as_deref()
                .map(str::trim)
                .is_some_and(|parent| !parent.is_empty() && parent != self.session_id),
        }
    }
}

/// Directory holding durable swarm snapshots, honouring the same env overrides
/// the rest of the daemon uses so tests and isolated runtimes stay isolated.
fn swarm_state_dir() -> Option<PathBuf> {
    if let Ok(runtime) = std::env::var("JCODE_RUNTIME_DIR") {
        return Some(PathBuf::from(runtime).join("durable-state").join("swarm"));
    }
    let home = std::env::var_os("JCODE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|home| PathBuf::from(home).join(".jcode"))
        })?;
    Some(home.join("state").join("swarm"))
}

/// Session IDs that are spawned subagents, from the local swarm snapshots.
pub(super) fn subagent_session_ids() -> HashSet<String> {
    swarm_state_dir().map(subagent_ids_in).unwrap_or_default()
}

/// Like [`subagent_session_ids`], for an explicit snapshot directory.
pub(super) fn subagent_ids_in(dir: impl AsRef<Path>) -> HashSet<String> {
    let mut hidden = HashSet::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return hidden;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        // Only `.json`; `.bak` siblings are stale copies of the same state.
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let snapshot = std::fs::File::open(&path).ok().and_then(|file| {
            serde_json::from_reader::<_, Snapshot>(std::io::BufReader::new(file)).ok()
        });
        let Some(snapshot) = snapshot else { continue };
        for member in snapshot.members {
            if member.is_subagent() {
                hidden.insert(member.session_id);
            }
        }
    }
    hidden
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).expect("write snapshot");
    }

    fn tempdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jcode-subagent-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn agents_are_hidden_and_coordinators_are_kept() {
        let dir = tempdir();
        write(
            &dir,
            "swarm.json",
            r#"{"members":[
                {"session_id":"coord","role":"coordinator"},
                {"session_id":"worker","role":"agent","report_back_to_session_id":"coord"}
            ]}"#,
        );

        let hidden = subagent_ids_in(&dir);
        assert!(hidden.contains("worker"), "spawned agent is hidden");
        assert!(
            !hidden.contains("coord"),
            "the coordinator is the user's own chat and must stay visible"
        );
    }

    /// Snapshots written before `role` existed still have to be classified.
    #[test]
    fn report_back_identifies_agents_when_role_is_absent() {
        let dir = tempdir();
        write(
            &dir,
            "legacy.json",
            r#"{"members":[
                {"session_id":"coord"},
                {"session_id":"worker","report_back_to_session_id":"coord"}
            ]}"#,
        );

        let hidden = subagent_ids_in(&dir);
        assert!(hidden.contains("worker"));
        assert!(!hidden.contains("coord"));
    }

    /// A session reporting to itself is not a subagent, and an empty string is
    /// not a parent. Either mistake would hide a real conversation.
    #[test]
    fn self_reference_and_blank_parents_are_not_subagents() {
        let dir = tempdir();
        write(
            &dir,
            "edge.json",
            r#"{"members":[
                {"session_id":"a","report_back_to_session_id":"a"},
                {"session_id":"b","report_back_to_session_id":""},
                {"session_id":"c","report_back_to_session_id":"   "},
                {"session_id":"d"}
            ]}"#,
        );

        assert!(subagent_ids_in(&dir).is_empty());
    }

    /// An explicit non-agent role wins over the report-back fallback.
    #[test]
    fn an_explicit_non_agent_role_is_trusted() {
        let dir = tempdir();
        write(
            &dir,
            "roles.json",
            r#"{"members":[
                {"session_id":"coord","role":"coordinator","report_back_to_session_id":"other"}
            ]}"#,
        );

        assert!(
            !subagent_ids_in(&dir).contains("coord"),
            "a declared coordinator is never hidden, even if it has a parent"
        );
    }

    #[test]
    fn malformed_and_missing_input_hides_nothing() {
        assert!(subagent_ids_in("/nonexistent/path/for/jcode/test").is_empty());

        let dir = tempdir();
        write(&dir, "broken.json", "{not json");
        write(
            &dir,
            "notes.txt",
            r#"{"members":[{"session_id":"x","role":"agent"}]}"#,
        );
        assert!(
            subagent_ids_in(&dir).is_empty(),
            "unparseable or non-JSON files must never hide a conversation"
        );
    }

    /// `.bak` siblings must not be read; only the live `.json` snapshot counts.
    #[test]
    fn backup_files_are_ignored() {
        let dir = tempdir();
        write(
            &dir,
            "swarm.json.bak",
            r#"{"members":[{"session_id":"stale","role":"agent"}]}"#,
        );
        assert!(!subagent_ids_in(&dir).contains("stale"));
    }

    #[test]
    fn agents_across_several_swarms_are_all_hidden() {
        let dir = tempdir();
        write(
            &dir,
            "one.json",
            r#"{"members":[{"session_id":"w1","role":"agent","report_back_to_session_id":"c1"}]}"#,
        );
        write(
            &dir,
            "two.json",
            r#"{"members":[{"session_id":"w2","role":"agent","report_back_to_session_id":"c2"}]}"#,
        );

        let hidden = subagent_ids_in(&dir);
        assert!(hidden.contains("w1") && hidden.contains("w2"));
    }
}
