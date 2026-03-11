import { AnsiParser, type ParseResult } from "./ansi-parser";
import { InputHandler } from "./input-handler";
import type { DataCallback, LiteTerminalOptions, StyledSegment, TextStyle, ThemeConfig } from "./types";

const MAX_SCROLLBACK_LINES = 10_000;

/**
 * Lightweight terminal implementation
 */
export class LiteTerminal {
  private container: HTMLElement | null = null;
  private outputElement: HTMLElement | null = null;
  private cursorElement: HTMLElement | null = null;

  private parser: AnsiParser;
  private inputHandler: InputHandler;

  private lines: StyledSegment[][] = [[]];
  private currentLine = 0;
  private currentCol = 0;
  private currentStyle: TextStyle = {};

  private _cols = 80;
  private _options: LiteTerminalOptions;

  private pendingWrites: string[] = [];
  private writeScheduled = false;

  private lineElements: HTMLElement[] = [];
  private dirtyLines: Set<number> = new Set();
  private lastCursorLine = -1;

  constructor(options: LiteTerminalOptions = {}) {
    this._options = {
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Geist Mono", "SF Mono", Menlo, monospace',
      lineHeight: 1.4,
      letterSpacing: 0,
      theme: {
        background: "transparent",
        foreground: "var(--foreground)",
        cursor: "var(--foreground)",
        cyan: "#0AC5B3",
        brightCyan: "#3DD9C8",
        brightBlack: "#666",
      },
      ...options,
    };

    this.parser = new AnsiParser();
    this.inputHandler = new InputHandler();
  }

  get cols(): number {
    return this._cols;
  }

  get options(): { theme: ThemeConfig } {
    const terminal = this;
    return {
      get theme() {
        return terminal._options.theme as ThemeConfig;
      },
      set theme(newTheme: ThemeConfig) {
        terminal._options.theme = { ...terminal._options.theme, ...newTheme };
        terminal.applyTheme();
      },
    };
  }

  open(container: HTMLElement): void {
    this.container = container;

    container.innerHTML = "";
    container.className = "lite-terminal";
    container.setAttribute("role", "region");
    container.setAttribute("aria-label", "Terminal");

    this.outputElement = document.createElement("pre");
    this.outputElement.className = "lite-terminal-output";
    this.outputElement.setAttribute("role", "log");
    this.outputElement.setAttribute("aria-live", "off");
    this.outputElement.setAttribute("aria-label", "Terminal output");
    container.appendChild(this.outputElement);

    this.cursorElement = document.createElement("span");
    this.cursorElement.className = "lite-terminal-cursor";
    if (this._options.cursorBlink) {
      this.cursorElement.classList.add("blink");
    }

    this.applyTheme();
    this.calculateCols();
    this.inputHandler.attach(container);

    // Do initial render to show cursor
    this.render(true);

    if (typeof ResizeObserver !== "undefined") {
      const resizeObserver = new ResizeObserver(() => {
        this.calculateCols();
      });
      resizeObserver.observe(container);
    }
  }

  write(data: string): void {
    this.pendingWrites.push(data);
    this.scheduleWrite();
  }

  writeln(data: string): void {
    this.write(`${data}\n`);
  }

  clear(): void {
    this.lines = [[]];
    this.currentLine = 0;
    this.currentCol = 0;
    this.currentStyle = {};
    this.parser.reset();
    this.lineElements = [];
    this.dirtyLines.clear();
    this.lastCursorLine = -1;
    this.render(true);
  }

  onData(callback: DataCallback): void {
    this.inputHandler.onData(callback);
  }

  focus(): void {
    this.inputHandler.focus();
  }

  dispose(): void {
    this.inputHandler.detach();
    if (this.container) {
      this.container.innerHTML = "";
      this.container = null;
    }
    this.outputElement = null;
    this.cursorElement = null;
  }

  private scheduleWrite(): void {
    if (this.writeScheduled) return;
    this.writeScheduled = true;

    requestAnimationFrame(() => {
      this.writeScheduled = false;
      this.processWrites();
    });
  }

  private processWrites(): void {
    if (this.pendingWrites.length === 0) return;

    const combined = this.pendingWrites.join("");
    this.pendingWrites = [];

    const results = this.parser.parse(combined);
    const startLine = this.currentLine;

    for (const result of results) {
      this.processParseResult(result);
    }

    for (let i = startLine; i <= this.currentLine; i++) {
      this.dirtyLines.add(i);
    }

    this.render(false);
    this.scrollToBottom();
  }

  private processParseResult(result: ParseResult): void {
    switch (result.type) {
      case "text":
        this.writeText(result.text || "");
        break;
      case "style":
        if (result.style) {
          this.currentStyle = { ...result.style };
        }
        break;
      case "cursor":
        if (result.cursor) {
          this.handleCursor(result.cursor);
        }
        break;
      case "clear":
        this.handleClear(result.clear || "line");
        break;
    }
  }

  private writeText(text: string): void {
    for (const char of text) {
      if (char === "\n") {
        this.newLine();
      } else if (char === "\b" || char === "\x08") {
        // Backspace - move cursor left
        this.currentCol = Math.max(0, this.currentCol - 1);
      } else {
        this.writeChar(char);
      }
    }
  }

  private writeChar(char: string): void {
    const line = this.lines[this.currentLine];

    let pos = 0;
    let segmentIndex = 0;
    let charInSegment = 0;

    while (segmentIndex < line.length && pos < this.currentCol) {
      const segLen = line[segmentIndex].text.length;
      if (pos + segLen > this.currentCol) {
        charInSegment = this.currentCol - pos;
        break;
      }
      pos += segLen;
      segmentIndex++;
      charInSegment = 0;
    }

    if (segmentIndex >= line.length) {
      const gap = this.currentCol - pos;
      if (gap > 0) {
        line.push({ text: " ".repeat(gap), style: {} });
      }
      const lastSeg = line[line.length - 1];
      if (lastSeg && this.stylesEqual(lastSeg.style, this.currentStyle)) {
        lastSeg.text += char;
      } else {
        line.push({ text: char, style: { ...this.currentStyle } });
      }
    } else if (charInSegment > 0) {
      const seg = line[segmentIndex];
      const before = seg.text.slice(0, charInSegment);
      const after = seg.text.slice(charInSegment + 1);

      if (this.stylesEqual(seg.style, this.currentStyle)) {
        seg.text = before + char + after;
      } else {
        const newSegments: StyledSegment[] = [];
        if (before) {
          newSegments.push({ text: before, style: seg.style });
        }
        newSegments.push({ text: char, style: { ...this.currentStyle } });
        if (after) {
          newSegments.push({ text: after, style: seg.style });
        }
        line.splice(segmentIndex, 1, ...newSegments);
      }
    } else {
      const seg = line[segmentIndex];
      if (this.stylesEqual(seg.style, this.currentStyle)) {
        seg.text = char + seg.text.slice(1);
      } else {
        const after = seg.text.slice(1);
        const newSegments: StyledSegment[] = [{ text: char, style: { ...this.currentStyle } }];
        if (after) {
          newSegments.push({ text: after, style: seg.style });
        }
        line.splice(segmentIndex, 1, ...newSegments);
      }
    }

    this.currentCol++;
  }

  private newLine(): void {
    this.dirtyLines.add(this.currentLine);

    this.currentLine++;
    this.currentCol = 0;
    if (this.currentLine >= this.lines.length) {
      this.lines.push([]);
      if (this.outputElement) {
        const lineEl = document.createElement("div");
        lineEl.className = "lite-terminal-line";
        this.lineElements.push(lineEl);
        this.outputElement.appendChild(lineEl);
      }
    }

    this.dirtyLines.add(this.currentLine);

    if (this.lines.length > MAX_SCROLLBACK_LINES) {
      const trimCount = this.lines.length - MAX_SCROLLBACK_LINES;
      this.lines.splice(0, trimCount);
      this.currentLine -= trimCount;
      for (let i = 0; i < trimCount; i++) {
        const el = this.lineElements.shift();
        el?.remove();
      }
    }
  }

  private handleCursor(cursor: { action: "left" | "right" | "home"; count?: number }): void {
    const count = cursor.count || 1;

    switch (cursor.action) {
      case "left":
        this.currentCol = Math.max(0, this.currentCol - count);
        break;
      case "right":
        this.currentCol += count;
        break;
      case "home":
        this.currentCol = 0;
        break;
    }
  }

  private handleClear(type: "line" | "screen" | "scrollback"): void {
    switch (type) {
      case "line": {
        const line = this.lines[this.currentLine];
        let pos = 0;
        let segmentIndex = 0;

        while (segmentIndex < line.length && pos < this.currentCol) {
          const segLen = line[segmentIndex].text.length;
          if (pos + segLen > this.currentCol) {
            line[segmentIndex].text = line[segmentIndex].text.slice(0, this.currentCol - pos);
            segmentIndex++;
            break;
          }
          pos += segLen;
          segmentIndex++;
        }
        line.splice(segmentIndex);
        this.dirtyLines.add(this.currentLine);
        break;
      }
      case "screen":
      case "scrollback":
        this.lines = [[]];
        this.currentLine = 0;
        this.currentCol = 0;
        this.lineElements = [];
        this.dirtyLines.clear();
        this.lastCursorLine = -1;
        break;
    }
  }

  private stylesEqual(a: TextStyle, b: TextStyle): boolean {
    return (
      a.bold === b.bold &&
      a.dim === b.dim &&
      a.italic === b.italic &&
      a.underline === b.underline &&
      a.color === b.color &&
      a.link === b.link
    );
  }

  private render(forceFullRender = false): void {
    if (!this.outputElement) return;

    if (forceFullRender || this.lineElements.length === 0 || this.lines.length !== this.lineElements.length) {
      this.fullRender();
      return;
    }

    if (!this.cursorElement) return;

    const cursorMoved = this.lastCursorLine !== this.currentLine;

    if (cursorMoved && this.lastCursorLine >= 0 && this.lastCursorLine < this.lines.length) {
      this.dirtyLines.add(this.lastCursorLine);
    }
    this.dirtyLines.add(this.currentLine);

    for (const lineIndex of this.dirtyLines) {
      if (lineIndex < this.lines.length && lineIndex < this.lineElements.length) {
        this.renderLine(lineIndex);
      }
    }

    this.dirtyLines.clear();
    this.lastCursorLine = this.currentLine;
    this.updateCursorSize();
  }

  private fullRender(): void {
    if (!this.outputElement) return;

    this.outputElement.innerHTML = "";
    this.lineElements = [];

    // Recreate cursor element after clearing
    this.cursorElement = document.createElement("span");
    this.cursorElement.className = "lite-terminal-cursor";
    if (this._options.cursorBlink) {
      this.cursorElement.classList.add("blink");
    }
    // Apply cursor color from theme
    const theme = this._options.theme || {};
    this.cursorElement.style.backgroundColor = theme.cursor || "var(--foreground)";

    for (let lineIndex = 0; lineIndex < this.lines.length; lineIndex++) {
      const lineEl = document.createElement("div");
      lineEl.className = "lite-terminal-line";
      this.lineElements.push(lineEl);
      this.outputElement.appendChild(lineEl);
      this.renderLineContent(lineIndex, lineEl);
    }

    this.dirtyLines.clear();
    this.lastCursorLine = this.currentLine;
    this.updateCursorSize();
  }

  private renderLine(lineIndex: number): void {
    const lineEl = this.lineElements[lineIndex];
    if (!lineEl) return;
    this.renderLineContent(lineIndex, lineEl);
  }

  private renderLineContent(lineIndex: number, lineEl: HTMLElement): void {
    if (!this.cursorElement) return;

    lineEl.innerHTML = "";
    const line = this.lines[lineIndex];
    const isCursorLine = lineIndex === this.currentLine;

    if (!isCursorLine) {
      for (const segment of line) {
        if (segment.text) {
          lineEl.appendChild(this.createStyledSpan(segment.text, segment.style));
        }
      }
      if (line.length === 0 || line.every((s) => !s.text)) {
        lineEl.appendChild(document.createTextNode("\u200B"));
      }
      return;
    }

    let charPos = 0;
    let cursorInserted = false;

    for (const segment of line) {
      if (!segment.text) continue;

      const segStart = charPos;
      const segEnd = charPos + segment.text.length;

      if (!cursorInserted && this.currentCol >= segStart && this.currentCol < segEnd) {
        const offsetInSegment = this.currentCol - segStart;
        const beforeCursor = segment.text.slice(0, offsetInSegment);
        const afterCursor = segment.text.slice(offsetInSegment);

        if (beforeCursor) {
          lineEl.appendChild(this.createStyledSpan(beforeCursor, segment.style));
        }
        lineEl.appendChild(this.cursorElement);
        cursorInserted = true;
        if (afterCursor) {
          lineEl.appendChild(this.createStyledSpan(afterCursor, segment.style));
        }
      } else {
        lineEl.appendChild(this.createStyledSpan(segment.text, segment.style));
      }

      charPos += segment.text.length;
    }

    if (!cursorInserted) {
      lineEl.appendChild(this.cursorElement);
    }
  }

  private static readonly URL_REGEX = /(https?:\/\/[^\s)<>]+)/g;

  private createStyledSpan(
    text: string,
    style: TextStyle,
  ): HTMLSpanElement | HTMLAnchorElement | Text | DocumentFragment {
    const classes = this.getStyleClasses(style);
    const inlineStyle = this.getInlineStyle(style);

    if (style.link) {
      const link = document.createElement("a");
      link.href = style.link;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = text;
      if (classes) link.className = classes;
      if (inlineStyle) link.style.cssText = inlineStyle;
      link.style.cursor = "pointer";
      return link;
    }

    const urlMatch = text.match(LiteTerminal.URL_REGEX);
    if (urlMatch) {
      return this.createTextWithLinks(text, classes, inlineStyle);
    }

    if (!classes && !inlineStyle) {
      return document.createTextNode(text);
    }

    const span = document.createElement("span");
    if (classes) span.className = classes;
    if (inlineStyle) span.style.cssText = inlineStyle;
    span.textContent = text;
    return span;
  }

  private createTextWithLinks(text: string, classes: string, inlineStyle: string): DocumentFragment {
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;

    LiteTerminal.URL_REGEX.lastIndex = 0;

    let match: RegExpExecArray | null = LiteTerminal.URL_REGEX.exec(text);
    while (match !== null) {
      if (match.index > lastIndex) {
        const beforeText = text.slice(lastIndex, match.index);
        fragment.appendChild(this.createStyledElement(beforeText, classes, inlineStyle));
      }

      const url = match[0];
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = url;
      if (classes) link.className = classes;
      if (inlineStyle) link.style.cssText = inlineStyle;
      link.style.cursor = "pointer";
      fragment.appendChild(link);

      lastIndex = match.index + url.length;
      match = LiteTerminal.URL_REGEX.exec(text);
    }

    if (lastIndex < text.length) {
      const afterText = text.slice(lastIndex);
      fragment.appendChild(this.createStyledElement(afterText, classes, inlineStyle));
    }

    return fragment;
  }

  private createStyledElement(text: string, classes: string, inlineStyle: string): HTMLSpanElement | Text {
    if (!classes && !inlineStyle) {
      return document.createTextNode(text);
    }
    const span = document.createElement("span");
    if (classes) span.className = classes;
    if (inlineStyle) span.style.cssText = inlineStyle;
    span.textContent = text;
    return span;
  }

  private updateCursorSize(): void {
    if (!this.cursorElement || !this.outputElement) return;

    const charWidth = this.measureCharWidth();
    const computedStyle = getComputedStyle(this.outputElement);
    const lineHeight =
      Number.parseFloat(computedStyle.lineHeight) || this._options.fontSize! * (this._options.lineHeight || 1.2);

    this.cursorElement.style.width = `${charWidth}px`;
    this.cursorElement.style.height = `${lineHeight}px`;
  }

  private static readonly VALID_COLOR_CLASSES = new Set([
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
  ]);

  private getStyleClasses(style: TextStyle): string {
    const classes: string[] = [];

    if (style.bold) classes.push("bold");
    if (style.dim) classes.push("dim");
    if (style.italic) classes.push("italic");
    if (style.underline) classes.push("underline");

    if (style.color && LiteTerminal.VALID_COLOR_CLASSES.has(style.color)) {
      classes.push(style.color);
    }

    return classes.join(" ");
  }

  private static readonly RGB_COLOR_REGEX = /^rgb\(\d{1,3},\d{1,3},\d{1,3}\)$/;

  private getInlineStyle(style: TextStyle): string {
    if (style.color && LiteTerminal.RGB_COLOR_REGEX.test(style.color)) {
      return `color: ${style.color}`;
    }
    return "";
  }

  private scrollToBottom(): void {
    if (this.container) {
      this.container.scrollTop = this.container.scrollHeight;
    }
  }

  private calculateCols(): void {
    if (!this.container || !this.outputElement) return;

    const charWidth = this.measureCharWidth();
    const containerPadding = 24;
    const availableWidth = (this.container.clientWidth || 300) - containerPadding;

    this._cols = Math.floor(availableWidth / charWidth) || 80;
  }

  private measureCharWidth(): number {
    if (!this.outputElement) return 8;

    const measureSpan = document.createElement("span");
    measureSpan.textContent = "M";
    measureSpan.style.visibility = "hidden";
    measureSpan.style.position = "absolute";
    this.outputElement.appendChild(measureSpan);

    const width = measureSpan.offsetWidth;
    this.outputElement.removeChild(measureSpan);

    return width || 8;
  }

  private applyTheme(): void {
    if (!this.container) return;

    const theme = this._options.theme || {};

    this.container.style.setProperty("background-color", theme.background || "transparent");
    this.container.style.setProperty("color", theme.foreground || "var(--foreground)");

    this.container.style.setProperty("--term-cyan", theme.cyan || "#0AC5B3");
    this.container.style.setProperty("--term-brightCyan", theme.brightCyan || "#3DD9C8");
    this.container.style.setProperty("--term-brightBlack", theme.brightBlack || "#666");

    if (this.cursorElement) {
      this.cursorElement.style.backgroundColor = theme.cursor || "var(--foreground)";
    }
  }
}
