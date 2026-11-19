/**
 * Drag-to-pan for the dashboard. Drag the background to move around; the mouse wheel /
 * trackpad scroll pans too; double-click the background to snap back to the centered view.
 * Dragging a box is left alone so clicking it still opens its terminal.
 */
export function enablePan(viewport: HTMLElement, canvas: HTMLElement) {
  // x/y is the user's pan; the content is also centered in the viewport on top of it.
  let x = 0;
  let y = 0;
  let contentW = 0;
  let contentH = 0;
  let drag: { px: number; py: number; ox: number; oy: number } | null = null;

  const apply = () => {
    // Content bigger than the viewport starts at the top-left instead of being cut off.
    const cx = Math.max(0, (viewport.clientWidth - contentW) / 2);
    const cy = Math.max(0, (viewport.clientHeight - contentH) / 2);
    canvas.style.transform = `translate(${cx + x}px, ${cy + y}px)`;
  };
  new ResizeObserver(apply).observe(viewport);
  const onBackground = (e: Event) => !(e.target as Element).closest(".node");

  viewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !onBackground(e)) return;
    drag = { px: e.clientX, py: e.clientY, ox: x, oy: y };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add("panning");
  });

  viewport.addEventListener("pointermove", (e) => {
    if (!drag) return;
    x = drag.ox + e.clientX - drag.px;
    y = drag.oy + e.clientY - drag.py;
    apply();
  });

  const end = () => {
    drag = null;
    viewport.classList.remove("panning");
  };
  viewport.addEventListener("pointerup", end);
  viewport.addEventListener("pointercancel", end);

  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      x -= e.deltaX;
      y -= e.deltaY;
      apply();
    },
    { passive: false },
  );

  viewport.addEventListener("dblclick", (e) => {
    if (!onBackground(e)) return;
    x = 0;
    y = 0;
    apply();
  });

  return {
    /** Tell the pan code how big the content is so it can keep it centered. */
    setContentSize(w: number, h: number) {
      contentW = w;
      contentH = h;
      apply();
    },
  };
}
