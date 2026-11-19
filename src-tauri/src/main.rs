#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hooks;
mod transcript;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use std::{
    collections::{hash_map::RandomState, HashMap},
    hash::{BuildHasher, Hasher},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex,
    },
    thread,
};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Emitter, Manager, State,
};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
struct Sessions {
    next_id: AtomicU32,
    map: Mutex<HashMap<u32, Session>>,
}

/// Fixed for the life of the app.
struct AppState {
    workspace: PathBuf,
    port: u16,
    token: String,
    settings_path: PathBuf,
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

#[tauri::command]
fn get_workspace(cfg: State<'_, AppState>) -> String {
    cfg.workspace.to_string_lossy().into_owned()
}

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<'_, Sessions>,
    cfg: State<'_, AppState>,
    cols: u16,
    rows: u16,
    claude: bool,
    resume: Option<String>,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    // The id ends up on a shell command line, so only accept what a session id can contain.
    if let Some(id) = &resume {
        if id.len() < 8 || id.len() > 64 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            return Err(format!("invalid session id: {id}"));
        }
    }
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);

    let mut cmd = CommandBuilder::new(default_shell());
    // If the dashboard itself was started from inside a Claude session, don't let its
    // session markers leak in: every dashboard terminal should be a fresh top-level session.
    for var in [
        "CLAUDECODE",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_SESSION_ATTENDED",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_EXECPATH",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_PID",
        "DASHBOARD_FOREGROUND", // so `dashboard` run inside a terminal still detaches
    ] {
        cmd.env_remove(var);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("DASHBOARD_TERM_ID", id.to_string());
    cmd.env("DASHBOARD_PORT", cfg.port.to_string());
    cmd.env("DASHBOARD_TOKEN", &cfg.token);
    cmd.cwd(&cfg.workspace);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // It's a normal shell; we just type `claude` into it so that exiting Claude drops back
    // to the prompt like any terminal.
    if claude {
        let resume = resume.map(|id| format!("--resume {id} ")).unwrap_or_default();
        let line = format!("claude {resume}--settings \"{}\"\r", cfg.settings_path.display());
        writer.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    }

    thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = app.emit("pty-exit", id);
    });

    state
        .map
        .lock()
        .unwrap()
        .insert(id, Session { master: pair.master, writer, child });
    Ok(id)
}

#[tauri::command]
fn pty_write(state: State<'_, Sessions>, id: u32, data: String) -> Result<(), String> {
    let mut map = state.map.lock().unwrap();
    let s = map.get_mut(&id).ok_or("no such session")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(state: State<'_, Sessions>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.map.lock().unwrap();
    let s = map.get(&id).ok_or("no such session")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_kill(state: State<'_, Sessions>, id: u32) {
    if let Some(mut s) = state.map.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
}

/// 64-bit FNV-1a. Stable across Rust versions (unlike `DefaultHasher`), so state files keep their names.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3))
}

/// Where this folder's remembered sessions live (one file per workspace).
fn state_file(app: &AppHandle, workspace: &Path) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("workspaces");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{:016x}.json", fnv1a(workspace.to_string_lossy().as_bytes()))))
}

#[tauri::command]
fn load_state(app: AppHandle, cfg: State<'_, AppState>) -> Option<String> {
    std::fs::read_to_string(state_file(&app, &cfg.workspace).ok()?).ok()
}

#[tauri::command]
fn save_state(app: AppHandle, cfg: State<'_, AppState>, json: String) -> Result<(), String> {
    let path = state_file(&app, &cfg.workspace)?;
    // Write-then-rename so a crash mid-write can't leave a half-written file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

const USAGE: &str = "dashboard: run and watch many Claude Code terminals

Usage: dashboard [folder]

  folder    Directory the terminals open in (default: the current directory).
            Sessions started here are remembered per folder.

Options:
  -h, --help       Show this help
  -V, --version    Show the version";

/// In release builds on Unix, hand off to a detached copy and return the shell prompt, like any
/// GUI launcher. (Windows release builds are GUI-subsystem and don't hold the console.)
#[cfg(all(unix, not(debug_assertions)))]
fn detach_from_shell(workspace: &Path) {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    if std::env::var_os("DASHBOARD_FOREGROUND").is_some() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    let spawned = Command::new(exe)
        .arg(workspace)
        .env("DASHBOARD_FOREGROUND", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn();
    if spawned.is_ok() {
        std::process::exit(0);
    }
}

#[cfg(not(all(unix, not(debug_assertions))))]
fn detach_from_shell(_workspace: &Path) {}

/// `dashboard [dir]`: the first non-flag argument is the folder terminals run in.
fn resolve_workspace() -> PathBuf {
    let arg = std::env::args().skip(1).find(|a| !a.starts_with('-'));
    let base = match arg {
        Some(a) => PathBuf::from(a),
        None => std::env::current_dir().unwrap_or_default(),
    };
    let path = base.canonicalize().unwrap_or_else(|_| base.clone());
    if !path.is_dir() {
        eprintln!("dashboard: not a directory: {}", base.display());
        std::process::exit(1);
    }
    // Windows canonicalize() returns \\?\ paths, which shells dislike.
    match path.to_string_lossy().strip_prefix(r"\\?\") {
        Some(p) => PathBuf::from(p),
        None => path,
    }
}

/// Settings passed to `claude --settings`; they only add our hooks and leave the
/// user's own settings alone.
fn write_settings(exe: &Path) -> PathBuf {
    let dir = std::env::temp_dir().join("claude-terminal-flow");
    let _ = std::fs::create_dir_all(&dir);
    let hook = json!([{ "hooks": [{ "type": "command", "command": format!("\"{}\" hook", exe.display()) }] }]);
    let mut hooks = serde_json::Map::new();
    for ev in hooks::EVENTS {
        hooks.insert(ev.into(), hook.clone());
    }
    let path = dir.join("hooks.json");
    let _ = std::fs::write(&path, json!({ "hooks": hooks }).to_string());
    path
}

fn random_token() -> String {
    let s = RandomState::new();
    let (mut a, mut b) = (s.build_hasher(), s.build_hasher());
    a.write_u32(std::process::id());
    b.write_u8(1);
    format!("{:016x}{:016x}", a.finish(), b.finish())
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("hook") {
        hooks::run_client();
        return;
    }

    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        println!("{USAGE}");
        return;
    }
    if args.iter().any(|a| a == "-V" || a == "--version") {
        println!("dashboard {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let workspace = resolve_workspace();
    detach_from_shell(&workspace);

    tauri::Builder::default()
        .manage(Sessions::default())
        .setup(move |app| {
            let token = random_token();
            let port = hooks::start_server(app.handle().clone(), token.clone());
            let exe = std::env::current_exe()?;
            app.manage(AppState {
                settings_path: write_settings(&exe),
                workspace: workspace.clone(),
                port,
                token,
            });
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title(&format!("Dashboard — {}", workspace.display()));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_workspace,
            load_state,
            save_state,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
