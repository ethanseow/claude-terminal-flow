export type Status = "starting" | "idle" | "working" | "waiting" | "ended" | "exited" | "done";

export interface SessionNode {
  id: string; // Claude session id (or "pending-<term>" until the first hook arrives)
  termId: number;
  name: string;
  status: Status;
  parent?: string;
  /** The terminal has since moved on to a different session. */
  detached: boolean;
  seq: number;
  /** A subagent spawned by a session (e.g. a background agent), not a session of its own. */
  kind?: "agent";
  agentType?: string;
}

const W = 220;
const H = 64;
const GX = 28; // horizontal gap between boxes side by side
const GY = 64; // vertical gap between a parent row and its children
const PAD = 28;

const LABEL: Record<Status, string> = {
  starting: "starting",
  idle: "idle",
  working: "working",
  waiting: "needs you",
  ended: "ended",
  exited: "exited",
  done: "done",
};

export class Graph {
  private els = new Map<string, HTMLDivElement>();
  private byId = new Map<string, SessionNode>();
  /** Size of the laid-out content (padding included), for centering. */
  width = 0;
  height = 0;

  constructor(
    private nodesEl: HTMLElement,
    private pathsEl: SVGGElement,
    private svgEl: SVGSVGElement,
    private emptyEl: HTMLElement,
    private onOpen: (n: SessionNode) => void,
    private onMenu: (n: SessionNode, x: number, y: number) => void,
  ) {}

  render(nodes: SessionNode[]) {
    this.emptyEl.classList.toggle("hidden", nodes.length > 0);
    const sorted = [...nodes].sort((a, b) => a.seq - b.seq);
    const byId = new Map(sorted.map((n) => [n.id, n]));
    this.byId = byId;

    // Forest layout, top to bottom: y by depth, x by leaf order; a parent sits midway above its children.
    const kids = new Map<string, SessionNode[]>();
    const roots: SessionNode[] = [];
    for (const n of sorted) {
      if (n.parent && n.parent !== n.id && byId.has(n.parent)) {
        const list = kids.get(n.parent) ?? [];
        list.push(n);
        kids.set(n.parent, list);
      } else roots.push(n);
    }
    const pos = new Map<string, { depth: number; slot: number }>();
    let nextSlot = 0;
    const place = (n: SessionNode, depth: number): number => {
      if (pos.has(n.id)) return pos.get(n.id)!.slot; // cycle guard
      pos.set(n.id, { depth, slot: 0 });
      const ch = kids.get(n.id) ?? [];
      const slot = ch.length
        ? (() => {
            const slots = ch.map((k) => place(k, depth + 1));
            return (slots[0] + slots[slots.length - 1]) / 2;
          })()
        : nextSlot++;
      pos.get(n.id)!.slot = slot;
      return slot;
    };
    roots.forEach((r) => place(r, 0));

    const xy = (id: string) => {
      const p = pos.get(id)!;
      return { x: PAD + p.slot * (W + GX), y: PAD + p.depth * (H + GY) };
    };

    // Nodes (keyed, so hover and pulse animations survive updates).
    for (const [id, el] of this.els) {
      if (!byId.has(id)) {
        el.remove();
        this.els.delete(id);
      }
    }
    // How many agents each session still has running (shown on the session's box).
    const running = new Map<string, number>();
    for (const n of sorted) {
      if (n.kind === "agent" && n.status === "working" && n.parent) running.set(n.parent, (running.get(n.parent) ?? 0) + 1);
    }
    let maxX = 0;
    let maxY = 0;
    for (const n of sorted) {
      let el = this.els.get(n.id);
      if (!el) {
        el = document.createElement("div");
        el.innerHTML =
          '<div class="name"></div><div class="meta"><span class="dot"></span><span class="label"></span><span class="term"></span></div>';
        const id = n.id;
        const open = () => {
          const node = this.byId.get(id);
          if (node) this.onOpen(node);
        };
        el.tabIndex = 0;
        el.addEventListener("click", open);
        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const node = this.byId.get(id);
          if (!node) return;
          // The keyboard context-menu key reports (0, 0); anchor to the box instead.
          const r = el!.getBoundingClientRect();
          const keyboard = e.clientX === 0 && e.clientY === 0;
          this.onMenu(node, keyboard ? r.left + 16 : e.clientX, keyboard ? r.bottom - 8 : e.clientY);
        });
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        });
        this.nodesEl.appendChild(el);
        this.els.set(n.id, el);
      }
      const { x, y } = xy(n.id);
      maxX = Math.max(maxX, x + W);
      maxY = Math.max(maxY, y + H);
      el.className = `node s-${n.status}${n.detached ? " detached" : ""}${n.kind === "agent" ? " agent" : ""}`;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.title = n.detached ? `${n.name}\n(terminal ${n.termId} moved to another session; click to open it)` : n.name;
      setText(el.querySelector(".name")!, n.name);
      const base = n.detached && n.status !== "exited" ? "inactive" : LABEL[n.status];
      const agents = running.get(n.id) ?? 0;
      setText(el.querySelector(".label")!, agents ? `${base} · ${agents} in background` : base);
      setText(el.querySelector(".term")!, n.kind === "agent" ? (n.agentType ?? "agent") : `term ${n.termId}`);
    }

    // Edges: parent -> child, with an arrowhead at the child.
    const parts: string[] = [];
    for (const n of sorted) {
      if (!n.parent || !pos.has(n.parent) || !pos.has(n.id) || n.parent === n.id) continue;
      const a = xy(n.parent);
      const b = xy(n.id);
      // Parent's bottom-center to child's top-center, arrowhead pointing down at the child.
      const x1 = a.x + W / 2;
      const y1 = a.y + H;
      const x2 = b.x + W / 2;
      const y2 = b.y;
      const my = (y1 + y2) / 2;
      parts.push(`<path class="edge${n.kind === "agent" ? " agent-edge" : ""}" marker-end="url(#arrow)" d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}"/>`);
    }
    this.pathsEl.innerHTML = parts.join("");
    const w = maxX + PAD;
    const h = maxY + PAD;
    this.width = w;
    this.height = h;
    this.svgEl.setAttribute("width", String(w));
    this.svgEl.setAttribute("height", String(h));
    this.nodesEl.style.width = `${w}px`;
    this.nodesEl.style.height = `${h}px`;
  }
}

function setText(el: Element, text: string) {
  if (el.textContent !== text) el.textContent = text;
}
