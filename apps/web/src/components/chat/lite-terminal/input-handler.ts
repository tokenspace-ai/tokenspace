import type { DataCallback } from "./types";

/**
 * Maps keyboard events to terminal escape sequences
 */
export class InputHandler {
  private callbacks: DataCallback[] = [];
  private container: HTMLElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private composing = false;

  private touchStartPos: { x: number; y: number } | null = null;
  private mouseDownPos: { x: number; y: number } | null = null;
  private static readonly DRAG_THRESHOLD = 10;

  attach(container: HTMLElement): void {
    this.container = container;

    this.textarea = document.createElement("textarea");
    this.textarea.className = "lite-terminal-input";
    this.textarea.setAttribute("autocapitalize", "off");
    this.textarea.setAttribute("autocomplete", "off");
    this.textarea.setAttribute("autocorrect", "off");
    this.textarea.setAttribute("spellcheck", "false");
    this.textarea.setAttribute("tabindex", "0");
    this.textarea.setAttribute("aria-label", "Terminal input");
    this.textarea.style.fontSize = "16px";
    container.appendChild(this.textarea);

    this.textarea.addEventListener("keydown", this.handleKeyDown);
    this.textarea.addEventListener("input", this.handleInput);
    this.textarea.addEventListener("compositionstart", this.handleCompositionStart);
    this.textarea.addEventListener("compositionend", this.handleCompositionEnd);
    this.textarea.addEventListener("paste", this.handlePaste);
    this.textarea.addEventListener("focus", this.handleFocus);
    this.textarea.addEventListener("blur", this.handleBlur);

    container.addEventListener("mousedown", this.handleMouseDown);
    container.addEventListener("click", this.handleContainerClick);
    container.addEventListener("touchstart", this.handleTouchStart, { passive: true });
    container.addEventListener("touchmove", this.handleTouchMove, { passive: true });
    container.addEventListener("touchend", this.handleTouchEnd);
  }

  detach(): void {
    if (this.textarea) {
      this.textarea.removeEventListener("keydown", this.handleKeyDown);
      this.textarea.removeEventListener("input", this.handleInput);
      this.textarea.removeEventListener("compositionstart", this.handleCompositionStart);
      this.textarea.removeEventListener("compositionend", this.handleCompositionEnd);
      this.textarea.removeEventListener("paste", this.handlePaste);
      this.textarea.removeEventListener("focus", this.handleFocus);
      this.textarea.removeEventListener("blur", this.handleBlur);
      this.textarea.remove();
      this.textarea = null;
    }
    if (this.container) {
      this.container.removeEventListener("mousedown", this.handleMouseDown);
      this.container.removeEventListener("click", this.handleContainerClick);
      this.container.removeEventListener("touchstart", this.handleTouchStart);
      this.container.removeEventListener("touchmove", this.handleTouchMove);
      this.container.removeEventListener("touchend", this.handleTouchEnd);
      this.container = null;
    }
  }

  focus(): void {
    this.textarea?.focus({ preventScroll: true });
  }

  onData(callback: DataCallback): void {
    this.callbacks.push(callback);
  }

  private emit(data: string): void {
    for (const cb of this.callbacks) {
      cb(data);
    }
  }

  private handleMouseDown = (e: MouseEvent): void => {
    this.mouseDownPos = { x: e.clientX, y: e.clientY };
  };

  private handleContainerClick = (e: Event): void => {
    if (e.target instanceof HTMLAnchorElement) return;

    if (this.mouseDownPos && e instanceof MouseEvent) {
      const wasDragging =
        Math.abs(e.clientX - this.mouseDownPos.x) > InputHandler.DRAG_THRESHOLD ||
        Math.abs(e.clientY - this.mouseDownPos.y) > InputHandler.DRAG_THRESHOLD;
      this.mouseDownPos = null;
      if (wasDragging) return;
    }

    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;

    this.textarea?.focus({ preventScroll: true });
  };

  private handleTouchStart = (e: TouchEvent): void => {
    this.touchStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  private handleTouchMove = (): void => {};

  private handleTouchEnd = (e: TouchEvent): void => {
    if (e.target instanceof HTMLAnchorElement) return;

    if (this.touchStartPos && e.changedTouches.length > 0) {
      const touch = e.changedTouches[0];
      const dx = Math.abs(touch.clientX - this.touchStartPos.x);
      const dy = Math.abs(touch.clientY - this.touchStartPos.y);
      this.touchStartPos = null;
      if (dx > InputHandler.DRAG_THRESHOLD || dy > InputHandler.DRAG_THRESHOLD) return;
    }

    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;

    this.textarea?.focus();

    setTimeout(() => {
      this.scrollCursorIntoView();
    }, 300);
  };

  private handleFocus = (): void => {
    this.container?.classList.add("focused");
  };

  private handleBlur = (): void => {
    this.container?.classList.remove("focused");
  };

  private scrollCursorIntoView(): void {
    if (!this.container) return;
    const cursor = this.container.querySelector(".lite-terminal-cursor");
    if (cursor) {
      cursor.scrollIntoView({ block: "nearest" });
    }
  }

  private handleInput = (e: Event): void => {
    if (this.composing) return;

    const textarea = e.target as HTMLTextAreaElement;
    const data = textarea.value;

    if (data) {
      this.emit(data);
      textarea.value = "";
    }
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (this.composing) return;

    const key = e.key;
    const ctrl = e.ctrlKey;
    const alt = e.altKey || e.metaKey;

    let handled = true;
    let data: string | null = null;

    if (ctrl && !alt) {
      switch (key.toLowerCase()) {
        case "a":
          data = "\x01";
          break;
        case "b":
          data = "\x02";
          break;
        case "c":
          data = "\x03";
          break;
        case "d":
          data = "\x04";
          break;
        case "e":
          data = "\x05";
          break;
        case "f":
          data = "\x06";
          break;
        case "h":
          data = "\x08";
          break;
        case "k":
          data = "\x0b";
          break;
        case "l":
          data = "\x0c";
          break;
        case "n":
          data = "\x0e";
          break;
        case "p":
          data = "\x10";
          break;
        case "r":
          data = "\x12";
          break;
        case "u":
          data = "\x15";
          break;
        case "w":
          data = "\x17";
          break;
        default:
          handled = false;
      }
    } else if (alt && !ctrl) {
      switch (key.toLowerCase()) {
        case "b":
          data = "\x1bb";
          break;
        case "f":
          data = "\x1bf";
          break;
        case "d":
          data = "\x1bd";
          break;
        case "backspace":
          data = "\x1b\x7f";
          break;
        case "arrowleft":
          data = "\x1b[1;3D";
          break;
        case "arrowright":
          data = "\x1b[1;3C";
          break;
        default:
          handled = false;
      }
    } else if (ctrl) {
      switch (key) {
        case "ArrowLeft":
          data = "\x1b[1;5D";
          break;
        case "ArrowRight":
          data = "\x1b[1;5C";
          break;
        default:
          handled = false;
      }
    } else {
      switch (key) {
        case "Enter":
          data = "\r";
          break;
        case "Backspace":
          data = "\x7f";
          break;
        case "Tab":
          data = "\t";
          break;
        case " ":
        case "Spacebar":
          data = " ";
          break;
        case "Escape":
          data = "\x1b";
          break;
        case "ArrowUp":
          data = "\x1b[A";
          break;
        case "ArrowDown":
          data = "\x1b[B";
          break;
        case "ArrowRight":
          data = "\x1b[C";
          break;
        case "ArrowLeft":
          data = "\x1b[D";
          break;
        case "Home":
          data = "\x1b[H";
          break;
        case "End":
          data = "\x1b[F";
          break;
        case "Delete":
          data = "\x1b[3~";
          break;
        default:
          if (key.length === 1 && !ctrl && !alt) {
            handled = false;
          } else {
            handled = false;
          }
      }
    }

    if (data !== null) {
      e.preventDefault();
      if (this.textarea) {
        this.textarea.value = "";
      }
      this.emit(data);
    } else if (!handled) {
      // Let browser handle it
    } else {
      e.preventDefault();
    }
  };

  private handleCompositionStart = (): void => {
    this.composing = true;
  };

  private handleCompositionEnd = (e: CompositionEvent): void => {
    this.composing = false;
    if (e.data) {
      this.emit(e.data);
    }
    if (this.textarea) {
      this.textarea.value = "";
    }
  };

  private handlePaste = (e: ClipboardEvent): void => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text");
    if (text) {
      this.emit(text);
    }
  };
}
