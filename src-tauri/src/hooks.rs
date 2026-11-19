//! Claude Code hooks -> dashboard.
//!
//! Each dashboard terminal launches `claude --settings <hooks.json>`, whose hooks run
//! `dashboard hook`. That mode (`run_client`) forwards the hook payload to the dashboard's
//! local HTTP listener (`start_server`), which turns it into a `hook` event for the UI.

use crate::transcript;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter};

pub const EVENTS: [&str; 9] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "Notification",
    "Stop",
    "SessionEnd",
];

/// `dashboard hook`: runs inside Claude's hook, reads the payload on stdin, forwards it.
/// Must never print to stdout (it can become model context) and must never fail loudly.
pub fn run_client() {
    let (Ok(port), Ok(token), Ok(term)) = (
        std::env::var("DASHBOARD_PORT"),
        std::env::var("DASHBOARD_TOKEN"),
        std::env::var("DASHBOARD_TERM_ID"),
    ) else {
        return; // Claude wasn't started from the dashboard
    };
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let payload: Value = serde_json::from_str(&input).unwrap_or(Value::Null);
    let body = json!({ "termId": term.parse::<u32>().unwrap_or(0), "payload": payload }).to_string();

    let Ok(addr) = format!("127.0.0.1:{port}").parse() else {
        return;
    };
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return;
    };
    let req = format!(
        "POST /hook HTTP/1.1\r\nHost: localhost\r\nx-dashboard-token: {token}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = s.write_all(req.as_bytes());
    let _ = s.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = s.read(&mut [0u8; 64]);
}

#[derive(Default)]
struct Tracked {
    path: Option<PathBuf>,
    parent_resolved: bool,
    checks: u8,
    term_id: u32,
    last_seen: u64,
    /// Description of the most recent `Agent` tool call; names the subagent that starts next.
    pending_agent: Option<String>,
}

type Tracker = Arc<Mutex<HashMap<String, Tracked>>>;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HookEvent {
    term_id: u32,
    event: String,
    session_id: String,
    source: Option<String>,
    status: &'static str,
    name: Option<String>,
    parent_session_id: Option<String>,
    /// Set when the event comes from a subagent rather than the session itself.
    agent_id: Option<String>,
    agent_type: Option<String>,
    agent_name: Option<String>,
    /// On Stop / SubagentStop: the session's background work (subagents and shell tasks).
    background_tasks: Option<Vec<BgTask>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BgTask {
    id: String,
    /// "subagent" or "shell"
    kind: String,
    status: String,
    description: Option<String>,
    agent_type: Option<String>,
}

/// Starts the local listener and returns its port.
pub fn start_server(app: AppHandle, token: String) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind hook listener");
    let port = listener.local_addr().expect("listener addr").port();
    let tracker: Tracker = Arc::new(Mutex::new(HashMap::new()));
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (app, token, tracker) = (app.clone(), token.clone(), tracker.clone());
            thread::spawn(move || handle(stream, &app, &token, &tracker));
        }
    });
    port
}

fn handle(mut stream: TcpStream, app: &AppHandle, token: &str, tracker: &Tracker) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let Ok(clone) = stream.try_clone() else { return };
    let mut reader = BufReader::new(clone);
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let (mut len, mut authed) = (0usize, false);
    loop {
        line.clear();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
            if k == "content-length" {
                len = v.parse().unwrap_or(0);
            } else if k == "x-dashboard-token" && v == token {
                authed = true;
            }
        }
    }
    let mut body = vec![0u8; len.min(1 << 20)];
    if reader.read_exact(&mut body).is_err() {
        return;
    }
    let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
    if authed {
        process(app, tracker, &body);
    }
}

fn process(app: &AppHandle, tracker: &Tracker, body: &[u8]) {
    // Opt-in debugging: DASHBOARD_LOG=/some/file appends every raw hook payload (prompts included).
    if let Some(path) = std::env::var_os("DASHBOARD_LOG") {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{}", String::from_utf8_lossy(body));
        }
    }
    let Ok(v) = serde_json::from_slice::<Value>(body) else { return };
    let term_id = v["termId"].as_u64().unwrap_or(0) as u32;
    let p = &v["payload"];
    let get = |k: &str| p[k].as_str().map(str::to_string);
    let (Some(event), Some(session_id)) = (get("hook_event_name"), get("session_id")) else {
        return;
    };
    let path = get("transcript_path").map(PathBuf::from);
    let agent_id = get("agent_id");
    let agent_type = get("agent_type");
    let background_tasks = p["background_tasks"].as_array().map(|list| {
        list.iter()
            .filter_map(|b| {
                Some(BgTask {
                    id: b["id"].as_str()?.to_string(),
                    kind: b["type"].as_str().unwrap_or("").to_string(),
                    status: b["status"].as_str().unwrap_or("").to_string(),
                    description: b["description"].as_str().map(str::to_string),
                    agent_type: b["agent_type"].as_str().map(str::to_string),
                })
            })
            .collect::<Vec<_>>()
    });
    let status = match event.as_str() {
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "SubagentStart" => "working",
        "SubagentStop" => "done",
        "Notification" => "waiting",
        "SessionEnd" => "ended",
        _ => "idle",
    };

    // Decide whether this session still needs a parent lookup (and against whom).
    let (first, candidates, prefer, agent_name) = {
        let mut map = tracker.lock().unwrap();
        let first = !map.contains_key(&session_id);
        let stamp = map.values().map(|t| t.last_seen).max().unwrap_or(0) + 1;
        // The session this terminal was running before this one: the likeliest fork parent.
        let prefer = map
            .iter()
            .filter(|(k, t)| **k != session_id && t.term_id == term_id)
            .max_by_key(|(_, t)| t.last_seen)
            .map(|(k, _)| k.clone());
        // Subagent events share the session's id and transcript, so they never need a parent lookup.
        let need = agent_id.is_none()
            && map.get(&session_id).map_or(true, |t| !t.parent_resolved && t.checks < 3);
        let cands: Vec<(String, PathBuf)> = if need {
            map.iter()
                .filter(|(k, _)| **k != session_id)
                .filter_map(|(k, t)| t.path.clone().map(|p| (k.clone(), p)))
                .collect()
        } else {
            vec![]
        };
        let t = map.entry(session_id.clone()).or_default();
        if path.is_some() {
            t.path = path.clone();
        }
        t.term_id = term_id;
        t.last_seen = stamp;
        // The Agent tool call announces the subagent's description just before it starts.
        if event == "PreToolUse" && matches!(get("tool_name").as_deref(), Some("Agent" | "Task")) {
            if let Some(d) = p["tool_input"]["description"].as_str() {
                t.pending_agent = Some(d.to_string());
            }
        }
        let agent_name = if event == "SubagentStart" { t.pending_agent.take() } else { None };
        (first, if need { Some(cands) } else { None }, prefer, agent_name)
    };

    let name = if agent_id.is_some() {
        None
    } else {
        path.as_deref()
            .and_then(|p| transcript::title(p, if first { 64 << 20 } else { 1 << 20 }))
    };

    let mut parent = None;
    if let (Some(cands), Some(p)) = (candidates, path.as_deref()) {
        if let Some(result) = transcript::find_parent(p, &cands, prefer.as_deref()) {
            let mut map = tracker.lock().unwrap();
            if let Some(t) = map.get_mut(&session_id) {
                t.checks += 1;
                if result.is_some() {
                    t.parent_resolved = true;
                }
            }
            parent = result;
        }
    }

    let _ = app.emit(
        "hook",
        HookEvent {
            term_id,
            event,
            session_id,
            source: get("source"),
            status,
            name,
            parent_session_id: parent,
            agent_id,
            agent_type,
            agent_name,
            background_tasks,
        },
    );
}
