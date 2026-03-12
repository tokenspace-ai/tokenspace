import * as readline from "node:readline";
import pc from "picocolors";

export async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function confirm(question: string, defaultValue = true): Promise<boolean> {
  const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
  const answer = (await prompt(pc.cyan(`${question}${suffix}`))).toLowerCase();
  if (!answer) {
    return defaultValue;
  }
  if (answer === "y" || answer === "yes") {
    return true;
  }
  if (answer === "n" || answer === "no") {
    return false;
  }
  throw new Error(`Invalid response '${answer}'. Expected yes or no.`);
}

export async function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive secret input requires a TTY. Use `--stdin` to pipe the value instead.");
  }

  return await new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = stdin.isRaw;
    let value = "";

    const cleanup = (writeNewline: boolean) => {
      stdin.off("data", onData);
      stdin.setRawMode?.(Boolean(wasRaw));
      stdin.pause();
      if (writeNewline) {
        stdout.write("\n");
      }
    };

    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      for (const char of text) {
        if (char === "\u0003") {
          cleanup(true);
          reject(new Error("Prompt cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup(true);
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
          }
          continue;
        }
        value += char;
      }
    };

    stdout.write(question);
    stdin.resume();
    stdin.setRawMode?.(true);
    stdin.on("data", onData);
  });
}
