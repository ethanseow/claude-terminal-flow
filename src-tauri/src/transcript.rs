//! Helpers for reading Claude Code session transcripts (`~/.claude/projects/**/<session>.jsonl`).

use serde_json::Value;
use std::{
    cmp::Reverse,
    collections::HashSet,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

/// Reads the last `max` bytes of a file as text, dropping a partial first line.
fn read_tail(path: &Path, max: u64) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(max);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        Some(text.split_once('\n').map(|x| x.1.to_string()).unwrap_or_default())
    } else {
        Some(text)
    }
}

fn field(line: &str, key: &str) -> Option<String> {
    let v: Value = serde_json::from_str(line).ok()?;
    let s = v.get(key)?.as_str()?.trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// Session display name. Priority: `/rename` title > agent name > auto-generated title.
pub fn title(path: &Path, max_bytes: u64) -> Option<String> {
    let text = read_tail(path, max_bytes)?;
    let (mut custom, mut agent, mut ai) = (None, None, None);
    for line in text.lines().rev() {
        if !line.starts_with("{\"type\":\"") {
            continue;
        }
        if custom.is_none() && line.starts_with("{\"type\":\"custom-title\"") {
            custom = field(line, "customTitle");
            if custom.is_some() {
                break;
            }
        } else if agent.is_none() && line.starts_with("{\"type\":\"agent-name\"") {
            agent = field(line, "agentName").filter(|n| n != "local-command-caveat");
        } else if ai.is_none() && line.starts_with("{\"type\":\"ai-title\"") {
            ai = field(line, "aiTitle");
        }
    }
    custom.or(agent).or(ai)
}

/// Collects message uuids from a transcript (cheap substring scan, no full JSON parse).
fn uuids(path: &Path, limit: usize) -> HashSet<String> {
    let mut out = HashSet::new();
    let Ok(text) = std::fs::read_to_string(path) else {
        return out;
    };
    const KEY: &str = "\"uuid\":\"";
    for (i, _) in text.match_indices(KEY) {
        let s = i + KEY.len();
        if let Some(id) = text.get(s..s + 36) {
            out.insert(id.to_string());
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}

/// A forked session starts as a copy of its parent's messages, with identical uuids.
/// The parent is the known session sharing the most uuids with `new_path`.
///
/// Returns `None` if the transcript isn't ready to judge yet, `Some(None)` if it has no
/// parent among `candidates`, and `Some(Some(session_id))` if a parent was found.
///
/// Siblings forked from the same parent tie on overlap with the parent (a sibling is the parent
/// plus a few entries of its own). Ties go to the candidate with the fewest extra messages, since
/// the true parent is a clean prefix of the fork, then to `prefer` (the session this terminal was
/// just running).
pub fn find_parent(
    new_path: &Path,
    candidates: &[(String, PathBuf)],
    prefer: Option<&str>,
) -> Option<Option<String>> {
    let mine = uuids(new_path, 5000);
    if mine.len() < 2 {
        return None;
    }
    let mut best: Option<((usize, Reverse<usize>, bool), &String)> = None;
    for (sid, path) in candidates {
        let theirs = uuids(path, usize::MAX);
        let shared = mine.iter().filter(|u| theirs.contains(*u)).count();
        if shared < 2 {
            continue;
        }
        let key = (shared, Reverse(theirs.len()), prefer == Some(sid.as_str()));
        if best.as_ref().map_or(true, |(k, _)| key > *k) {
            best = Some((key, sid));
        }
    }
    Some(best.map(|(_, sid)| sid.clone()))
}
