#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, fs, sync::Mutex};
use tauri::{AppHandle, Manager, State};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

const MIGRATION: &str = include_str!("../../../../packages/schema/migrations/0001_initial.sql");

struct DbState {
    connection: Mutex<Connection>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Note {
    id: String,
    user_id: Option<String>,
    title: String,
    body: String,
    body_format: String,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
    version: i64,
    device_id: String,
    sync_status: String,
    is_conflict_copy: bool,
    conflict_source_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Tag {
    id: String,
    name: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteWithTags {
    #[serde(flatten)]
    note: Note,
    tags: Vec<Tag>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncSummary {
    pending_count: i64,
    failed_count: i64,
    last_synced_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateNoteInput {
    title: String,
    body: String,
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn create_id(prefix: &str) -> String {
    format!("{}_{}", prefix, Uuid::new_v4())
}

fn normalize_title(title: &str, body: &str) -> String {
    let trimmed = title.trim();

    if !trimmed.is_empty() {
        return trimmed.to_string();
    }

    body.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(80).collect())
        .unwrap_or_else(|| "無題のノート".to_string())
}

fn normalize_tag_name(name: &str) -> String {
    name.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn unique_tag_names(input: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut names = Vec::new();

    for name in input.split(',').map(normalize_tag_name).filter(|name| !name.is_empty()) {
        let key = name.to_lowercase();

        if seen.insert(key) {
            names.push(name);
        }
    }

    names
}

fn get_device_id(connection: &Connection) -> Result<String, String> {
    let existing = connection
        .query_row("SELECT value FROM app_meta WHERE key = 'device_id'", [], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|error| error.to_string())?;

    if let Some(device_id) = existing {
        return Ok(device_id);
    }

    let device_id = create_id("device");
    connection
        .execute(
            "INSERT INTO app_meta (key, value) VALUES ('device_id', ?1)",
            params![device_id],
        )
        .map_err(|error| error.to_string())?;

    Ok(connection
        .query_row("SELECT value FROM app_meta WHERE key = 'device_id'", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?)
}

fn row_to_note(row: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get("id")?,
        user_id: row.get("user_id")?,
        title: row.get("title")?,
        body: row.get("body")?,
        body_format: row.get("body_format")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
        device_id: row.get("device_id")?,
        sync_status: row.get("sync_status")?,
        is_conflict_copy: row.get::<_, i64>("is_conflict_copy")? != 0,
        conflict_source_id: row.get("conflict_source_id")?,
    })
}

fn list_tags_for_note(connection: &Connection, note_id: &str) -> Result<Vec<Tag>, String> {
    let mut statement = connection
        .prepare(
            "SELECT t.id, t.name, t.created_at, t.updated_at
             FROM tags t
             JOIN note_tags nt ON nt.tag_id = t.id
             WHERE nt.note_id = ?1
             ORDER BY t.name COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;

    let tags = statement
        .query_map(params![note_id], |row| {
            Ok(Tag {
                id: row.get("id")?,
                name: row.get("name")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    Ok(tags)
}

fn enqueue_sync_event(
    connection: &Connection,
    event_type: &str,
    entity_type: &str,
    entity_id: &str,
    payload: Value,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO sync_events
             (id, type, entity_id, entity_type, payload, status, created_at, sent_at, error)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, NULL, NULL)",
            params![
                create_id("sync"),
                event_type,
                entity_id,
                entity_type,
                payload.to_string(),
                now_iso()
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn init_database(app: &AppHandle) -> Result<Connection, String> {
    let app_data_dir = app
        .path_resolver()
        .app_data_dir()
        .ok_or_else(|| "アプリデータディレクトリを取得できませんでした。".to_string())?;

    fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
    let db_path = app_data_dir.join("shiori.sqlite");
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(MIGRATION)
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

#[tauri::command]
fn list_notes(
    state: State<'_, DbState>,
    query: String,
    tag_id: Option<String>,
) -> Result<Vec<NoteWithTags>, String> {
    let connection = state.connection.lock().map_err(|error| error.to_string())?;
    let search = format!("%{}%", query.trim().to_lowercase());

    let mut statement = connection
        .prepare(
            "SELECT *
             FROM notes n
             WHERE n.deleted_at IS NULL
               AND (?1 = '' OR lower(n.title) LIKE ?2 OR lower(n.body) LIKE ?2)
               AND (?3 IS NULL OR EXISTS (
                 SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag_id = ?3
               ))
             ORDER BY n.updated_at DESC",
        )
        .map_err(|error| error.to_string())?;

    let notes = statement
        .query_map(params![query.trim(), search, tag_id], row_to_note)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    notes
        .into_iter()
        .map(|note| {
            let tags = list_tags_for_note(&connection, &note.id)?;
            Ok(NoteWithTags { note, tags })
        })
        .collect()
}

#[tauri::command]
fn list_tags(state: State<'_, DbState>) -> Result<Vec<Tag>, String> {
    let connection = state.connection.lock().map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare("SELECT id, name, created_at, updated_at FROM tags ORDER BY name COLLATE NOCASE")
        .map_err(|error| error.to_string())?;

    let tags = statement
        .query_map([], |row| {
            Ok(Tag {
                id: row.get("id")?,
                name: row.get("name")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    Ok(tags)
}

#[tauri::command]
fn create_note(state: State<'_, DbState>) -> Result<NoteWithTags, String> {
    let connection = state.connection.lock().map_err(|error| error.to_string())?;
    let at = now_iso();
    let note = Note {
        id: create_id("note"),
        user_id: None,
        title: "無題のノート".to_string(),
        body: String::new(),
        body_format: "markdown".to_string(),
        created_at: at.clone(),
        updated_at: at,
        deleted_at: None,
        version: 1,
        device_id: get_device_id(&connection)?,
        sync_status: "pending".to_string(),
        is_conflict_copy: false,
        conflict_source_id: None,
    };
    let payload = serde_json::to_value(&note).map_err(|error| error.to_string())?;

    connection
        .execute(
            "INSERT INTO notes
             (id, user_id, title, body, body_format, created_at, updated_at, deleted_at, version,
              device_id, sync_status, is_conflict_copy, conflict_source_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                &note.id,
                &note.user_id,
                &note.title,
                &note.body,
                &note.body_format,
                &note.created_at,
                &note.updated_at,
                &note.deleted_at,
                note.version,
                &note.device_id,
                &note.sync_status,
                note.is_conflict_copy as i64,
                &note.conflict_source_id
            ],
        )
        .map_err(|error| error.to_string())?;

    enqueue_sync_event(&connection, "note.created", "note", &note.id, payload)?;

    Ok(NoteWithTags { note, tags: vec![] })
}

#[tauri::command]
fn update_note(
    state: State<'_, DbState>,
    id: String,
    input: UpdateNoteInput,
) -> Result<Note, String> {
    let connection = state.connection.lock().map_err(|error| error.to_string())?;
    let existing = connection
        .query_row("SELECT * FROM notes WHERE id = ?1", params![id], row_to_note)
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "保存対象のノートが見つかりません。".to_string())?;

    let note = Note {
        title: normalize_title(&input.title, &input.body),
        body: input.body,
        updated_at: now_iso(),
        version: existing.version + 1,
        sync_status: "pending".to_string(),
        ..existing
    };
    let payload = serde_json::to_value(&note).map_err(|error| error.to_string())?;

    connection
        .execute(
            "UPDATE notes
             SET title = ?2, body = ?3, updated_at = ?4, version = ?5, sync_status = 'pending'
             WHERE id = ?1",
            params![&note.id, &note.title, &note.body, &note.updated_at, note.version],
        )
        .map_err(|error| error.to_string())?;

    enqueue_sync_event(&connection, "note.updated", "note", &note.id, payload)?;
    Ok(note)
}

#[tauri::command]
fn soft_delete_note(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let connection = state.connection.lock().map_err(|error| error.to_string())?;
    let existing = connection
        .query_row("SELECT * FROM notes WHERE id = ?1", params![id], row_to_note)
        .optional()
        .map_err(|error| error.to_string())?;

    let Some(existing) = existing else {
        return Ok(());
    };

    let deleted_at = now_iso();
    connection
        .execute(
            "UPDATE notes
             SET deleted_at = ?2, updated_at = ?2, version = ?3, sync_status = 'pending'
             WHERE id = ?1",
            params![&existing.id, &deleted_at, existing.version + 1],
        )
        .map_err(|error| error.to_string())?;

    let payload = serde_json::json!({
        "id": &existing.id,
        "deletedAt": &deleted_at
    });
    enqueue_sync_event(&connection, "note.deleted", "note", &existing.id, payload)
}

#[tauri::command]
fn set_note_tags(state: State<'_, DbState>, note_id: String, input: String) -> Result<Vec<Tag>, String> {
    let connection = state.connection.lock().map_err(|error| error.to_string())?;
    let names = unique_tag_names(&input);
    let at = now_iso();
    let mut tags = Vec::new();

    for name in names {
        let existing = connection
            .query_row(
                "SELECT id, name, created_at, updated_at FROM tags WHERE lower(name) = lower(?1)",
                params![name],
                |row| {
                    Ok(Tag {
                        id: row.get("id")?,
                        name: row.get("name")?,
                        created_at: row.get("created_at")?,
                        updated_at: row.get("updated_at")?,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;

        let tag = match existing {
            Some(tag) => tag,
            None => {
                let tag = Tag {
                    id: create_id("tag"),
                    name,
                    created_at: at.clone(),
                    updated_at: at.clone(),
                };
                connection
                    .execute(
                        "INSERT INTO tags (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
                        params![&tag.id, &tag.name, &tag.created_at, &tag.updated_at],
                    )
                    .map_err(|error| error.to_string())?;
                tag
            }
        };

        tags.push(tag);
    }

    connection
        .execute("DELETE FROM note_tags WHERE note_id = ?1", params![&note_id])
        .map_err(|error| error.to_string())?;

    for tag in &tags {
        connection
            .execute(
                "INSERT INTO note_tags (note_id, tag_id, created_at) VALUES (?1, ?2, ?3)",
                params![&note_id, &tag.id, now_iso()],
            )
            .map_err(|error| error.to_string())?;
    }

    let payload = serde_json::json!({
        "noteId": &note_id,
        "tags": tags.iter().map(|tag| tag.name.clone()).collect::<Vec<_>>()
    });
    enqueue_sync_event(&connection, "tags.updated", "note", &note_id, payload)?;

    Ok(tags)
}

#[tauri::command]
fn get_sync_summary(state: State<'_, DbState>) -> Result<SyncSummary, String> {
    let connection = state.connection.lock().map_err(|error| error.to_string())?;
    let pending_count = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_events WHERE status IN ('pending', 'syncing')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let failed_count = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_events WHERE status = 'failed'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let last_synced_at = connection
        .query_row(
            "SELECT value FROM app_meta WHERE key = 'last_synced_at'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;

    Ok(SyncSummary {
        pending_count,
        failed_count,
        last_synced_at,
    })
}

#[tauri::command]
fn mark_all_synced(state: State<'_, DbState>) -> Result<SyncSummary, String> {
    let connection = state.connection.lock().map_err(|error| error.to_string())?;
    let at = now_iso();
    connection
        .execute(
            "UPDATE sync_events SET status = 'sent', sent_at = ?1, error = NULL WHERE status != 'sent'",
            params![&at],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute("UPDATE notes SET sync_status = 'synced' WHERE sync_status != 'synced'", [])
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO app_meta (key, value) VALUES ('last_synced_at', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![&at],
        )
        .map_err(|error| error.to_string())?;

    drop(connection);
    get_sync_summary(state)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let connection = init_database(&app.handle()).expect("failed to initialize SQLite");
            app.manage(DbState {
                connection: Mutex::new(connection),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_notes,
            list_tags,
            create_note,
            update_note,
            soft_delete_note,
            set_note_tags,
            get_sync_summary,
            mark_all_synced
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Shiori");
}
