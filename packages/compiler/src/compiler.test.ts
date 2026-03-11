import { describe, expect, it } from "bun:test";
import { compileAgentCode, compileDeclarations, makeGlobalDeclarations } from "./compiler";

// const splunkSource = fs.readFileSync(
//   path.join(import.meta.dir, "../../../examples/siftd/src/capabilities/splunk/capability.ts"),
//   "utf-8",
// );
// const splunkCredentialsSource = fs.readFileSync(
//   path.join(import.meta.dir, "../../../examples/siftd/src/credentials.ts"),
//   "utf-8",
// );

const sandboxApis = [
  {
    fileName: "capabilities/splunk/capability.d.ts",
    content: `declare namespace splunk {
  type SplunkConnection = "splunkdogfood" | "splunklocal";
  type SearchSplunkArgs = {
    query: string;
    timeRange: {
      earliest: string;
      latest: string;
    };
    limit?: number;
  };
  type SearchSplunkResult = {
    rows: Record<string, string | string[]>[];
  };
  const searchSplunk: (args: {
    connection: SplunkConnection;
    args: SearchSplunkArgs;
  }) => Promise<SearchSplunkResult>;
  type SplunkApiRequestArgs = {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    body?: Record<string, any>;
    headers?: Record<string, string>;
  };
  type SplunkApiRequestResult = {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
  const splunkApiRequest: (args: {
    connection: SplunkConnection;
    args: SplunkApiRequestArgs;
  }) => Promise<SplunkApiRequestResult>;
}
`,
  },
];

const SPLUNK_TEST_EXTERNAL_TYPES = new Map([
  [
    "@tokenspace/sdk",
    `
export type SerializableValue = string | number | boolean | null | SerializableValue[] | { [key: string]: SerializableValue };
export type SerializableObject = { [key: string]: SerializableValue };
export class TokenspaceError extends Error {
  constructor(message: string, cause?: Error, details?: string, data?: Record<string, unknown>);
  readonly cause?: Error;
  readonly details?: string;
  readonly data?: Record<string, unknown>;
}
export class Logger {
  constructor(name: string, debugEnabled?: boolean);
  debug(message: string, ...data: any[]): void;
  info(message: string, ...data: any[]): void;
  warn(message: string, ...data: any[]): void;
  error(message: string, ...data: any[]): void;
}
export function request(options: any): Promise<Response>;
export function parseResponseBody(response: Response): Promise<any>;
export function requireApproval(requirement: any): void;
export function getCredential<T>(credential: T): Promise<any>;
export type CredentialId = string & { _brand: "CredentialId" };
export const credentials: {
  secret(def: {
    id: string;
    label?: string;
    group?: string;
    description?: string;
    scope: "workspace" | "session" | "user";
    optional?: boolean;
    fallback?: CredentialId;
  }): any;
  env(def: {
    id: string;
    label?: string;
    group?: string;
    variableName: string;
    description?: string;
    optional?: boolean;
    fallback?: CredentialId;
  }): any;
  oauth(def: {
    id: string;
    label?: string;
    group?: string;
    description?: string;
    scope: "workspace" | "session" | "user";
    optional?: boolean;
    config: {
      grantType: "authorization_code" | "client_credentials" | "implicit";
      clientId: string;
      clientSecret: CredentialId | string;
      authorizeUrl: string;
      tokenUrl: string;
      scopes: string[];
    };
  }): any;
  ref(credential: any): CredentialId;
};
export function action<TInput extends SerializableObject, TParsed extends SerializableObject, TResult extends SerializableValue>(
  schema: { parse(input: unknown): TParsed; _input: TInput; _output: TParsed },
  handler: (args: TParsed) => Promise<TResult> | TResult,
): (args: TInput) => Promise<TResult>;
`,
  ],
  [
    "zod",
    `
export type ZodSafeParseSuccess<T> = { success: true; data: T };
export type ZodSafeParseFailure = { success: false; error: { message: string } };
export type ZodSafeParseResult<T> = ZodSafeParseSuccess<T> | ZodSafeParseFailure;
export interface ZodType<TOutput, TInput = TOutput, TIsOptional extends boolean = false> {
  _input: TInput;
  _output: TOutput;
  _isOptional: TIsOptional;
  parse(input: unknown): TOutput;
  safeParse(input: unknown): { success: true; data: TOutput } | { success: false; error: { message: string } };
  optional(): ZodType<TOutput | undefined, TInput | undefined, true>;
  nullable(): ZodType<TOutput | null, TInput | null, TIsOptional>;
  or<UOutput, UInput, UIsOptional extends boolean>(
    schema: ZodType<UOutput, UInput, UIsOptional>,
  ): ZodType<TOutput | UOutput, TInput | UInput, TIsOptional | UIsOptional>;
  extend<TShape extends ZodShape>(shape: TShape): ZodType<
    (TOutput extends object ? TOutput : {}) & { [K in keyof TShape]: ZodInferOutput<TShape[K]> },
    (TInput extends object ? TInput : {}) & { [K in keyof TShape]: ZodInferInput<TShape[K]> }
  >;
  int(): ZodType<TOutput, TInput, TIsOptional>;
  min(value: number): ZodType<TOutput, TInput, TIsOptional>;
  max(value: number): ZodType<TOutput, TInput, TIsOptional>;
  positive(): ZodType<TOutput, TInput, TIsOptional>;
  nonnegative(): ZodType<TOutput, TInput, TIsOptional>;
  default(value: TOutput): ZodType<TOutput, TInput | undefined, true>;
  describe(description: string): ZodType<TOutput, TInput, TIsOptional>;
}
type ZodShape = Record<string, ZodType<any, any, any>>;
type ZodInferOutput<TSchema extends ZodType<any, any, any>> = TSchema extends ZodType<infer TValue, any, any>
  ? TValue
  : never;
type ZodInferInput<TSchema extends ZodType<any, any, any>> = TSchema extends ZodType<any, infer TInput, any>
  ? TInput
  : never;
type ZodOptionalKeys<TShape extends ZodShape> = {
  [K in keyof TShape]-?: TShape[K] extends ZodType<any, any, true> ? K : never;
}[keyof TShape];
type ZodRequiredKeys<TShape extends ZodShape> = Exclude<keyof TShape, ZodOptionalKeys<TShape>>;
declare const z: {
  object<TShape extends ZodShape>(shape: TShape): ZodType<
    { [K in keyof TShape]: ZodInferOutput<TShape[K]> },
    { [K in ZodRequiredKeys<TShape>]: ZodInferInput<TShape[K]> } & {
      [K in ZodOptionalKeys<TShape>]?: Exclude<ZodInferInput<TShape[K]>, undefined>;
    }
  >;
  string(): ZodType<string>;
  number(): ZodType<number>;
  boolean(): ZodType<boolean>;
  unknown(): ZodType<unknown>;
  optional<TOutput, TInput, TIsOptional extends boolean>(
    schema: ZodType<TOutput, TInput, TIsOptional>,
  ): ZodType<TOutput | undefined, TInput | undefined, true>;
  array<TOutput, TInput, TIsOptional extends boolean>(
    schema: ZodType<TOutput, TInput, TIsOptional>,
  ): ZodType<TOutput[], TInput[]>;
  record<TKeyOutput, TKeyInput, TValueOutput, TValueInput>(
    keySchema: ZodType<TKeyOutput, TKeyInput, any>,
    valueSchema: ZodType<TValueOutput, TValueInput, any>,
  ): ZodType<Record<string, TValueOutput>, Record<string, TValueInput>>;
  any(): ZodType<any>;
  custom<T>(): ZodType<T>;
  union<TSchemas extends readonly [ZodType<any, any, any>, ...ZodType<any, any, any>[]]>(
    schemas: TSchemas,
  ): ZodType<
    TSchemas[number] extends ZodType<infer TValue, any, any> ? TValue : never,
    TSchemas[number] extends ZodType<any, infer TInput, any> ? TInput : never
  >;
  literal<T extends string | number | boolean | null>(value: T): ZodType<T>;
  enum<TValues extends readonly [string, ...string[]]>(values: TValues): ZodType<TValues[number]>;
};
declare namespace z {
  export type infer<TSchema extends ZodType<any, any, any>> = TSchema extends ZodType<infer TValue, any, any>
    ? TValue
    : never;
  export type output<TSchema extends ZodType<any, any, any>> = TSchema extends ZodType<infer TValue, any, any>
    ? TValue
    : never;
  export type input<TSchema extends ZodType<any, any, any>> = TSchema extends ZodType<any, infer TInput, any>
    ? TInput
    : never;
}
export default z;
export type infer<TSchema extends ZodType<any, any, any>> = TSchema extends ZodType<infer TValue, any, any>
  ? TValue
  : never;
export type output<TSchema extends ZodType<any, any, any>> = TSchema extends ZodType<infer TValue, any, any>
  ? TValue
  : never;
export type input<TSchema extends ZodType<any, any, any>> = TSchema extends ZodType<any, infer TInput, any>
  ? TInput
  : never;
export function prettifyError(error: any): string;
`,
  ],
]);

describe("compileAgentCode", () => {
  it("compiles valid code using sandbox APIs as globals", () => {
    const code = `
      const result = await splunk.searchSplunk({
        connection: "splunklocal",
        args: {
          query: "index=main",
          timeRange: { earliest: "-24h", latest: "now" }
        }
      });
      console.log(result);
    `;

    const result = compileAgentCode(code, { sandboxApis });
    expect(result.success).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("rejects code that tries to import sandbox APIs", () => {
    const code = `
import { searchSplunk } from "@sandbox/capabilities/splunk";

  const result = await splunk.searchSplunk({
    connection: "splunklocal",
    args: {
      query: "index=main",
      timeRange: { earliest: "-24h", latest: "now" }
    }
  });
`;

    const result = compileAgentCode(code, { sandboxApis });
    expect(result.success).toBe(false);
    // Should fail because imports are not allowed
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("rejects code using fetch (browser API)", () => {
    const code = `
  const response = await fetch("https://example.com");
  console.log(await response.json());
`;

    const result = compileAgentCode(code, { sandboxApis });
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.message.includes("fetch"))).toBe(true);
  });

  it("rejects code using fs (node API)", () => {
    const code = `
import fs from "fs";
const data = fs.readFileSync("file.txt");
`;

    const result = compileAgentCode(code, { sandboxApis });
    expect(result.success).toBe(false);
    // Should fail because imports are not allowed
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("rejects code using process (node global)", () => {
    const code = `
const env = process.env.HOME;
`;

    const result = compileAgentCode(code, { sandboxApis });
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.message.includes("process"))).toBe(true);
  });

  it("rejects code using setTimeout (browser API)", () => {
    const code = `
setTimeout(() => console.log("hi"), 1000);
`;

    const result = compileAgentCode(code, { sandboxApis });
    expect(result.success).toBe(false);
    expect(result.diagnostics.some((d) => d.message.includes("setTimeout"))).toBe(true);
  });

  it("rejects any import statements", () => {
    const code = `
import axios from "axios";
`;

    const result = compileAgentCode(code, { sandboxApis });
    expect(result.success).toBe(false);
  });

  it("allows basic TypeScript language features", () => {
    const code = `
const numbers = [1, 2, 3, 4, 5];
const doubled = numbers.map(n => n * 2);
const sum = doubled.reduce((a, b) => a + b, 0);

const obj = { name: "test", value: 42 };
const keys = Object.keys(obj);

const str = "hello world";
const upper = str.toUpperCase();

const now = new Date();
const year = now.getFullYear();

const map = new Map<string, number>();
map.set("a", 1);

const set = new Set([1, 2, 3]);
set.has(2);

const json = JSON.stringify({ foo: "bar" });
const parsed = JSON.parse(json);

const promise = Promise.resolve(42);
promise.then(x => console.log(x));
`;

    const result = compileAgentCode(code, { sandboxApis });
    expect(result.success).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("compiles code with session APIs as globals", () => {
    const code = `
  session.setSessionVariable("key", "value");
  const val = session.getSessionVariable("key");
  console.log(val);

  await session.writeArtifact("data.json", JSON.stringify({ hello: "world" }));
`;

    const result = compileAgentCode(code, { sandboxApis });
    expect(result.success).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("reports type errors in code", () => {
    const code = `
  // Missing required 'timeRange' property
  const result = await splunk.searchSplunk({
    connection: "splunklocal",
    args: {
      query: "index=main"
    }
  });
`;

    const result = compileAgentCode(code, { sandboxApis });
    expect(result.success).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("provides type checking for sandbox API arguments", () => {
    const code = `
  // Invalid connection string - should be "splunklocal" or "splunkdogfood"
  const result = await splunk.searchSplunk({
    connection: "invalid-connection",
    args: {
      query: "index=main",
      timeRange: { earliest: "-24h", latest: "now" }
    }
  });
`;

    const result = compileAgentCode(code, { sandboxApis });
    expect(result.success).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("compiles complex code with Record type annotations and Splunk queries", () => {
    // This test case verifies that code with Record<string, number> type annotations
    // compiles correctly. Previously, this failed because the transpiled JavaScript
    // was not being passed to the runtime, causing SyntaxError at execution time.
    const code = `
const results = await splunk.searchSplunk({
  connection: "splunkdogfood",
  args: {
    query: \`\\
index=spin_telemetry sourcetype="siftd:website" env=production
| stats count by session
| table session\`,
    timeRange: { earliest: "-24h", latest: "now" },
    limit: 500
  }
});

// Summarize the data using Record type annotations
const totalSessions = results.rows.length;
let totalVisits = 0;
let totalClicks = 0;
const locations: Record<string, number> = {};
const referrers: Record<string, number> = {};
const pages: Record<string, number> = {};

for (const row of results.rows) {
  totalVisits += parseInt(row.visits as string) || 0;
  totalClicks += parseInt(row.clicks as string) || 0;
  
  const loc = row.location as string;
  if (loc) {
    locations[loc] = (locations[loc] || 0) + 1;
  }
  
  const ref = row.referrer as string;
  if (ref && ref !== "-") {
    referrers[ref] = (referrers[ref] || 0) + 1;
  }
  
  const pageList = row.pages;
  if (Array.isArray(pageList)) {
    for (const p of pageList) {
      pages[p] = (pages[p] || 0) + 1;
    }
  } else if (pageList) {
    pages[pageList] = (pages[pageList] || 0) + 1;
  }
}

// Sort and get top items
const topLocations = Object.entries(locations).sort((a, b) => b[1] - a[1]).slice(0, 10);
const topReferrers = Object.entries(referrers).sort((a, b) => b[1] - a[1]).slice(0, 10);
const topPages = Object.entries(pages).sort((a, b) => b[1] - a[1]).slice(0, 10);

console.log(\`Total Sessions: \${totalSessions}\`);
console.log(\`Total Page Visits: \${totalVisits}\`);
console.log(\`Total Clicks: \${totalClicks}\`);

for (const [loc, count] of topLocations) {
  console.log(\`  \${loc}: \${count} sessions\`);
}
`;

    const result = compileAgentCode(code, { sandboxApis });
    expect(result.success).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });
});

describe("compileDeclarations", () => {
  it("compiles TypeScript source to declaration file", () => {
    const source = `
export type MyConfig = {
  name: string;
  value: number;
};

export function doSomething(config: MyConfig): string {
  return config.name;
}
`;

    const result = compileDeclarations([{ fileName: "src/test.ts", content: source }]);

    expect(result.success).toBe(true);
    expect(result.declarations).toHaveLength(1);
    expect(result.declarations[0]?.declarationFileName).toBe("test.d.ts");
    // Should contain the type and function declarations
    expect(result.declarations[0]?.content).toContain("type MyConfig");
    expect(result.declarations[0]?.content).toContain("declare function doSomething");
  });

  it("removes src/ prefix from output path", () => {
    const source = `export function hello(): string { return "hi"; }`;

    const result = compileDeclarations([{ fileName: "src/hello.ts", content: source }]);

    expect(result.success).toBe(true);
    expect(result.declarations[0]?.declarationFileName).toBe("hello.d.ts");
    expect(result).toMatchSnapshot();
  });

  it("handles capabilities path structure", () => {
    const source = "export function connect(): void {}";

    const result = compileDeclarations([{ fileName: "src/capabilities/github/capability.ts", content: source }]);

    expect(result.success).toBe(true);
    expect(result.declarations[0]?.declarationFileName).toBe("capabilities/github/capability.d.ts");
    expect(result).toMatchSnapshot();
  });

  it("converts exports to globals", () => {
    const source = `
export type ConnectionType = "a" | "b";
export interface Config { name: string; }
export function test(x: number): number { return x * 2; }
export const MY_CONST = 42;
`;

    const result = compileDeclarations([{ fileName: "test.ts", content: source }]);

    expect(result.success).toBe(true);
    const content = result.declarations[0]?.content;

    // Should NOT have export keywords
    expect(content).not.toContain("export type");
    expect(content).not.toContain("export interface");
    expect(content).not.toContain("export declare");
    expect(content).not.toContain("export {};");
    expect(content).not.toContain("export { ");

    // Should have the declarations without export
    expect(content).toContain("type ConnectionType");
    expect(content).toContain("interface Config");
    expect(content).toContain("declare function test");
    expect(result).toMatchSnapshot();
  });

  it("generates input param comments from zod describe() metadata", () => {
    const source = `
import { action } from "@tokenspace/sdk";
import z from "zod";

const inputSchema = z.object({
  query: z.string().describe("Query text"),
  timeRange: z.object({
    earliest: z.string().describe("Earliest time"),
  }),
  limit: z.optional(z.number().describe("Maximum results")),
});

export const search = action(inputSchema, async (_args) => true);
`;

    const result = compileDeclarations([{ fileName: "src/capabilities/test/capability.ts", content: source }], {
      externalTypes: SPLUNK_TEST_EXTERNAL_TYPES,
    });

    expect(result.success).toBe(true);
    const content = result.declarations[0]?.content ?? "";
    expect(content).toContain("@param args.query Query text");
    expect(content).toContain("@param args.timeRange.earliest Earliest time");
    expect(content).toContain("@param args.limit Maximum results");
    expect(content).toContain("declare const search");
  });

  it("compiles multiple source files", () => {
    const result = compileDeclarations([
      { fileName: "src/capabilities/foo/capability.ts", content: "export function foo(): void {}" },
      { fileName: "src/capabilities/bar/capability.ts", content: "export function bar(): void {}" },
    ]);

    expect(result.success).toBe(true);
    expect(result.declarations).toHaveLength(2);

    const fileNames = result.declarations.map((d) => d.declarationFileName).sort();
    expect(fileNames).toEqual(["capabilities/bar/capability.d.ts", "capabilities/foo/capability.d.ts"]);
    expect(result).toMatchSnapshot();
  });

  it("handles empty input", () => {
    const result = compileDeclarations([]);

    expect(result.success).toBe(true);
    expect(result.declarations).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
    expect(result).toMatchSnapshot();
  });

  it("fails when source files have TypeScript diagnostics and includes file context", () => {
    const source = `
const value: string = 123;
export const broken = value;
`;

    const result = compileDeclarations([{ fileName: "src/bad.ts", content: source }]);

    expect(result.success).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);

    const diagnostic = result.diagnostics[0];
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.file).toBe("src/bad.ts");
    expect(diagnostic?.line).toBeDefined();
    expect(diagnostic?.column).toBeDefined();
    expect(diagnostic?.code).toBeGreaterThan(0);
  });

  // it("compiles the actual splunk.ts source", () => {
  //   const externalTypes = SPLUNK_TEST_EXTERNAL_TYPES;

  //   const result = compileDeclarations(
  //     [
  //       { fileName: "src/capabilities/splunk/capability.ts", content: splunkSource },
  //       { fileName: "src/credentials.ts", content: splunkCredentialsSource },
  //     ],
  //     {
  //       externalTypes,
  //     },
  //   );

  //   expect(result.success).toBe(true);
  //   const capabilityDeclaration = result.declarations.find(
  //     (decl) => decl.declarationFileName === "capabilities/splunk/capability.d.ts",
  //   );
  //   expect(capabilityDeclaration).toBeDefined();

  //   const content = capabilityDeclaration?.content;

  //   // Should have the key declarations as globals
  //   expect(content).toContain("declare const searchSplunk");
  //   expect(content).toContain("declare const splunkApiRequest");
  //   expect(content).toContain("type SearchSplunkResult");
  //   expect(content).not.toContain(`import z from "zod"`);
  //   expect(content).not.toContain(`import("zod")`);
  //   expect(content).not.toContain("z.infer<");

  //   // Should NOT have export keywords
  //   expect(content).not.toContain("export ");
  // });

  // it("generates output similar to existing capabilities/splunk/capability.d.ts", () => {
  //   const existingDeclaration = sandboxApis.find(
  //     (api) => api.fileName === "capabilities/splunk/capability.d.ts",
  //   )?.content;

  //   const externalTypes = SPLUNK_TEST_EXTERNAL_TYPES;

  //   const result = compileDeclarations(
  //     [
  //       { fileName: "src/capabilities/splunk/capability.ts", content: splunkSource },
  //       { fileName: "src/credentials.ts", content: splunkCredentialsSource },
  //     ],
  //     {
  //       externalTypes,
  //     },
  //   );

  //   expect(result.success).toBe(true);
  //   const generatedContent = result.declarations.find(
  //     (decl) => decl.declarationFileName === "capabilities/splunk/capability.d.ts",
  //   )?.content;

  //   // The generated output should contain all the key type definitions from the original
  //   // Note: The exact format may differ due to TypeScript version differences
  //   expect(generatedContent).toContain("SearchSplunkResult");
  //   expect(generatedContent).toContain("SearchSplunkResult");
  //   expect(generatedContent).toContain("SplunkApiRequestResult");
  //   expect(generatedContent).toContain("declare const searchSplunk");
  //   expect(generatedContent).toContain("declare const splunkApiRequest");
  //   expect(generatedContent).not.toContain(`import("zod")`);
  //   expect(generatedContent).not.toContain("z.infer<");

  //   // Verify the existing declaration also has these (sanity check)
  //   expect(existingDeclaration).toContain("searchSplunk");
  //   expect(existingDeclaration).toContain("splunkApiRequest");
  //   expect({
  //     success: result.success,
  //     diagnostics: result.diagnostics,
  //     declarationFileName: "capabilities/splunk/capability.d.ts",
  //     generatedContent,
  //   }).toMatchSnapshot();
  // });
});

describe("makeGlobalDeclarations", () => {
  it("removes export from declare function", () => {
    const input = "export declare function test(): void;";
    const output = makeGlobalDeclarations(input);
    expect(output).toBe("declare function test(): void;\n");
  });

  it("removes export from type", () => {
    const input = "export type Foo = string;";
    const output = makeGlobalDeclarations(input);
    expect(output).toBe("type Foo = string;\n");
  });

  it("removes export from interface", () => {
    const input = "export interface Bar { x: number; }";
    const output = makeGlobalDeclarations(input);
    expect(output).toBe("interface Bar { x: number; }\n");
  });

  it("removes export {} statements", () => {
    const input = "type Foo = string;\nexport {};";
    const output = makeGlobalDeclarations(input);
    expect(output).not.toContain("export");
    expect(output).toContain("type Foo = string;");
  });

  it("removes named export statements", () => {
    const input = "type Foo = string;\nexport { Foo };";
    const output = makeGlobalDeclarations(input);
    expect(output).not.toContain("export");
  });

  it("handles multiline declarations", () => {
    const input = `export type Config = {
  name: string;
  value: number;
};
export declare function test(x: Config): void;
export {};`;

    const output = makeGlobalDeclarations(input);
    expect(output).not.toContain("export");
    expect(output).toContain("type Config");
    expect(output).toContain("declare function test");
  });
});
