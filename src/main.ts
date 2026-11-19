import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Graph, SessionNode, Status } from "./graph";
import { TermTab } from "./term";
import { enablePan } from "./pan";

interface HookEvent {
  termId: number;
  event: string;
  sessionId: string;
  source: string | null;
  status: Exclude<Status, "starting" | "exited" | "saved">;
  name: string | null;
  parentSessionId: string | null;
  /** Present when the event comes from a subagent of `sessionId`. */
  agentId: string | null;
  agentType: string | null;
  agentName: string | null;
  /** On Stop / SubagentStop: everything the session still has running in the background. */
  backgroundTasks: BgTask[] | null;
}

interface BgTask {
  id: string;
  kind: string; // "subagent" | "shell"
  status: string;
  description: string | null;
  agentType: string | null;
}

/** Terminals shown as tabs in the top bar. Others keep running and stay reachable from the dashboard. */
const MAX_TABS = 3;

const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
const dashEl = $<HTMLElement>("#dash");
const termsEl = $<HTMLElement>("#terms");
const tabsEl = $<HTMLElement>("#tabs");
const dashTab = $<HTMLButtonElement>("#tab-dash");

const nodes = new Map<string, SessionNode>();
const tabs = new Map<number, TermTab>();
/** Which session each terminal is currently running. */
const current = new Map<number, string>();
/** Terminals currently shown in the top bar, in the order they were opened. */
let barTabs: number[] = [];
/** Last time the user touched each terminal (switched to it or typed in it). */
const lastUsed = new Map<number, number>();
let clock = 0;
let seq = 0;
let active: TermTab | null = null;

const touch = (termId: number) => lastUsed.set(termId, ++clock);

const graph = new Graph(
  $("#nodes"),
  $<SVGGElement>("#edge-paths"),
  $<SVGSVGElement>("#edges"),
  $("#empty"),
  (n) => openNode(n),
  (n, x, y) => showMenu(n, x, y),
);
const pan = enablePan(dashEl, $("#canvas"));

/** Puts a terminal in the bar, evicting the least recently used tab if the bar is full. */
function ensureInBar(termId: number) {
  if (barTabs.includes(termId)) return;
  while (barTabs.length >= MAX_TABS) {
    const victim = barTabs.reduce((a, b) => ((lastUsed.get(a) ?? 0) <= (lastUsed.get(b) ?? 0) ? a : b));
    barTabs = barTabs.filter((id) => id !== victim);
  }
  barTabs.push(termId);
}

/** A session plus everything forked from it, at any depth. */
function subtreeIds(rootId: string): string[] {
  const out = [rootId];
  for (let i = 0; i < out.length; i++) {
    for (const n of nodes.values()) if (n.parent === out[i] && !out.includes(n.id)) out.push(n.id);
  }
  return out;
}

/** Terminals that are running one of these sessions right now (removing the session stops them). */
function liveTerminals(ids: string[]): number[] {
  const terms = new Set<number>();
  for (const id of ids) {
    const n = nodes.get(id);
    if (n && current.get(n.termId) === id && n.status !== "exited") terms.add(n.termId);
  }
  return [...terms];
}

/** Terminals we killed on purpose. Their dying Claude still fires hooks (e.g. SessionEnd); ignore those. */
const stoppedTerms = new Set<number>();

function stopTerminal(termId: number) {
  stoppedTerms.add(termId);
  invoke("pty_kill", { id: termId });
  const tab = tabs.get(termId);
  barTabs = barTabs.filter((id) => id !== termId);
  lastUsed.delete(termId);
  current.delete(termId);
  tabs.delete(termId);
  tab?.dispose();
}

/** Dashboard-only: forgets the sessions. Transcripts on disk are untouched (`claude --resume` still works). */
function removeSubtree(rootId: string) {
  const ids = subtreeIds(rootId);
  for (const termId of liveTerminals(ids)) stopTerminal(termId);
  for (const id of ids) {
    if (id.startsWith("agent:")) removedAgents.add(id);
    nodes.delete(id);
  }
  render();
}

const menuEl = $<HTMLElement>("#menu");
const hideMenu = () => menuEl.classList.add("hidden");

function showMenu(node: SessionNode, x: number, y: number) {
  const ids = subtreeIds(node.id);
  const running = liveTerminals(ids).length;
  $("#menu-label").textContent = ids.length > 1 ? `Remove ${ids.length} sessions` : "Remove";
  $("#menu-sub").textContent = running
    ? `Stops ${running} running terminal${running > 1 ? "s" : ""}`
    : ids.length > 1
      ? "This session and everything forked from it"
      : "";
  const button = $<HTMLButtonElement>("#menu-remove");
  button.onclick = () => {
    hideMenu();
    removeSubtree(node.id);
  };
  menuEl.classList.remove("hidden");
  menuEl.style.left = `${Math.min(x, window.innerWidth - menuEl.offsetWidth - 8)}px`;
  menuEl.style.top = `${Math.min(y, window.innerHeight - menuEl.offsetHeight - 8)}px`;
  button.focus();
}

window.addEventListener("pointerdown", (e) => {
  if (!menuEl.contains(e.target as Node)) hideMenu();
}, true);
window.addEventListener("blur", hideMenu);
dashEl.addEventListener("contextmenu", (e) => e.preventDefault()); // no browser menu on the background

/** Removes a tab from the bar. The terminal keeps running and stays on the dashboard. */
function closeTab(termId: number) {
  if (!barTabs.includes(termId)) return;
  barTabs = barTabs.filter((id) => id !== termId);
  if (active?.id !== termId) return render();
  // Closed the one we're looking at: fall back to the most recently used remaining tab.
  const next = barTabs.reduce<number | null>(
    (best, id) => (best === null || (lastUsed.get(id) ?? 0) > (lastUsed.get(best) ?? 0) ? id : best),
    null,
  );
  const tab = next === null ? undefined : tabs.get(next);
  if (tab) showTab(tab);
  else showDashboard();
}

function renderTabs() {
  tabsEl.replaceChildren(
    ...barTabs.map((termId) => {
      const node = nodes.get(current.get(termId) ?? "");
      const b = document.createElement("button");
      const isActive = active?.id === termId;
      b.className = `tab term-tab s-${node?.status ?? "starting"}${isActive ? " active" : ""}`;
      b.title = node?.name ?? "terminal";
      const dot = document.createElement("span");
      dot.className = "dot";
      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = node?.name ?? "terminal";
      const close = document.createElement("span");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = "Close tab (terminal keeps running; reopen from the dashboard)";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(termId);
      });
      b.append(dot, label, close);
      b.addEventListener("click", () => openTerminal(termId));
      return b;
    }),
  );
}

function render() {
  graph.render([...nodes.values()]);
  pan.setContentSize(graph.width, graph.height);
  renderTabs();
  scheduleSave();
}

// --- Remembered sessions -------------------------------------------------------------------
// Only sessions that ran in dashboard terminals are ever in `nodes` (hooks are injected per
// terminal), so sessions started natively with `claude` are never remembered. Live status isn't
// saved: after a restart every session is "saved" and clicking it resumes it.

interface SavedNode {
  id: string;
  name: string;
  parent?: string;
  kind?: "agent";
  agentType?: string;
  seq: number;
}

let lastSaved = "";
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** Saving waits for the restore, so an early render can never overwrite what's on disk with an empty state. */
let restored = false;

function serializeState(): string {
  const list: SavedNode[] = [...nodes.values()]
    .filter((n) => !n.id.startsWith("pending-"))
    .map((n) => ({ id: n.id, name: n.name, parent: n.parent, kind: n.kind, agentType: n.agentType, seq: n.seq }));
  return JSON.stringify({ version: 1, nodes: list });
}

function scheduleSave() {
  if (!restored) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!nodes.size && !lastSaved) return; // nothing to remember yet: don't create a file
    const json = serializeState();
    if (json === lastSaved) return;
    lastSaved = json;
    invoke("save_state", { json }).catch(() => {});
  }, 400);
}

async function restoreState() {
  const raw = await invoke<string | null>("load_state").catch(() => null);
  if (!raw) return;
  try {
    const saved = JSON.parse(raw) as { nodes?: SavedNode[] };
    for (const n of saved.nodes ?? []) {
      nodes.set(n.id, {
        id: n.id,
        termId: -1, // no terminal until it is resumed
        name: n.name,
        status: n.kind === "agent" ? "done" : "saved",
        parent: n.parent,
        detached: false,
        seq: n.seq,
        kind: n.kind,
        agentType: n.agentType,
      });
      seq = Math.max(seq, n.seq + 1);
    }
    lastSaved = serializeState();
  } catch {
    /* unreadable state file: start empty */
  }
}

function showDashboard() {
  active?.hide();
  active = null;
  dashEl.classList.remove("hidden");
  termsEl.classList.add("hidden");
  dashTab.classList.add("active");
  render();
}

function showTab(tab: TermTab) {
  if (active && active !== tab) active.hide();
  active = tab;
  if (tab.id >= 0) {
    touch(tab.id);
    ensureInBar(tab.id);
  }
  dashEl.classList.add("hidden");
  termsEl.classList.remove("hidden");
  dashTab.classList.remove("active");
  tab.show();
  render();
}

function openTerminal(termId: number) {
  const tab = tabs.get(termId);
  if (tab) showTab(tab);
}

/** Clicking a box: show its terminal if it has a live one, otherwise resume the session in a new terminal. */
function openNode(n: SessionNode) {
  const target = n.kind === "agent" ? (nodes.get(n.parent ?? "") ?? n) : n; // agents live inside their session
  const hasTerminal = tabs.has(target.termId) && target.status !== "saved" && target.status !== "exited";
  if (hasTerminal) openTerminal(target.termId);
  else if (target.kind !== "agent" && !target.id.startsWith("pending-")) void addTerminal(target.id);
}

/** New Claude terminal; with `resumeId`, it resumes that remembered session instead of starting fresh. */
async function addTerminal(resumeId?: string) {
  const tab = new TermTab(termsEl, () => touch(tab.id));
  showTab(tab); // must be visible before xterm can measure itself
  await tab.start(true, resumeId);
  tabs.set(tab.id, tab);
  touch(tab.id);
  ensureInBar(tab.id);

  const resumed = resumeId ? nodes.get(resumeId) : undefined;
  if (resumed) {
    // Same box, now backed by a live terminal again.
    resumed.termId = tab.id;
    resumed.status = "starting";
    resumed.detached = false;
    current.set(tab.id, resumed.id);
  } else {
    const id = `pending-${tab.id}`;
    nodes.set(id, { id, termId: tab.id, name: "Starting Claude…", status: "starting", detached: false, seq: seq++ });
    current.set(tab.id, id);
  }
  render();
}

/** Agents the user removed; their late hook events must not bring them back. */
const removedAgents = new Set<string>();

/** Subagent activity belongs to a child box, never to the session that spawned it. */
function onAgentEvent(e: HookEvent) {
  const id = `agent:${e.agentId}`;
  if (removedAgents.has(id)) return;
  let node = nodes.get(id);
  if (!node) {
    // Claude also fires a bare SubagentStop (empty type, no start) for internal helper agents.
    // Real agents announce themselves with SubagentStart and carry a type.
    if (e.event === "SubagentStop" || !e.agentType) return;
    node = {
      id,
      termId: e.termId,
      name: e.agentName ?? `${e.agentType} agent`,
      status: "working",
      parent: e.sessionId,
      detached: false,
      seq: seq++,
      kind: "agent",
      agentType: e.agentType ?? undefined,
    };
    nodes.set(id, node);
  }
  if (e.agentName) node.name = e.agentName;
  if (e.event === "SubagentStop") node.status = "done";
  else if (node.status !== "done" || e.event === "SubagentStart") node.status = "working";
  render();
}

/**
 * Claude reports the session's full set of running background work (subagents and shell tasks like
 * `sleep 60`) on Stop and SubagentStop. Show each running task as a child. On the session's own Stop
 * the list is complete, so any child that is no longer in it has finished.
 */
function syncBackground(e: HookEvent, complete: boolean) {
  if (!e.backgroundTasks || !nodes.has(e.sessionId)) return;
  const running = e.backgroundTasks.filter((t) => t.status === "running" && t.id !== e.agentId);
  for (const t of running) {
    const id = `agent:${t.id}`;
    if (nodes.has(id) || removedAgents.has(id)) continue;
    nodes.set(id, {
      id,
      termId: e.termId,
      name: t.description ?? t.kind,
      status: "working",
      parent: e.sessionId,
      detached: false,
      seq: seq++,
      kind: "agent",
      agentType: t.kind === "shell" ? "shell" : (t.agentType ?? t.kind),
    });
  }
  if (complete) {
    const live = new Set(running.map((t) => `agent:${t.id}`));
    for (const n of nodes.values()) {
      if (n.kind === "agent" && n.parent === e.sessionId && n.status === "working" && !live.has(n.id)) n.status = "done";
    }
  }
  render();
}

function onHook(e: HookEvent) {
  if (stoppedTerms.has(e.termId)) return;
  if (e.agentId) {
    onAgentEvent(e);
    return syncBackground(e, false);
  }
  let node = nodes.get(e.sessionId);
  const prevId = current.get(e.termId);

  if (!node || e.event === "SessionStart") {
    // A session just became (or became again) the one this terminal is running.
    let nodeSeq = seq;
    let resumedFrom: string | undefined;
    if (prevId && prevId !== e.sessionId) {
      const prev = nodes.get(prevId);
      if (prev && prevId.startsWith("pending-")) {
        nodes.delete(prevId); // placeholder replaced by the real session
        nodeSeq = prev.seq;
      } else if (prev) {
        // Forked / cleared / resumed elsewhere: the old session stays on the graph.
        if (prev.status === "starting") {
          // We were resuming it but Claude came up under a new id: that id is a continuation of it.
          prev.status = "saved";
          resumedFrom = prevId;
        }
        prev.detached = true;
      }
    }
    if (!node) {
      node = { id: e.sessionId, termId: e.termId, name: "Untitled session", status: e.status, detached: false, seq: nodeSeq, parent: resumedFrom };
      if (nodeSeq === seq) seq++;
      nodes.set(e.sessionId, node);
    }
    node.termId = e.termId; // a remembered session now lives in this terminal
    node.detached = false;
    current.set(e.termId, e.sessionId);
  }

  node.status = e.status;
  if (e.name) node.name = e.name;
  if (e.parentSessionId && e.parentSessionId !== node.id) node.parent = e.parentSessionId;
  render();
  if (e.event === "Stop") syncBackground(e, true);
}

function onExit(termId: number) {
  for (const n of nodes.values()) if (n.termId === termId && n.status !== "done") n.status = "exited";
  tabs.get(termId)?.markExited();
  render();
}

$("#add").addEventListener("click", () => void addTerminal());
dashTab.addEventListener("click", showDashboard);
// Capture phase: xterm stops key events from bubbling, so the app has to see them first.
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape") hideMenu();
    // Alt+1..3: jump to that tab in the bar.
    const n = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && n) {
      e.preventDefault();
      e.stopPropagation();
      const id = barTabs[Number(n) - 1];
      if (id !== undefined) openTerminal(id);
      return;
    }
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    const dash = e.shiftKey && e.code === "KeyD"; // Ctrl+Shift+D: dashboard
    const newTab = !e.shiftKey && e.code === "KeyT"; // Ctrl+T: new terminal
    const closeIt = !e.shiftKey && e.code === "KeyW"; // Ctrl+W: close tab
    if (!dash && !newTab && !closeIt) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (dash) showDashboard();
    else if (newTab) addTerminal();
    else if (active && active.id >= 0) closeTab(active.id);
  },
  true,
);

listen<HookEvent>("hook", (ev) => onHook(ev.payload));
listen<number>("pty-exit", (ev) => onExit(ev.payload));
invoke<string>("get_workspace").then((p) => ($("#ws").textContent = p));
restoreState().then(() => {
  restored = true;
  showDashboard();
});
