//! Durable metadata index for fast recent-session lists.
//!
//! Transcript snapshots can be hundreds of megabytes and a long-lived install
//! can contain 100k+ files. This SQLite index is updated beside normal session
//! persistence and can be queried across daemon, CLI, and API bridge processes.

use crate::message::{ContentBlock, Role};
use crate::session::StoredMessage;
use std::io::Read;
use std::time::Duration;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};

use crate::session::Session;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RecentSessionMetadata {
    pub session_id: String,
    pub working_dir: Option<String>,
    pub generated_title: Option<String>,
    pub custom_title: Option<String>,
    pub todo_title: Option<String>,
    pub saved: bool,
    pub first_prompt: Option<String>,
    pub preview: Option<String>,
    pub model: Option<String>,
    /// Visible, nonempty user/assistant text messages, not tool or system messages.
    /// None means not indexed, or the bounded scan could not establish a count.
    pub message_count: Option<i64>,
    pub friendly_name: Option<String>,
    pub updated_at_ms: i64,
    pub last_active_at_ms: Option<i64>,
}

impl RecentSessionMetadata {
    pub fn display_title(&self) -> Option<&str> {
        self.custom_title
            .as_deref()
            .and_then(non_empty)
            .or_else(|| self.todo_title.as_deref().and_then(non_empty))
            .or_else(|| self.generated_title.as_deref().and_then(non_empty))
            .or_else(|| self.first_prompt.as_deref().and_then(non_empty))
    }
}

fn non_empty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn open() -> Result<Connection> {
    let path = crate::storage::jcode_dir()?.join("session-metadata-v1.sqlite3");
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(2))?;
    initialize(&connection)?;
    Ok(connection)
}

fn initialize(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS recent_sessions (
             session_id TEXT PRIMARY KEY NOT NULL,
             working_dir TEXT,
             generated_title TEXT,
             custom_title TEXT,
             todo_title TEXT,
             updated_at_ms INTEGER NOT NULL,
             last_active_at_ms INTEGER
         );
         CREATE INDEX IF NOT EXISTS recent_sessions_activity
         ON recent_sessions(MAX(COALESCE(last_active_at_ms, 0), updated_at_ms) DESC);",
    )?;
    // Serialize additive migrations across daemon/CLI processes.
    let transaction =
        rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)?;
    // Inspect before ALTER so genuine migration failures are never swallowed.
    let columns = transaction
        .prepare("PRAGMA table_info(recent_sessions)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (name, definition) in [
        ("saved", "INTEGER NOT NULL DEFAULT 0"),
        ("first_prompt", "TEXT"),
        ("preview", "TEXT"),
        ("model", "TEXT"),
        ("message_count", "INTEGER"),
        ("friendly_name", "TEXT"),
        ("summary_retry_at_ms", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !columns.iter().any(|column| column == name) {
            transaction.execute(
                &format!("ALTER TABLE recent_sessions ADD COLUMN {name} {definition}"),
                [],
            )?;
        }
    }
    transaction.commit()?;
    Ok(())
}

pub fn recent(limit: usize) -> Result<Vec<RecentSessionMetadata>> {
    let connection = open()?;
    let mut statement = connection.prepare(
        "SELECT session_id, working_dir, generated_title, custom_title,
                todo_title, saved, updated_at_ms, last_active_at_ms,
                first_prompt, preview, model, message_count, friendly_name
         FROM recent_sessions
         ORDER BY MAX(COALESCE(last_active_at_ms, 0), updated_at_ms) DESC
         LIMIT ?1",
    )?;
    let entries = statement
        .query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
            Ok(RecentSessionMetadata {
                session_id: row.get(0)?,
                working_dir: row.get(1)?,
                generated_title: row.get(2)?,
                custom_title: row.get(3)?,
                todo_title: row.get(4)?,
                saved: row.get(5)?,
                updated_at_ms: row.get(6)?,
                last_active_at_ms: row.get(7)?,
                first_prompt: row.get(8)?,
                preview: row.get(9)?,
                model: row.get(10)?,
                message_count: row.get(11)?,
                friendly_name: row.get(12)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(entries)
}

/// Update the index after a successful session persistence operation.
pub fn upsert_session(session: &Session) -> Result<()> {
    let summary = summarize(&session.messages);
    upsert(&RecentSessionMetadata {
        session_id: session.id.clone(),
        working_dir: session.working_dir.clone(),
        generated_title: session.title.clone(),
        custom_title: session.custom_title.clone(),
        todo_title: crate::todo::load_session_title(&session.id),
        saved: session.saved,
        first_prompt: summary.first_prompt,
        preview: summary.preview,
        message_count: summary.message_count,
        model: session.model.clone(),
        friendly_name: session.short_name.clone(),
        updated_at_ms: session.updated_at.timestamp_millis(),
        last_active_at_ms: session.last_active_at.map(|time| time.timestamp_millis()),
    })
}

pub fn upsert(entry: &RecentSessionMetadata) -> Result<()> {
    open()?.execute(
        "INSERT INTO recent_sessions (
             session_id, working_dir, generated_title, custom_title, todo_title,
             saved, updated_at_ms, last_active_at_ms, first_prompt, preview, model, message_count, friendly_name
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(session_id) DO UPDATE SET
             working_dir = excluded.working_dir,
             generated_title = excluded.generated_title,
             custom_title = excluded.custom_title,
             todo_title = excluded.todo_title,
             saved = excluded.saved,
             updated_at_ms = excluded.updated_at_ms,
             last_active_at_ms = excluded.last_active_at_ms,
             first_prompt = excluded.first_prompt, preview = excluded.preview,
             model = excluded.model, message_count = excluded.message_count,
             friendly_name = excluded.friendly_name, summary_retry_at_ms = 0",
        params![
            entry.session_id,
            entry.working_dir,
            entry.generated_title,
            entry.custom_title,
            entry.todo_title,
            entry.saved,
            entry.updated_at_ms,
            entry.last_active_at_ms,
            entry.first_prompt, entry.preview, entry.model, entry.message_count, entry.friendly_name,
        ],
    )?;
    Ok(())
}

/// Refresh only the derived title after the todo or plan file changes.
pub fn refresh_todo_title(session_id: &str) -> Result<()> {
    let connection = open()?;
    let exists = connection
        .query_row(
            "SELECT 1 FROM recent_sessions WHERE session_id = ?1",
            [session_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        connection.execute(
            "UPDATE recent_sessions SET todo_title = ?2 WHERE session_id = ?1",
            params![session_id, crate::todo::load_session_title(session_id)],
        )?;
    }
    Ok(())
}

#[derive(Default)]
struct ConversationSummary {
    first_prompt: Option<String>,
    preview: Option<String>,
    message_count: Option<i64>,
}

/// Bound both bytes inspected and characters emitted. In particular a giant
/// whitespace/tool transcript must not turn every persistence into a text scan.
fn conversational_text(message: &StoredMessage, budget: &mut usize) -> Option<String> {
    if message.display_role.is_some() {
        return None;
    }
    let mut result = String::new();
    let mut characters = 0;
    for block in &message.content {
        if *budget == 0 {
            break;
        }
        *budget -= 1; // Even empty/non-text blocks consume scan budget.
        let ContentBlock::Text { text, .. } = block else {
            continue;
        };
        let mut end = text.len().min(*budget).min(8192);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        *budget = budget.saturating_sub(end);
        let was_truncated = end < text.len();
        let mut text = text[..end].trim();
        // Old snapshots may lack display_role and combine a reminder with a
        // real prompt in the same text block. Never show the reminder itself.
        while text.starts_with("<system-reminder>") {
            let Some((_, rest)) = text.split_once("</system-reminder>") else {
                if was_truncated {
                    *budget = 0;
                }
                return None;
            };
            text = rest.trim_start();
        }
        if text.starts_with("[Scheduled task]\n") || text.starts_with("<system-reminder") {
            continue;
        }
        for word in text.split_whitespace() {
            if !result.is_empty() {
                if characters >= 200 {
                    result.push('…');
                    return Some(result);
                }
                result.push(' ');
                characters += 1;
            }
            for ch in word.chars() {
                if characters >= 200 {
                    result.push('…');
                    return Some(result);
                }
                result.push(ch);
                characters += 1;
            }
        }
        // If no visible text was found in the bounded prefix we cannot claim
        // an exact count. Exhaust the budget to propagate "unknown".
        if result.is_empty() && was_truncated {
            *budget = 0;
        }
        if !result.is_empty() {
            return Some(result);
        }
    }
    None
}

fn shorten(text: &str, limit: usize) -> String {
    let mut chars = text.chars();
    let mut value: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        value.push('…');
    }
    value
}

fn summarize(messages: &[StoredMessage]) -> ConversationSummary {
    let mut summary = ConversationSummary::default();
    let mut budget = 1024 * 1024;
    let mut count = 0;
    for message in messages {
        if budget == 0 {
            break;
        }
        budget -= 1;
        if let Some(text) = conversational_text(message, &mut budget) {
            count += 1;
            if message.role == Role::User && summary.first_prompt.is_none() {
                summary.first_prompt = Some(shorten(&text, 80));
            }
        }
    }
    summary.message_count = (budget > 0).then_some(count);
    // A separate reverse budget means a long history still gets a recent
    // preview, never a tool result or an arbitrarily old forward-scan tail.
    let mut budget = 64 * 1024;
    for message in messages.iter().rev() {
        if budget == 0 {
            break;
        }
        budget -= 1;
        if let Some(text) = conversational_text(message, &mut budget) {
            summary.preview = Some(text);
            break;
        }
    }
    summary
}

/// The HTTP caller runs this on a blocking worker. At most four small legacy
/// snapshots are read per request (4 MiB total). Failed/large/journal-backed
/// snapshots are retried after an hour, while normal persistence repairs them
/// immediately. No transcripts are deleted or rewritten by backfill.
pub fn recent_with_backfill(limit: usize) -> Result<Vec<RecentSessionMetadata>> {
    let connection = open()?;
    backfill(&connection, limit)?;
    recent(limit)
}

fn backfill(connection: &Connection, limit: usize) -> Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let candidates = connection
        .prepare(
            "SELECT session_id, updated_at_ms FROM
           (SELECT session_id, updated_at_ms, message_count, summary_retry_at_ms
            FROM recent_sessions ORDER BY MAX(COALESCE(last_active_at_ms, 0), updated_at_ms) DESC LIMIT ?1)
         WHERE message_count IS NULL AND summary_retry_at_ms <= ?2 LIMIT 4",
        )?
        .query_map(params![limit.min(500) as i64, now], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, updated_at) in candidates {
        // Claim before IO, avoiding repeated reads from overlapping clients.
        let claimed = connection.execute(
            "UPDATE recent_sessions SET summary_retry_at_ms = ?2
             WHERE session_id = ?1 AND updated_at_ms = ?3 AND message_count IS NULL
               AND summary_retry_at_ms <= ?4",
            params![id, now + 3_600_000, updated_at, now],
        )?;
        if claimed == 0 {
            continue;
        }
        match legacy_summary(&id) {
            Ok(Some((summary, model, friendly_name))) => {
                // Never overwrite newer title/saved/activity metadata or a
                // summary written by persistence while the file was read.
                connection.execute(
                    "UPDATE recent_sessions SET first_prompt = ?2, preview = ?3,
                       model = ?4, message_count = ?5, friendly_name = ?6
                     WHERE session_id = ?1 AND updated_at_ms = ?7 AND message_count IS NULL
                       AND summary_retry_at_ms = ?8",
                    params![
                        id,
                        summary.first_prompt,
                        summary.preview,
                        model,
                        summary.message_count,
                        friendly_name,
                        updated_at,
                        now + 3_600_000
                    ],
                )?;
            }
            Ok(None) => {}
            Err(error) => crate::logging::warn(&format!(
                "Session metadata backfill failed for {id}: {error}"
            )),
        }
    }
    Ok(())
}

fn legacy_summary(
    id: &str,
) -> Result<Option<(ConversationSummary, Option<String>, Option<String>)>> {
    // IDs originate in the database, but never allow legacy data to escape
    // the sessions directory.
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Ok(None);
    }
    let path = crate::session::session_path(id)?;
    // A journal can supersede the snapshot. Do not fabricate a last-message
    // preview or count from an obsolete snapshot. Next persistence indexes it.
    let journal = crate::session::session_journal_path_from_snapshot(&path);
    match std::fs::metadata(journal) {
        Ok(meta) if meta.len() > 0 => return Ok(None),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
        _ => {}
    }
    const MAX_BYTES: u64 = 1024 * 1024;
    let metadata = std::fs::symlink_metadata(&path)?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Ok(None);
    }
    let file = std::fs::File::open(path)?;
    if !file.metadata()?.is_file() || file.metadata()?.len() > MAX_BYTES {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Ok(None);
    }
    #[derive(serde::Deserialize)]
    struct Snapshot {
        messages: Vec<StoredMessage>,
        model: Option<String>,
        short_name: Option<String>,
    }
    let snapshot: Snapshot = serde_json::from_slice(&bytes)?;
    Ok(Some((
        summarize(&snapshot.messages),
        snapshot.model,
        snapshot.short_name,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_title_uses_custom_then_todo_then_generated() {
        let mut entry = RecentSessionMetadata {
            session_id: "session_test".into(),
            working_dir: None,
            generated_title: Some("Generated".into()),
            custom_title: None,
            todo_title: Some("Todo goal".into()),
            saved: false,
            first_prompt: None,
            preview: None,
            model: None,
            message_count: None,
            friendly_name: None,
            updated_at_ms: 1,
            last_active_at_ms: None,
        };
        assert_eq!(entry.display_title(), Some("Todo goal"));
        entry.custom_title = Some("Renamed".into());
        assert_eq!(entry.display_title(), Some("Renamed"));
    }

    fn message(role: Role, text: &str) -> StoredMessage {
        serde_json::from_value(serde_json::json!({
            "id": "test", "role": role,
            "content": [{"type": "text", "text": text}]
        }))
        .unwrap()
    }

    #[test]
    fn summary_skips_system_scaffolding_tools_and_empty_prompts() {
        let mut system = message(Role::User, "hidden display role");
        system.display_role = Some(crate::session::StoredDisplayRole::System);
        let tool: StoredMessage = serde_json::from_value(serde_json::json!({
            "id": "tool", "role": "user", "content": [{
                "type": "tool_result", "tool_use_id": "call", "content": "secret output", "is_error": false
            }]
        })).unwrap();
        let messages = vec![
            message(Role::User, "<system-reminder>environment</system-reminder>"),
            system,
            message(Role::User, " \n\t"),
            message(Role::User, "[Scheduled task]\ninternal task"),
            message(
                Role::User,
                "<system-reminder>context</system-reminder>\n Fix   the build 🦀",
            ),
            tool,
            message(Role::Assistant, "Build fixed.\n All tests pass."),
            message(
                Role::User,
                "<system-reminder>tail scaffolding</system-reminder>",
            ),
        ];
        let summary = summarize(&messages);
        assert_eq!(summary.first_prompt.as_deref(), Some("Fix the build 🦀"));
        assert_eq!(
            summary.preview.as_deref(),
            Some("Build fixed. All tests pass.")
        );
        assert_eq!(summary.message_count, Some(2));
        let empty = summarize(&[message(Role::User, "   ")]);
        assert_eq!(empty.message_count, Some(0));
        assert!(empty.first_prompt.is_none());
        assert!(empty.preview.is_none());
    }

    #[test]
    fn summary_unicode_truncation_and_scan_budget() {
        let summary = summarize(&[message(Role::User, &"🦀".repeat(10000))]);
        assert_eq!(
            summary.first_prompt.unwrap(),
            format!("{}…", "🦀".repeat(80))
        );
        assert_eq!(summary.preview.unwrap(), format!("{}…", "🦀".repeat(200)));
        assert_eq!(summary.message_count, Some(1));
        let summary = summarize(&[message(Role::User, &format!("{}hidden", " ".repeat(10000)))]);
        assert_eq!(
            summary.message_count, None,
            "bounded prefix cannot prove an empty message"
        );
        assert!(summary.first_prompt.is_none());
    }

    #[test]
    fn title_precedence_ignores_blank_values_and_never_uses_friendly_name() {
        let mut entry = RecentSessionMetadata {
            custom_title: Some(" Custom ".into()),
            todo_title: Some("Todo".into()),
            generated_title: Some("Generated".into()),
            first_prompt: Some("Prompt".into()),
            friendly_name: Some("crab".into()),
            ..Default::default()
        };
        assert_eq!(entry.display_title(), Some("Custom"));
        entry.custom_title = Some(" \n ".into());
        assert_eq!(entry.display_title(), Some("Todo"));
        entry.todo_title = None;
        assert_eq!(entry.display_title(), Some("Generated"));
        entry.generated_title = None;
        assert_eq!(entry.display_title(), Some("Prompt"));
        entry.first_prompt = Some(" ".into());
        assert_eq!(entry.display_title(), None);
    }

    #[test]
    fn additive_migration_preserves_legacy_rows_and_unknown_summary() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE recent_sessions (
            session_id TEXT PRIMARY KEY NOT NULL, working_dir TEXT, generated_title TEXT,
            custom_title TEXT, todo_title TEXT, updated_at_ms INTEGER NOT NULL,
            last_active_at_ms INTEGER, saved INTEGER NOT NULL DEFAULT 0);
            INSERT INTO recent_sessions VALUES ('legacy', '/project', 'Generated', 'Custom', 'Todo', 123, 456, 1);").unwrap();
        initialize(&connection).unwrap();
        initialize(&connection).unwrap(); // idempotent
        let row = connection.query_row(
            "SELECT custom_title, saved, updated_at_ms, message_count, preview, summary_retry_at_ms FROM recent_sessions",
            [], |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?, row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, i64>(5)?))
        ).unwrap();
        assert_eq!(row, ("Custom".into(), true, 123, None, None, 0));
        let old = Connection::open_in_memory().unwrap();
        initialize(&old).unwrap();
        let saved: i64 = old
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('recent_sessions') WHERE name = 'saved'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(saved, 1);
    }

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
        let dir = tempfile::TempDir::new().unwrap();
        let previous = std::env::var_os("JCODE_HOME");
        crate::env::set_var("JCODE_HOME", dir.path());
        IsolatedHome {
            _dir: dir,
            previous,
            _guard: guard,
        }
    }

    #[test]
    fn upsert_session_roundtrips_summary_and_refreshes_without_losing_saved() {
        let _home = isolated_home();
        let mut session =
            Session::create_with_id("session_test".into(), None, Some("Generated".into()));
        session.messages = vec![
            message(Role::User, "First prompt"),
            message(Role::Assistant, "Last answer"),
        ];
        session.custom_title = Some("Renamed".into());
        session.model = Some("test-model".into());
        session.short_name = Some("crab".into());
        session.saved = true;
        upsert_session(&session).unwrap();
        let entry = recent(1).unwrap().pop().unwrap();
        assert_eq!(entry.display_title(), Some("Renamed"));
        assert_eq!(entry.first_prompt.as_deref(), Some("First prompt"));
        assert_eq!(entry.preview.as_deref(), Some("Last answer"));
        assert_eq!(entry.model.as_deref(), Some("test-model"));
        assert_eq!(entry.friendly_name.as_deref(), Some("crab"));
        assert_eq!(entry.message_count, Some(2));
        assert!(entry.saved);
        session.messages.push(message(Role::User, "Followup"));
        upsert_session(&session).unwrap();
        let entries = recent_with_backfill(20).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].preview.as_deref(), Some("Followup"));
        assert_eq!(entries[0].message_count, Some(3));
        assert!(entries[0].saved);
    }

    #[test]
    fn legacy_backfill_is_capped_retries_failures_and_preserves_metadata() {
        let home = isolated_home();
        std::fs::create_dir_all(home._dir.path().join("sessions")).unwrap();
        for i in 0..6 {
            let id = format!("session_legacy_{i}");
            upsert(&RecentSessionMetadata {
                session_id: id.clone(),
                saved: true,
                custom_title: Some("Keep title".into()),
                updated_at_ms: i,
                ..Default::default()
            })
            .unwrap();
            let snapshot = serde_json::json!({"messages": [message(Role::User, "Legacy prompt")], "model": "legacy-model", "short_name": "fox"});
            std::fs::write(
                crate::session::session_path(&id).unwrap(),
                serde_json::to_vec(&snapshot).unwrap(),
            )
            .unwrap();
        }
        let entries = recent_with_backfill(6).unwrap();
        assert_eq!(
            entries
                .iter()
                .filter(|e| e.message_count == Some(1))
                .count(),
            4
        );
        assert!(
            entries
                .iter()
                .all(|e| e.saved && e.display_title() == Some("Keep title"))
        );
        let entries = recent_with_backfill(6).unwrap();
        assert!(entries.iter().all(|e| e.message_count == Some(1)));
        assert!(
            entries
                .iter()
                .all(|e| e.preview.as_deref() == Some("Legacy prompt"))
        );

        let id = "session_oversize";
        upsert(&RecentSessionMetadata {
            session_id: id.into(),
            updated_at_ms: 10,
            ..Default::default()
        })
        .unwrap();
        let path = crate::session::session_path(id).unwrap();
        std::fs::File::create(&path)
            .unwrap()
            .set_len(2 * 1024 * 1024)
            .unwrap();
        assert!(legacy_summary(id).unwrap().is_none());
        assert!(recent_with_backfill(1).unwrap()[0].message_count.is_none());
        let retry: i64 = open()
            .unwrap()
            .query_row(
                "SELECT summary_retry_at_ms FROM recent_sessions WHERE session_id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(retry > chrono::Utc::now().timestamp_millis());
        std::fs::write(&path, r#"{"messages":[],"model":null,"short_name":null}"#).unwrap();
        assert!(
            recent_with_backfill(1).unwrap()[0].message_count.is_none(),
            "retry marker prevents repeated IO"
        );
        std::fs::write(
            crate::session::session_journal_path(id).unwrap(),
            "newer journal data",
        )
        .unwrap();
        assert!(
            legacy_summary(id).unwrap().is_none(),
            "do not summarize stale snapshots"
        );
        assert!(legacy_summary("../outside").unwrap().is_none());
        assert_eq!(recent(100).unwrap().len(), 7, "nothing deleted");
    }
}
