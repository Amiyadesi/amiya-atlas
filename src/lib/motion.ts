export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const activeDialogClosers = new WeakMap<HTMLDialogElement, () => void>();

/**
 * Cancel an in-flight dialog exit animation or drag-dismiss timer so interruptible
 * gestures/shortcuts never get swallowed by a stale close.
 */
export function cancelDialogClose(
  dialog: HTMLDialogElement | null | undefined,
): void {
  if (!dialog) return;
  const cancel = activeDialogClosers.get(dialog);
  if (cancel) cancel();
}

/**
 * Gracefully animate a <dialog> out by toggling `.is-closing` before calling `onClosed`.
 * Interruptible via `cancelDialogClose(dialog)` and safe against duplicate calls or reduced-motion mode.
 */
export function animateDialogClose(
  dialog: HTMLDialogElement | undefined,
  onClosed: () => void,
  durationMs = 200,
): void {
  if (!dialog || !dialog.open || prefersReducedMotion()) {
    onClosed();
    return;
  }
  if (dialog.dataset.closing === "1") return;
  dialog.dataset.closing = "1";
  dialog.classList.add("is-closing");
  let finished = false;
  const cleanup = () => {
    dialog.removeEventListener("animationend", onEnd);
    window.clearTimeout(timer);
    delete dialog.dataset.closing;
    dialog.classList.remove("is-closing");
    activeDialogClosers.delete(dialog);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    cleanup();
    onClosed();
  };
  const onEnd = (event: AnimationEvent) => {
    if (event.target === dialog) finish();
  };
  activeDialogClosers.set(dialog, () => {
    if (finished) return;
    finished = true;
    cleanup();
  });
  dialog.addEventListener("animationend", onEnd);
  const timer = window.setTimeout(finish, durationMs + 40);
}

export interface BackdropDismissOptions {
  enabled?: () => boolean;
  onDismiss: () => void;
}

/**
 * Reliable backdrop-click dismissal for native <dialog> elements.
 * Distinguishes true clicks outside the dialog's bounding box from clicks inside
 * the dialog's own padding gutter or text-selection drags that release outside.
 */
export function backdropDismiss(
  node: HTMLDialogElement,
  options: BackdropDismissOptions,
) {
  let opts = options;
  let startedOutside = false;

  const isOutside = (clientX: number, clientY: number): boolean => {
    // Ignore synthetic keyboard-triggered click events (0, 0)
    if (clientX === 0 && clientY === 0) return false;
    const rect = node.getBoundingClientRect();
    return (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    );
  };

  const onPointerDown = (event: PointerEvent) => {
    startedOutside =
      event.target === node && isOutside(event.clientX, event.clientY);
  };

  const onClick = (event: MouseEvent) => {
    const outside =
      startedOutside &&
      event.target === node &&
      isOutside(event.clientX, event.clientY);
    startedOutside = false;
    if (!outside) return;
    if (opts.enabled && !opts.enabled()) return;
    opts.onDismiss();
  };

  node.addEventListener("pointerdown", onPointerDown);
  node.addEventListener("click", onClick);

  return {
    update(next: BackdropDismissOptions) {
      opts = next;
    },
    destroy() {
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("click", onClick);
    },
  };
}

export interface SheetDragOptions {
  enabled?: () => boolean;
  onDismiss: () => void;
  threshold?: number;
}

/**
 * Apple-style 1:1 touch/pointer drag-to-dismiss for mobile bottom sheets & drawers.
 * Only activates when pulling downward from the handle/header or when the scrollable
 * content is already scrolled to the top (`scrollTop <= 0`).
 * Pointer cancel always snaps back safely; all timers are interruptible & cleaned up.
 */
export function sheetDrag(node: HTMLElement, options: SheetDragOptions) {
  let opts = options;
  let active = false;
  let dragging = false;
  let startY = 0;
  let startX = 0;
  let lastY = 0;
  let lastTime = 0;
  let velocity = 0;
  let currentY = 0;
  let pointerId = -1;
  let resetTimer = 0;
  let dismissTimer = 0;
  let resetListener: (() => void) | null = null;

  const isMobileSheet = () =>
    typeof window !== "undefined" && window.innerWidth <= 650;

  const clearTimers = () => {
    if (resetTimer) {
      window.clearTimeout(resetTimer);
      resetTimer = 0;
    }
    if (dismissTimer) {
      window.clearTimeout(dismissTimer);
      dismissTimer = 0;
      if (node instanceof HTMLDialogElement) {
        activeDialogClosers.delete(node);
      }
    }
    if (resetListener) {
      node.removeEventListener("transitionend", resetListener);
      resetListener = null;
    }
  };

  const findScrollable = (target: EventTarget | null): HTMLElement | null => {
    let el = target instanceof HTMLElement ? target : null;
    while (el && el !== node) {
      const style = getComputedStyle(el);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return node.scrollHeight > node.clientHeight ? node : null;
  };

  const clearInlineDragStyles = () => {
    node.classList.remove("is-dragging");
    node.style.transition = "";
    node.style.transform = "";
    node.style.opacity = "";
    node.style.removeProperty("--drag-progress");
  };

  const resetTransform = (animate: boolean) => {
    clearTimers();
    node.classList.remove("is-dragging");
    if (!animate || prefersReducedMotion()) {
      clearInlineDragStyles();
      return;
    }
    node.style.transition =
      "transform var(--dur-sheet, 280ms) var(--ease-out, cubic-bezier(0.22, 1, 0.36, 1)), opacity var(--dur-micro, 150ms) ease-out";
    node.style.transform = "translate3d(0, 0, 0)";
    node.style.opacity = "";
    node.style.setProperty("--drag-progress", "0");
    const clear = () => {
      clearTimers();
      clearInlineDragStyles();
    };
    resetListener = clear;
    node.addEventListener("transitionend", clear);
    resetTimer = window.setTimeout(clear, 320);
  };

  const releaseCapture = () => {
    try {
      if (pointerId >= 0 && node.hasPointerCapture(pointerId)) {
        node.releasePointerCapture(pointerId);
      }
    } catch {
      // Ignore release failure
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!isMobileSheet()) return;
    if (opts.enabled && !opts.enabled()) return;
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const target = event.target as HTMLElement | null;
    if (
      target?.closest(
        "input, textarea, select, option, [contenteditable='true']",
      )
    ) {
      return;
    }
    const scrollable = findScrollable(target);
    const inHeader = !!target?.closest(
      ".sheet-handle, .drawer-handle, .sheet-top, header, .drag-zone",
    );
    if (!inHeader && scrollable && scrollable.scrollTop > 2) return;

    // Interrupt any in-flight spring-back or dismiss transition immediately
    clearTimers();
    node.style.transition = "";
    node.style.opacity = "";

    active = true;
    dragging = false;
    pointerId = event.pointerId;
    startY = lastY = event.clientY;
    startX = event.clientX;
    lastTime = performance.now();
    velocity = 0;
    currentY = 0;
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!active || event.pointerId !== pointerId) return;
    const dy = event.clientY - startY;
    const dx = event.clientX - startX;

    if (!dragging) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
        active = false;
        return;
      }
      if (dy < 8) return;
      dragging = true;
      node.classList.add("is-dragging");
      try {
        node.setPointerCapture(pointerId);
      } catch {
        // Ignore capture failure on synthetic pointers
      }
    }

    event.preventDefault();
    const now = performance.now();
    const dt = Math.max(1, now - lastTime);
    velocity = (event.clientY - lastY) / dt;
    lastY = event.clientY;
    lastTime = now;

    // Gentle upward rubber-band, 1:1 downward tracking
    currentY = dy < 0 ? dy * 0.16 : dy;
    const progress = Math.min(1, Math.max(0, currentY / 260));
    node.style.transform = `translate3d(0, ${currentY.toFixed(1)}px, 0)`;
    node.style.setProperty("--drag-progress", progress.toFixed(3));
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (!active || event.pointerId !== pointerId) return;
    active = false;
    releaseCapture();
    if (!dragging) return;
    dragging = false;
    resetTransform(true);
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!active || event.pointerId !== pointerId) return;
    active = false;
    releaseCapture();
    if (!dragging) return;
    dragging = false;

    if (opts.enabled && !opts.enabled()) {
      resetTransform(true);
      return;
    }

    const threshold = opts.threshold ?? Math.min(110, node.offsetHeight * 0.28);
    if (currentY > threshold || velocity > 0.48) {
      if (prefersReducedMotion()) {
        clearInlineDragStyles();
        opts.onDismiss();
        return;
      }
      clearTimers();
      node.classList.remove("is-dragging");
      node.style.transition =
        "transform 190ms var(--ease-in, cubic-bezier(0.4, 0, 1, 1)), opacity 170ms ease-out";
      node.style.transform = `translate3d(0, ${Math.max(node.offsetHeight + 24, 320)}px, 0)`;
      node.style.opacity = "0";
      node.style.setProperty("--drag-progress", "1");

      const cancelDismiss = () => {
        clearTimers();
        resetTransform(true);
      };
      if (node instanceof HTMLDialogElement) {
        activeDialogClosers.set(node, cancelDismiss);
      }
      dismissTimer = window.setTimeout(() => {
        clearTimers();
        clearInlineDragStyles();
        opts.onDismiss();
      }, 195);
    } else {
      resetTransform(true);
    }
  };

  node.addEventListener("pointerdown", onPointerDown);
  node.addEventListener("pointermove", onPointerMove);
  node.addEventListener("pointerup", onPointerUp);
  node.addEventListener("pointercancel", onPointerCancel);

  return {
    update(next: SheetDragOptions) {
      opts = next;
    },
    destroy() {
      clearTimers();
      clearInlineDragStyles();
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointermove", onPointerMove);
      node.removeEventListener("pointerup", onPointerUp);
      node.removeEventListener("pointercancel", onPointerCancel);
    },
  };
}

/**
 * Enhances a `.segmented` button group with an Apple-style sliding active indicator pill.
 * Measures the active `[aria-pressed="true"]` button cleanly without forced synchronous reflows;
 * snaps on initial paint and glides smoothly on subsequent switches.
 */
export function slidingIndicator(node: HTMLElement) {
  let thumb: HTMLSpanElement | null = null;
  let initialized = false;
  let frame = 0;
  let unlockFrame = 0;

  const ensureThumb = () => {
    if (thumb && thumb.parentElement === node) return thumb;
    thumb = document.createElement("span");
    thumb.className = "seg-thumb";
    thumb.setAttribute("aria-hidden", "true");
    node.prepend(thumb);
    node.classList.add("has-sliding-thumb");
    return thumb;
  };

  const sync = (instant = false) => {
    const active = node.querySelector<HTMLElement>(
      'button[aria-pressed="true"]',
    );
    const el = ensureThumb();
    if (!active) {
      el.style.opacity = "0";
      return;
    }
    const left = active.offsetLeft;
    const top = active.offsetTop;
    const width = active.offsetWidth;
    const height = active.offsetHeight;
    if (!width || !height) return;

    if (unlockFrame) {
      cancelAnimationFrame(unlockFrame);
      unlockFrame = 0;
    }

    if (instant || !initialized || prefersReducedMotion()) {
      el.style.transition = "none";
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
      el.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      el.style.opacity = "1";
      initialized = true;
      // Re-enable transitions on the next animation frame (zero synchronous reflow!)
      unlockFrame = requestAnimationFrame(() => {
        unlockFrame = 0;
        if (thumb === el) el.style.transition = "";
      });
      return;
    }

    el.style.opacity = "1";
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  };

  const schedule = (instant = false) => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      sync(instant);
    });
  };

  const mutationObserver = new MutationObserver(() => schedule(false));
  mutationObserver.observe(node, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-pressed", "class", "hidden"],
    childList: true,
  });

  const resizeObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => schedule(true))
      : null;
  resizeObserver?.observe(node);

  schedule(true);

  return {
    update() {
      schedule(false);
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      if (unlockFrame) cancelAnimationFrame(unlockFrame);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      thumb?.remove();
      node.classList.remove("has-sliding-thumb");
    },
  };
}

/**
 * Interruptible smooth numeric animator for hero currency figures.
 * Reports `(value, animating)` so callers display the approximate animated number ONLY
 * while moving, and render the exact arbitrary-precision money string at rest.
 */
export function createNumberAnimator(
  onUpdate: (value: number, animating: boolean) => void,
) {
  let frame = 0;
  let current = 0;
  let hasInitialized = false;

  const set = (target: number, durationMs = 240) => {
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    if (
      !hasInitialized ||
      prefersReducedMotion() ||
      !Number.isFinite(target) ||
      Math.abs(target - current) < 0.005
    ) {
      hasInitialized = true;
      current = target;
      onUpdate(target, false);
      return;
    }
    const from = current;
    const delta = target - from;
    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      if (t < 1) {
        current = from + delta * eased;
        onUpdate(current, true);
        frame = requestAnimationFrame(tick);
      } else {
        frame = 0;
        current = target;
        onUpdate(target, false);
      }
    };
    frame = requestAnimationFrame(tick);
  };

  const cancel = () => {
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };

  return { set, cancel };
}
