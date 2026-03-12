declare module "@tokenspace/sdk" {
  export type SerializableValue =
    | string
    | number
    | boolean
    | null
    | SerializableValue[]
    | { [key: string]: SerializableValue };
  export type SerializableObject = { [key: string]: SerializableValue };

  export interface TokenspaceFilesystem {
    list(path: string): Promise<string[]>;
    stat(path: string): Promise<{
      isDirectory: boolean;
      isFile: boolean;
      size: number;
    }>;
    read(path: string): Promise<ArrayBuffer>;
    readText(path: string): Promise<string>;
    write(path: string, content: ArrayBuffer | string): Promise<void>;
    delete(path: string): Promise<void>;
  }

  export function getSecret(name: string): Promise<string>;
  export function getSessionFilesystem(): TokenspaceFilesystem;
  type RequestOptions = {
    url: string | URL;
    method: string;
    headers?: Record<string, any>;
    auth?: {
      type: string;
      username?: string;
      password?: string;
      token?: string;
    };
    tls?: {
      rejectUnauthorized: boolean;
      checkServerIdentity: (hostname: string, cert: any) => void;
    };
    checkResponseStatus?: boolean;
    body?: string | URLSearchParams | undefined;
    redirect?: "manual" | "follow" | "error";
  };
  export function request(req: RequestOptions): Promise<any>;
  export function parseResponseBody(response: Response): Promise<any>;
  export function requireApproval(approval: Approval): Promise<void>;
  export function hasApproval(approval: Approval): Promise<boolean>;
  export class Logger {
    constructor(name: string);
    info(message: string, data?: Record<string, any>): void;
    error(message: string, data?: Record<string, any>): void;
    warn(message: string, data?: Record<string, any>): void;
    debug(message: string, data?: Record<string, any>): void;
  }
  export class TokenspaceError extends Error {
    constructor(message: string, cause?: Error, details?: string, data?: Record<string, any>);
  }
  export function assertSerializable(value: unknown, label?: string): asserts value is SerializableValue;
  export function isAction(value: unknown): value is (args: SerializableObject) => Promise<SerializableValue>;
  export function action<TArgs extends SerializableObject, TResult extends SerializableValue>(
    schema: { parse(input: unknown): TArgs },
    handler: (args: TArgs) => Promise<TResult> | TResult,
  ): (args: TArgs) => Promise<TResult>;
}
