import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { invoke, Channel } from "@tauri-apps/api/core";

/** One real terminal (xterm.js on the front, a PTY on the back). */
export class TermTab {
  id = -1;
  readonly host: HTMLDivElement;
  private term: Terminal;
  private fit = new FitAddon();
  private webgl?: WebglAddon;
  private opened = false;

  constructor(parent: HTMLElement, private onInput: () => void = () => {}) {
    this.host = document.createElement("div");
    this.host.className = "term-host";
    parent.appendChild(this.host);

    this.term = new Terminal({
      fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 14,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
    });
    this.term.loadAddon(this.fit);

    let pending = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => this.refit());
    }).observe(this.host);
  }

  private refit() {
    if (this.opened && this.host.classList.contains("active")) this.fit.fit();
  }

  /** The host must already be visible so xterm can measure itself. */
  async start(claude: boolean, resume?: string) {
    this.term.open(this.host);
    this.opened = true;
    this.attachWebgl();
    this.fit.fit();
    this.term.focus(); // show() ran before open(), so focus couldn't land then

    const onData = new Channel<ArrayBuffer | number[]>();
    onData.onmessage = (msg) => this.term.write(new Uint8Array(msg));

    this.id = await invoke<number>("pty_spawn", {
      cols: this.term.cols,
      rows: this.term.rows,
      claude,
      resume: resume ?? null,
      onData,
    });
    this.term.onData((data) => {
      this.onInput();
      invoke("pty_write", { id: this.id, data });
    });
    this.term.onResize(({ cols, rows }) => invoke("pty_resize", { id: this.id, cols, rows }));
  }

  markExited() {
    this.term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
  }

  // Browsers cap live WebGL contexts, so only the visible terminal gets one.
  private attachWebgl() {
    if (this.webgl) return;
    try {
      const w = new WebglAddon();
      w.onContextLoss(() => {
        w.dispose();
        if (this.webgl === w) this.webgl = undefined;
      });
      this.term.loadAddon(w);
      this.webgl = w;
    } catch {
      /* DOM renderer fallback */
    }
  }

  show() {
    this.host.classList.add("active");
    if (this.opened) {
      this.attachWebgl();
      this.fit.fit();
    }
    this.term.focus();
  }

  /** Tears down the xterm instance and its DOM. The PTY is killed separately (`pty_kill`). */
  dispose() {
    this.webgl?.dispose();
    this.webgl = undefined;
    this.term.dispose();
    this.host.remove();
  }

  hide() {
    this.host.classList.remove("active");
    this.webgl?.dispose();
    this.webgl = undefined;
  }
}
