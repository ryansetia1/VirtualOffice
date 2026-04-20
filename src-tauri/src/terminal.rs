use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use once_cell::sync::Lazy;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    #[allow(dead_code)]
    child: Box<dyn Child + Send + Sync>,
}

static SESSIONS: Lazy<Mutex<HashMap<String, Session>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Single streamed payload. Using a tagged enum via `kind` field so the JS
/// side can easily discriminate:
///   { "kind": "ready" }
///   { "kind": "data", "data_b64": "..." }
///   { "kind": "exit" }
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PtyMsg {
    Ready,
    Data { data_b64: String },
    Exit,
}

fn pick_shell() -> (String, Vec<String>) {
    #[cfg(target_os = "windows")]
    {
        return ("cmd.exe".to_string(), vec![]);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else {
                "/bin/bash".to_string()
            }
        });
        // Login + interactive so .zprofile/.zshrc load and a prompt is emitted.
        (shell, vec!["-l".to_string(), "-i".to_string()])
    }
}

#[tauri::command]
pub fn pty_spawn(
    session_id: String,
    cwd: String,
    cols: Option<u16>,
    rows: Option<u16>,
    on_message: Channel<PtyMsg>,
) -> Result<(), String> {
    let mut map = SESSIONS.lock().map_err(|e| e.to_string())?;
    if map.contains_key(&session_id) {
        return Err(format!("session '{}' already exists", session_id));
    }

    let pty_system = native_pty_system();
    let size = PtySize {
        rows: rows.unwrap_or(30),
        cols: cols.unwrap_or(100),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("openpty failed: {}", e))?;

    let (shell, args) = pick_shell();
    let mut cmd = CommandBuilder::new(shell);
    for a in args {
        cmd.arg(a);
    }
    cmd.cwd(&cwd);
    // Mark as coming from Virtual Office for user scripts.
    cmd.env("VIRTUAL_OFFICE_AGENT", "1");
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {}", e))?;

    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader failed: {}", e))?;

    // Notify the UI that the channel is plumbed (so we can distinguish
    // "PTY backend is alive but shell hasn't emitted yet" from a dead channel).
    let _ = on_message.send(PtyMsg::Ready);

    let on_msg_for_thread = on_message.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data_b64 = B64.encode(&buf[..n]);
                    if on_msg_for_thread
                        .send(PtyMsg::Data { data_b64 })
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = on_msg_for_thread.send(PtyMsg::Exit);
    });

    map.insert(
        session_id,
        Session {
            master: pair.master,
            writer,
            child,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn pty_write(session_id: String, data_b64: String) -> Result<(), String> {
    let mut map = SESSIONS.lock().map_err(|e| e.to_string())?;
    let session = map
        .get_mut(&session_id)
        .ok_or_else(|| format!("no session '{}'", session_id))?;
    let bytes = B64.decode(&data_b64).map_err(|e| e.to_string())?;
    session.writer.write_all(&bytes).map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = SESSIONS.lock().map_err(|e| e.to_string())?;
    let session = map
        .get(&session_id)
        .ok_or_else(|| format!("no session '{}'", session_id))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(session_id: String) -> Result<(), String> {
    let mut map = SESSIONS.lock().map_err(|e| e.to_string())?;
    if let Some(mut s) = map.remove(&session_id) {
        let _ = s.child.kill();
        let _ = s.writer.flush();
    }
    Ok(())
}
