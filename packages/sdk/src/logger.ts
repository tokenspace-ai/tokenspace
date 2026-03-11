export type LogMessage = {
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  logger: string;
  message: string;
  data?: any[];
};

export interface LogDrain {
  flush(...messages: LogMessage[]): Promise<void>;
}

const devNullDrain: LogDrain = {
  flush: async (..._: LogMessage[]): Promise<void> => {},
};

export const consoleDrain: LogDrain = {
  flush: async (...messages: LogMessage[]): Promise<void> => {
    for (const message of messages) {
      console.log(`[${message.level}] (${message.logger}) ${message.message}`, ...(message.data || []));
    }
  },
};

let activeDrain: LogDrain = devNullDrain;

export function setLogDrain(drain: LogDrain): void {
  activeDrain = drain;
}

export class Logger {
  constructor(
    public readonly name: string,
    public readonly debugEnabled: boolean = false,
  ) {}

  debug = (message: string, ...data: any[]): void => {
    if (this.debugEnabled) {
      this.log({ level: "DEBUG", logger: this.name, message, data });
    }
  };

  info = (message: string, ...data: any[]): void => {
    this.log({ level: "INFO", logger: this.name, message, data });
  };

  warn = (message: string, ...data: any[]): void => {
    this.log({ level: "WARN", logger: this.name, message, data });
  };

  error = (message: string, ...data: any[]): void => {
    this.log({ level: "ERROR", logger: this.name, message, data });
  };

  private log(message: LogMessage): void {
    activeDrain.flush(message);
  }
}
