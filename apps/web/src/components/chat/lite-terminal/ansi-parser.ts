import type { TextStyle } from "./types";

/**
 * Result of parsing a chunk of text with ANSI escape codes
 */
export interface ParseResult {
  type: "text" | "style" | "cursor" | "clear";
  text?: string;
  style?: Partial<TextStyle>;
  cursor?: { action: "left" | "right" | "home"; count?: number };
  clear?: "line" | "screen" | "scrollback";
}

// SGR (Select Graphic Rendition) parameter handlers
const SGR_HANDLERS: Record<number, (style: TextStyle) => void> = {
  0: (s) => {
    delete s.bold;
    delete s.dim;
    delete s.italic;
    delete s.underline;
    delete s.color;
  },
  1: (s) => {
    s.bold = true;
  },
  2: (s) => {
    s.dim = true;
  },
  3: (s) => {
    s.italic = true;
  },
  4: (s) => {
    s.underline = true;
  },
  22: (s) => {
    delete s.bold;
    delete s.dim;
  },
  23: (s) => {
    delete s.italic;
  },
  24: (s) => {
    delete s.underline;
  },
  // Standard colors (foreground)
  30: (s) => {
    s.color = "black";
  },
  31: (s) => {
    s.color = "red";
  },
  32: (s) => {
    s.color = "green";
  },
  33: (s) => {
    s.color = "yellow";
  },
  34: (s) => {
    s.color = "blue";
  },
  35: (s) => {
    s.color = "magenta";
  },
  36: (s) => {
    s.color = "cyan";
  },
  37: (s) => {
    s.color = "white";
  },
  39: (s) => {
    delete s.color;
  },
  // Bright colors
  90: (s) => {
    s.color = "brightBlack";
  },
  91: (s) => {
    s.color = "brightRed";
  },
  92: (s) => {
    s.color = "brightGreen";
  },
  93: (s) => {
    s.color = "brightYellow";
  },
  94: (s) => {
    s.color = "brightBlue";
  },
  95: (s) => {
    s.color = "brightMagenta";
  },
  96: (s) => {
    s.color = "brightCyan";
  },
  97: (s) => {
    s.color = "brightWhite";
  },
};

/**
 * Parse SGR parameters and update style
 */
function parseSGR(params: string, style: TextStyle): Partial<TextStyle> {
  const parts = params ? params.split(";").map(Number) : [0];
  let i = 0;

  while (i < parts.length) {
    const code = parts[i];

    // Handle 24-bit RGB color: 38;2;r;g;b
    if (code === 38 && parts[i + 1] === 2) {
      const r = parts[i + 2] ?? 0;
      const g = parts[i + 3] ?? 0;
      const b = parts[i + 4] ?? 0;
      style.color = `rgb(${r},${g},${b})`;
      i += 5;
      continue;
    }

    // Handle 256-color: 38;5;n
    if (code === 38 && parts[i + 1] === 5) {
      const n = parts[i + 2] ?? 0;
      if (n < 16) {
        const basicColors = [
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
        ];
        style.color = basicColors[n];
      } else if (n >= 232) {
        const gray = Math.round(((n - 232) / 23) * 255);
        style.color = `rgb(${gray},${gray},${gray})`;
      } else {
        const n2 = n - 16;
        const r = Math.floor(n2 / 36);
        const g = Math.floor((n2 % 36) / 6);
        const b = n2 % 6;
        style.color = `rgb(${r * 51},${g * 51},${b * 51})`;
      }
      i += 3;
      continue;
    }

    const handler = SGR_HANDLERS[code];
    if (handler) {
      handler(style);
    }
    i++;
  }

  return { ...style };
}

/**
 * ANSI escape code parser
 */
export class AnsiParser {
  private currentStyle: TextStyle = {};
  private buffer = "";

  parse(text: string): ParseResult[] {
    const results: ParseResult[] = [];
    this.buffer += text;

    let i = 0;
    let textStart = 0;

    while (i < this.buffer.length) {
      if (this.buffer[i] === "\x1b") {
        if (i > textStart) {
          results.push({ type: "text", text: this.buffer.slice(textStart, i) });
        }

        if (i + 1 >= this.buffer.length) {
          this.buffer = this.buffer.slice(i);
          return results;
        }

        const nextChar = this.buffer[i + 1];

        // CSI sequence: ESC [
        if (nextChar === "[") {
          let j = i + 2;
          while (j < this.buffer.length && !/[A-Za-z@~]/.test(this.buffer[j])) {
            j++;
          }

          if (j >= this.buffer.length) {
            this.buffer = this.buffer.slice(i);
            return results;
          }

          const params = this.buffer.slice(i + 2, j);
          const cmd = this.buffer[j];

          const result = this.handleCSI(params, cmd);
          if (result) {
            results.push(result);
          }

          i = j + 1;
          textStart = i;
          continue;
        }

        // OSC sequence: ESC ]
        if (nextChar === "]") {
          let j = i + 2;
          while (j < this.buffer.length) {
            if (this.buffer[j] === "\x07") break;
            if (this.buffer[j] === "\x1b" && this.buffer[j + 1] === "\\") break;
            j++;
          }

          if (j >= this.buffer.length) {
            this.buffer = this.buffer.slice(i);
            return results;
          }

          const oscContent = this.buffer.slice(i + 2, j);
          const result = this.handleOSC(oscContent);
          if (result) {
            results.push(result);
          }

          i = this.buffer[j] === "\x07" ? j + 1 : j + 2;
          textStart = i;
          continue;
        }

        // SS3 sequence: ESC O
        if (nextChar === "O") {
          if (i + 2 >= this.buffer.length) {
            this.buffer = this.buffer.slice(i);
            return results;
          }

          const cmd = this.buffer[i + 2];
          if (cmd === "H") {
            results.push({ type: "cursor", cursor: { action: "home" } });
          } else if (cmd === "F") {
            results.push({ type: "cursor", cursor: { action: "right", count: 9999 } });
          }

          i += 3;
          textStart = i;
          continue;
        }

        // Skip other escape sequences
        if (nextChar === "b" || nextChar === "f" || nextChar === "d") {
          i += 2;
          textStart = i;
          continue;
        }

        i += 1;
        textStart = i;
        continue;
      }

      // Handle carriage return
      if (this.buffer[i] === "\r") {
        if (i > textStart) {
          results.push({ type: "text", text: this.buffer.slice(textStart, i) });
        }
        results.push({ type: "cursor", cursor: { action: "home" } });
        i++;
        textStart = i;
        continue;
      }

      i++;
    }

    if (i > textStart) {
      results.push({ type: "text", text: this.buffer.slice(textStart, i) });
    }

    this.buffer = "";
    return results;
  }

  private handleCSI(params: string, cmd: string): ParseResult | null {
    switch (cmd) {
      case "m":
        return { type: "style", style: parseSGR(params, this.currentStyle) };
      case "D":
        return { type: "cursor", cursor: { action: "left", count: params ? Number.parseInt(params, 10) : 1 } };
      case "C":
        return { type: "cursor", cursor: { action: "right", count: params ? Number.parseInt(params, 10) : 1 } };
      case "H":
        if (!params || params === "1;1") {
          return { type: "cursor", cursor: { action: "home" } };
        }
        return null;
      case "K":
        if (!params || params === "0") {
          return { type: "clear", clear: "line" };
        }
        return null;
      case "J":
        if (params === "2") return { type: "clear", clear: "screen" };
        if (params === "3") return { type: "clear", clear: "scrollback" };
        return null;
      default:
        return null;
    }
  }

  private handleOSC(content: string): ParseResult | null {
    if (content.startsWith("8;")) {
      const parts = content.slice(2).split(";");
      const url = parts.length > 1 ? parts.slice(1).join(";") : parts[0];

      if (url) {
        this.currentStyle.link = url;
      } else {
        delete this.currentStyle.link;
      }

      return { type: "style", style: { ...this.currentStyle } };
    }
    return null;
  }

  getCurrentStyle(): TextStyle {
    return { ...this.currentStyle };
  }

  reset(): void {
    this.currentStyle = {};
    this.buffer = "";
  }
}
