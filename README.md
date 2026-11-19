# claude-terminal-flow

A dashboard for running many [Claude Code](https://claude.com/claude-code) terminals at once and seeing how they relate.

- **Real terminals.** Each one is a normal shell (xterm.js on a PTY) with `claude` started in it.
- **One box per session.** Shows the session name and a live status: working, idle, needs you, ended.
- **Fork lineage.** `/branch` and `--fork-session` produce a child box with an arrow from its parent, laid out top to bottom.
- **Background work.** Subagents and background shell tasks (e.g. `sleep 60`) appear as dashed children of the session that started them.
- **Tabs.** Up to 3 terminals sit in the top bar; opening a 4th evicts the least recently used. Evicted terminals keep running and stay on the dashboard.
- **Right-click → Remove** archives a session and everything forked from it (dashboard only; transcripts are untouched, so `claude --resume` still works).

Built with [Tauri 2](https://tauri.app) (Rust: `portable-pty`) and TypeScript (Vite, xterm.js).

## Run

Prerequisites: Node, Rust, and the [Tauri system dependencies](https://tauri.app/start/prerequisites/). `claude` must be on your `PATH`.

```sh
npm install
npm run tauri dev -- -- ~/some/folder   # terminals open in this folder (default: current directory)
```

Release build, giving a `dashboard` binary you can put on your `PATH`:

```sh
npm run tauri build -- --no-bundle
./src-tauri/target/release/dashboard ~/some/folder
```

## How it works

Each terminal launches `claude --settings <hooks.json>`. Those settings only add hooks, so your own settings are left alone. The hooks run `dashboard hook`, which forwards each event to a local HTTP listener (127.0.0.1, random port, per-run token). The listener turns events into UI updates.

- **Status** comes from hook events (`UserPromptSubmit`, `Stop`, `Notification`, `SubagentStart`, ...).
- **Names** come from the session transcript (`/rename`, then the auto-generated title).
- **Fork parents** are found by matching message uuids between transcripts, because a fork starts as a copy of its parent.
- **Background tasks** come from the `background_tasks` list that Claude reports on `Stop`.

## Shortcuts

| Key | Action |
| --- | --- |
| `Ctrl+T` | New Claude terminal |
| `Ctrl+W` | Close tab (the terminal keeps running) |
| `Ctrl+Shift+D` | Back to the dashboard |
| `Alt+1`..`Alt+3` | Jump to that tab |

These are handled by the app, so they no longer reach the terminal. Notably `Ctrl+W` (delete word) and `Ctrl+T`.

## Debugging

`DASHBOARD_LOG=/path/to/file` appends every raw hook payload, prompts included, to that file.

## Status

Developed and tested on Linux. Windows and macOS are untested.
