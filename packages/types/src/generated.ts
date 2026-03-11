/**
 * Auto-generated file - DO NOT EDIT
 * Run `bun run build` to regenerate
 */

/** Source: packages/sdk/src/builtin-types.ts (processed) */
export const BUILTINS = `/** Sleep for a given number of milliseconds */
declare function sleep(ms: number): Promise<void>;

/** Capture debug output for debugging. Can be accessed by users and agents only if debugging is enabled for the given job */
declare function debug(message: string, ...args: any[]): void;

/** Whether debug output is enabled for the current job */
declare const DEBUG_ENABLED: boolean;

type BashOptions = {
  /**
   * Working directory relative to \`/sandbox\` (e.g. \`"foo/bar"\` -> \`/sandbox/foo/bar\`).
   * Defaults to \`/sandbox\`.
   */
  cwd?: string;
  /** Maximum allowed execution time in milliseconds */
  timeoutMs?: number;
};

/** Execute a bash script/command in the sandbox (backed by just-bash). */
declare function bash(command: string, options?: BashOptions): Promise<string>;

type JSONValue = string | boolean | number | null | { [key: string]: JSONValue } | JSONValue[];

interface TokenspaceSession {
  readonly id: string;
  /**
   * Store a small JSON-serializable value scoped to this session.
   * Intended for lightweight state across agent tool calls within the same session.
   */
  setSessionVariable(name: string, value: JSONValue): Promise<void>;
  /**
   * Retrieve a session-scoped variable previously set via \`setSessionVariable\`.
   */
  getSessionVariable(name: string): Promise<JSONValue | undefined>;
  /**
   * Write an artifact (text or binary) scoped to this session.
   * Artifacts are intended for larger outputs that may be read by subsequent tool calls.
   */
  writeArtifact(name: string, body: ArrayBuffer | string): Promise<void>;
  /**
   * List artifact names previously written via \`writeArtifact\`.
   */
  listArtifacts(): Promise<string[]>;
  /**
   * Read an artifact previously written via \`writeArtifact\`.
   */
  readArtifact(name: string): Promise<ArrayBuffer>;
  /**
   * Read an artifact as UTF-8 text.
   */
  readArtifactText(name: string): Promise<string>;
}

declare const session: TokenspaceSession;

interface TokenspaceFilesystem {
  /** List direct children (files/dirs) of a directory path. */
  list(path: string): Promise<string[]>;
  /** Get basic metadata for a path. */
  stat(path: string): Promise<{
    isDirectory: boolean;
    isFile: boolean;
    size: number;
  }>;
  /** Read a file as raw bytes. */
  read(path: string): Promise<ArrayBuffer>;
  /** Read a file as UTF-8 text. */
  readText(path: string): Promise<string>;
  /** Write a file (creates parent directories as needed). */
  write(path: string, content: ArrayBuffer | string): Promise<void>;
  /** Delete a file or directory (recursively for directories). */
  delete(path: string): Promise<void>;
}

declare const fs: TokenspaceFilesystem;

declare class TokenspaceError extends Error {
  constructor(message: string, cause?: Error, details?: string, data?: Record<string, unknown>);
  readonly cause?: Error;
  readonly details?: string;
  readonly data?: Record<string, unknown>;
}

declare type ApprovalRequirement = {
  action: string;
  data?: Record<string, any>;
  info?: Record<string, any>;
  description?: string;
};

declare class ApprovalRequiredError extends TokenspaceError {
  constructor(req: ApprovalRequirement | ApprovalRequirement[]);
  readonly requirements: ApprovalRequirement[];
}

declare function isApprovalRequest(error: Error | unknown): error is ApprovalRequiredError;
`;

/** Source: minimal-lib.d.ts */
export const MINIMAL_LIB = `
/**
 * Minimal TypeScript lib definitions.
 * This includes basic language features but excludes browser/node globals.
 * Used by the agent sandbox for type checking generated code.
 */

// Basic types
interface Array<T> {
  length: number;
  [n: number]: T;
  push(...items: T[]): number;
  pop(): T | undefined;
  shift(): T | undefined;
  unshift(...items: T[]): number;
  slice(start?: number, end?: number): T[];
  splice(start: number, deleteCount?: number, ...items: T[]): T[];
  concat(...items: (T | ConcatArray<T>)[]): T[];
  join(separator?: string): string;
  indexOf(searchElement: T, fromIndex?: number): number;
  lastIndexOf(searchElement: T, fromIndex?: number): number;
  includes(searchElement: T, fromIndex?: number): boolean;
  forEach(callbackfn: (value: T, index: number, array: T[]) => void, thisArg?: any): void;
  map<U>(callbackfn: (value: T, index: number, array: T[]) => U, thisArg?: any): U[];
  filter(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): T[];
  filter<S extends T>(predicate: (value: T, index: number, array: T[]) => value is S, thisArg?: any): S[];
  reduce<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => U, initialValue: U): U;
  reduceRight<U>(
    callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => U,
    initialValue: U,
  ): U;
  find(predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any): T | undefined;
  find<S extends T>(predicate: (value: T, index: number, obj: T[]) => value is S, thisArg?: any): S | undefined;
  findIndex(predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any): number;
  every(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): boolean;
  some(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): boolean;
  sort(compareFn?: (a: T, b: T) => number): this;
  reverse(): T[];
  flat<D extends number = 1>(depth?: D): FlatArray<T, D>[];
  flatMap<U, This = undefined>(
    callback: (this: This, value: T, index: number, array: T[]) => U | ReadonlyArray<U>,
    thisArg?: This,
  ): U[];
  at(index: number): T | undefined;
  entries(): IterableIterator<[number, T]>;
  keys(): IterableIterator<number>;
  values(): IterableIterator<T>;
  [Symbol.iterator](): IterableIterator<T>;
}

interface ConcatArray<T> {
  readonly length: number;
  readonly [n: number]: T;
  join(separator?: string): string;
  slice(start?: number, end?: number): T[];
}

type FlatArray<Arr, Depth extends number> = Arr;

interface ReadonlyArray<T> {
  readonly length: number;
  readonly [n: number]: T;
  includes(searchElement: T, fromIndex?: number): boolean;
  indexOf(searchElement: T, fromIndex?: number): number;
  lastIndexOf(searchElement: T, fromIndex?: number): number;
  forEach(callbackfn: (value: T, index: number, array: readonly T[]) => void, thisArg?: any): void;
  map<U>(callbackfn: (value: T, index: number, array: readonly T[]) => U, thisArg?: any): U[];
  filter(predicate: (value: T, index: number, array: readonly T[]) => unknown, thisArg?: any): T[];
  reduce<U>(
    callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: readonly T[]) => U,
    initialValue: U,
  ): U;
  find(predicate: (value: T, index: number, obj: readonly T[]) => unknown, thisArg?: any): T | undefined;
  findIndex(predicate: (value: T, index: number, obj: readonly T[]) => unknown, thisArg?: any): number;
  every(predicate: (value: T, index: number, array: readonly T[]) => unknown, thisArg?: any): boolean;
  some(predicate: (value: T, index: number, array: readonly T[]) => unknown, thisArg?: any): boolean;
  slice(start?: number, end?: number): T[];
  concat(...items: (T | ConcatArray<T>)[]): T[];
  join(separator?: string): string;
  entries(): IterableIterator<[number, T]>;
  keys(): IterableIterator<number>;
  values(): IterableIterator<T>;
  [Symbol.iterator](): IterableIterator<T>;
}

interface ArrayConstructor {
  new <T>(...items: T[]): T[];
  <T>(...items: T[]): T[];
  isArray(arg: any): arg is any[];
  from<T>(arrayLike: ArrayLike<T>): T[];
  from<T, U>(arrayLike: ArrayLike<T>, mapfn: (v: T, k: number) => U, thisArg?: any): U[];
  from<T>(iterable: Iterable<T> | ArrayLike<T>): T[];
  from<T, U>(iterable: Iterable<T> | ArrayLike<T>, mapfn: (v: T, k: number) => U, thisArg?: any): U[];
  of<T>(...items: T[]): T[];
  readonly prototype: any[];
}
declare var Array: ArrayConstructor;

interface ArrayLike<T> {
  readonly length: number;
  readonly [n: number]: T;
}

interface String {
  readonly length: number;
  charAt(pos: number): string;
  charCodeAt(index: number): number;
  concat(...strings: string[]): string;
  indexOf(searchString: string, position?: number): number;
  lastIndexOf(searchString: string, position?: number): number;
  localeCompare(that: string): number;
  match(regexp: string | RegExp): RegExpMatchArray | null;
  replace(searchValue: string | RegExp, replaceValue: string): string;
  replace(searchValue: string | RegExp, replacer: (substring: string, ...args: any[]) => string): string;
  search(regexp: string | RegExp): number;
  slice(start?: number, end?: number): string;
  split(separator: string | RegExp, limit?: number): string[];
  substring(start: number, end?: number): string;
  toLowerCase(): string;
  toLocaleLowerCase(): string;
  toUpperCase(): string;
  toLocaleUpperCase(): string;
  trim(): string;
  trimStart(): string;
  trimEnd(): string;
  padStart(maxLength: number, fillString?: string): string;
  padEnd(maxLength: number, fillString?: string): string;
  repeat(count: number): string;
  startsWith(searchString: string, position?: number): boolean;
  endsWith(searchString: string, endPosition?: number): boolean;
  includes(searchString: string, position?: number): boolean;
  normalize(form?: string): string;
  at(index: number): string | undefined;
  [Symbol.iterator](): IterableIterator<string>;
}

interface StringConstructor {
  new (value?: any): String;
  (value?: any): string;
  fromCharCode(...codes: number[]): string;
  fromCodePoint(...codePoints: number[]): string;
  raw(template: TemplateStringsArray, ...substitutions: any[]): string;
  readonly prototype: String;
}
declare var String: StringConstructor;

interface Number {
  toFixed(fractionDigits?: number): string;
  toExponential(fractionDigits?: number): string;
  toPrecision(precision?: number): string;
  toString(radix?: number): string;
  toLocaleString(locales?: string | string[], options?: object): string;
  valueOf(): number;
}

interface NumberConstructor {
  new (value?: any): Number;
  (value?: any): number;
  readonly prototype: Number;
  readonly MAX_VALUE: number;
  readonly MIN_VALUE: number;
  readonly NaN: number;
  readonly NEGATIVE_INFINITY: number;
  readonly POSITIVE_INFINITY: number;
  readonly MAX_SAFE_INTEGER: number;
  readonly MIN_SAFE_INTEGER: number;
  readonly EPSILON: number;
  isFinite(number: unknown): boolean;
  isInteger(number: unknown): boolean;
  isNaN(number: unknown): boolean;
  isSafeInteger(number: unknown): boolean;
  parseFloat(string: string): number;
  parseInt(string: string, radix?: number): number;
}
declare var Number: NumberConstructor;

interface Boolean {
  valueOf(): boolean;
}

interface BooleanConstructor {
  new (value?: any): Boolean;
  <T>(value?: T): boolean;
  readonly prototype: Boolean;
}
declare var Boolean: BooleanConstructor;

interface Object {
  constructor: Function;
  toString(): string;
  valueOf(): Object;
  hasOwnProperty(v: PropertyKey): boolean;
}

interface ObjectConstructor {
  new (value?: any): Object;
  (value?: any): any;
  readonly prototype: Object;
  keys(o: object): string[];
  values<T>(o: { [s: string]: T } | ArrayLike<T>): T[];
  entries<T>(o: { [s: string]: T } | ArrayLike<T>): [string, T][];
  assign<T extends object, U>(target: T, source: U): T & U;
  assign<T extends object, U, V>(target: T, source1: U, source2: V): T & U & V;
  assign<T extends object>(target: T, ...sources: any[]): any;
  fromEntries<T = any>(entries: Iterable<readonly [PropertyKey, T]>): { [k: string]: T };
  freeze<T>(o: T): Readonly<T>;
  seal<T>(o: T): T;
  defineProperty<T>(o: T, p: PropertyKey, attributes: PropertyDescriptor & ThisType<any>): T;
  getOwnPropertyDescriptor(o: any, p: PropertyKey): PropertyDescriptor | undefined;
  getOwnPropertyNames(o: any): string[];
  getPrototypeOf(o: any): any;
  create(o: object | null, properties?: PropertyDescriptorMap & ThisType<any>): any;
  is(value1: any, value2: any): boolean;
}
declare var Object: ObjectConstructor;

interface PropertyDescriptor {
  configurable?: boolean;
  enumerable?: boolean;
  value?: any;
  writable?: boolean;
  get?(): any;
  set?(v: any): void;
}

interface PropertyDescriptorMap {
  [key: PropertyKey]: PropertyDescriptor;
}

interface Function {
  apply(this: Function, thisArg: any, argArray?: any): any;
  call(this: Function, thisArg: any, ...argArray: any[]): any;
  bind(this: Function, thisArg: any, ...argArray: any[]): any;
  toString(): string;
  prototype: any;
  readonly length: number;
  readonly name: string;
}

interface FunctionConstructor {
  new (...args: string[]): Function;
  (...args: string[]): Function;
  readonly prototype: Function;
}
declare var Function: FunctionConstructor;

interface RegExp {
  exec(string: string): RegExpExecArray | null;
  test(string: string): boolean;
  readonly source: string;
  readonly global: boolean;
  readonly ignoreCase: boolean;
  readonly multiline: boolean;
  readonly flags: string;
  lastIndex: number;
}

interface RegExpMatchArray extends Array<string> {
  index?: number;
  input?: string;
  groups?: { [key: string]: string };
}

interface RegExpExecArray extends Array<string> {
  index: number;
  input: string;
  groups?: { [key: string]: string };
}

interface RegExpConstructor {
  new (pattern: RegExp | string, flags?: string): RegExp;
  (pattern: RegExp | string, flags?: string): RegExp;
  readonly prototype: RegExp;
}
declare var RegExp: RegExpConstructor;

interface Date {
  toString(): string;
  toDateString(): string;
  toTimeString(): string;
  toLocaleString(): string;
  toLocaleDateString(): string;
  toLocaleTimeString(): string;
  valueOf(): number;
  getTime(): number;
  getFullYear(): number;
  getUTCFullYear(): number;
  getMonth(): number;
  getUTCMonth(): number;
  getDate(): number;
  getUTCDate(): number;
  getDay(): number;
  getUTCDay(): number;
  getHours(): number;
  getUTCHours(): number;
  getMinutes(): number;
  getUTCMinutes(): number;
  getSeconds(): number;
  getUTCSeconds(): number;
  getMilliseconds(): number;
  getUTCMilliseconds(): number;
  getTimezoneOffset(): number;
  setTime(time: number): number;
  setMilliseconds(ms: number): number;
  setUTCMilliseconds(ms: number): number;
  setSeconds(sec: number, ms?: number): number;
  setUTCSeconds(sec: number, ms?: number): number;
  setMinutes(min: number, sec?: number, ms?: number): number;
  setUTCMinutes(min: number, sec?: number, ms?: number): number;
  setHours(hour: number, min?: number, sec?: number, ms?: number): number;
  setUTCHours(hour: number, min?: number, sec?: number, ms?: number): number;
  setDate(date: number): number;
  setUTCDate(date: number): number;
  setMonth(month: number, date?: number): number;
  setUTCMonth(month: number, date?: number): number;
  setFullYear(year: number, month?: number, date?: number): number;
  setUTCFullYear(year: number, month?: number, date?: number): number;
  toUTCString(): string;
  toISOString(): string;
  toJSON(key?: any): string;
}

interface DateConstructor {
  new (): Date;
  new (value: number | string | Date): Date;
  new (
    year: number,
    monthIndex: number,
    date?: number,
    hours?: number,
    minutes?: number,
    seconds?: number,
    ms?: number,
  ): Date;
  (): string;
  readonly prototype: Date;
  parse(s: string): number;
  UTC(
    year: number,
    monthIndex: number,
    date?: number,
    hours?: number,
    minutes?: number,
    seconds?: number,
    ms?: number,
  ): number;
  now(): number;
}
declare var Date: DateConstructor;

interface Error {
  name: string;
  message: string;
  stack?: string;
}

interface ErrorConstructor {
  new (message?: string): Error;
  (message?: string): Error;
  readonly prototype: Error;
}
declare var Error: ErrorConstructor;

interface TypeError extends Error {}
interface TypeErrorConstructor extends ErrorConstructor {
  new (message?: string): TypeError;
  (message?: string): TypeError;
}
declare var TypeError: TypeErrorConstructor;

interface RangeError extends Error {}
interface RangeErrorConstructor extends ErrorConstructor {
  new (message?: string): RangeError;
  (message?: string): RangeError;
}
declare var RangeError: RangeErrorConstructor;

interface SyntaxError extends Error {}
interface SyntaxErrorConstructor extends ErrorConstructor {
  new (message?: string): SyntaxError;
  (message?: string): SyntaxError;
}
declare var SyntaxError: SyntaxErrorConstructor;

interface ReferenceError extends Error {}
interface ReferenceErrorConstructor extends ErrorConstructor {
  new (message?: string): ReferenceError;
  (message?: string): ReferenceError;
}
declare var ReferenceError: ReferenceErrorConstructor;

interface JSON {
  parse(text: string, reviver?: (this: any, key: string, value: any) => any): any;
  stringify(value: any, replacer?: (this: any, key: string, value: any) => any, space?: string | number): string;
  stringify(value: any, replacer?: (number | string)[] | null, space?: string | number): string;
}
declare var JSON: JSON;

interface Math {
  readonly E: number;
  readonly LN10: number;
  readonly LN2: number;
  readonly LOG2E: number;
  readonly LOG10E: number;
  readonly PI: number;
  readonly SQRT1_2: number;
  readonly SQRT2: number;
  abs(x: number): number;
  acos(x: number): number;
  asin(x: number): number;
  atan(x: number): number;
  atan2(y: number, x: number): number;
  ceil(x: number): number;
  cos(x: number): number;
  exp(x: number): number;
  floor(x: number): number;
  log(x: number): number;
  max(...values: number[]): number;
  min(...values: number[]): number;
  pow(x: number, y: number): number;
  random(): number;
  round(x: number): number;
  sin(x: number): number;
  sqrt(x: number): number;
  tan(x: number): number;
  trunc(x: number): number;
  sign(x: number): number;
  cbrt(x: number): number;
  hypot(...values: number[]): number;
  log10(x: number): number;
  log2(x: number): number;
}
declare var Math: Math;

// Promise
interface PromiseLike<T> {
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): PromiseLike<TResult1 | TResult2>;
}

interface Promise<T> {
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): Promise<TResult1 | TResult2>;
  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null,
  ): Promise<T | TResult>;
  finally(onfinally?: (() => void) | undefined | null): Promise<T>;
}

interface PromiseConstructor {
  readonly prototype: Promise<any>;
  new <T>(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void): Promise<T>;
  all<T extends readonly unknown[] | []>(values: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }>;
  race<T extends readonly unknown[] | []>(values: T): Promise<Awaited<T[number]>>;
  resolve(): Promise<void>;
  resolve<T>(value: T | PromiseLike<T>): Promise<Awaited<T>>;
  reject<T = never>(reason?: any): Promise<T>;
  allSettled<T extends readonly unknown[] | []>(
    values: T,
  ): Promise<{ -readonly [P in keyof T]: PromiseSettledResult<Awaited<T[P]>> }>;
  any<T extends readonly unknown[] | []>(values: T): Promise<Awaited<T[number]>>;
}
declare var Promise: PromiseConstructor;

interface PromiseFulfilledResult<T> {
  status: "fulfilled";
  value: T;
}

interface PromiseRejectedResult {
  status: "rejected";
  reason: any;
}

type PromiseSettledResult<T> = PromiseFulfilledResult<T> | PromiseRejectedResult;

type Awaited<T> = T extends null | undefined
  ? T
  : T extends object & { then(onfulfilled: infer F, ...args: infer _): any }
    ? F extends (value: infer V, ...args: infer _) => any
      ? Awaited<V>
      : never
    : T;

// Map and Set
interface Map<K, V> {
  readonly size: number;
  clear(): void;
  delete(key: K): boolean;
  forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: any): void;
  get(key: K): V | undefined;
  has(key: K): boolean;
  set(key: K, value: V): this;
  entries(): IterableIterator<[K, V]>;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  [Symbol.iterator](): IterableIterator<[K, V]>;
}

interface MapConstructor {
  new (): Map<any, any>;
  new <K, V>(entries?: readonly (readonly [K, V])[] | null): Map<K, V>;
  readonly prototype: Map<any, any>;
}
declare var Map: MapConstructor;

interface Set<T> {
  readonly size: number;
  add(value: T): this;
  clear(): void;
  delete(value: T): boolean;
  forEach(callbackfn: (value: T, value2: T, set: Set<T>) => void, thisArg?: any): void;
  has(value: T): boolean;
  entries(): IterableIterator<[T, T]>;
  keys(): IterableIterator<T>;
  values(): IterableIterator<T>;
  [Symbol.iterator](): IterableIterator<T>;
}

interface SetConstructor {
  new <T = any>(values?: readonly T[] | null): Set<T>;
  readonly prototype: Set<any>;
}
declare var Set: SetConstructor;

// Iterators
interface IteratorYieldResult<TYield> {
  done?: false;
  value: TYield;
}

interface IteratorReturnResult<TReturn> {
  done: true;
  value: TReturn;
}

type IteratorResult<T, TReturn = any> = IteratorYieldResult<T> | IteratorReturnResult<TReturn>;

interface Iterator<T, TReturn = any, TNext = any> {
  next(...[value]: [] | [TNext]): IteratorResult<T, TReturn>;
  return?(value?: TReturn): IteratorResult<T, TReturn>;
  throw?(e?: any): IteratorResult<T, TReturn>;
}

interface Iterable<T, TReturn = any, TNext = any> {
  [Symbol.iterator](): Iterator<T, TReturn, TNext>;
}

interface IterableIterator<T, TReturn = any, TNext = any> extends Iterator<T, TReturn, TNext> {
  [Symbol.iterator](): IterableIterator<T, TReturn, TNext>;
}

interface AsyncIterator<T, TReturn = any, TNext = any> {
  next(...[value]: [] | [TNext]): Promise<IteratorResult<T, TReturn>>;
  return?(value?: TReturn | PromiseLike<TReturn>): Promise<IteratorResult<T, TReturn>>;
  throw?(e?: any): Promise<IteratorResult<T, TReturn>>;
}

interface AsyncIterable<T, TReturn = any, TNext = any> {
  [Symbol.asyncIterator](): AsyncIterator<T, TReturn, TNext>;
}

interface AsyncIterableIterator<T, TReturn = any, TNext = any> extends AsyncIterator<T, TReturn, TNext> {
  [Symbol.asyncIterator](): AsyncIterableIterator<T, TReturn, TNext>;
}

// Generator
interface Generator<T = unknown, TReturn = any, TNext = unknown> extends Iterator<T, TReturn, TNext> {
  next(...[value]: [] | [TNext]): IteratorResult<T, TReturn>;
  return(value: TReturn): IteratorResult<T, TReturn>;
  throw(e: any): IteratorResult<T, TReturn>;
  [Symbol.iterator](): Generator<T, TReturn, TNext>;
}

interface AsyncGenerator<T = unknown, TReturn = any, TNext = unknown> extends AsyncIterator<T, TReturn, TNext> {
  next(...[value]: [] | [TNext]): Promise<IteratorResult<T, TReturn>>;
  return(value: TReturn | PromiseLike<TReturn>): Promise<IteratorResult<T, TReturn>>;
  throw(e: any): Promise<IteratorResult<T, TReturn>>;
  [Symbol.asyncIterator](): AsyncGenerator<T, TReturn, TNext>;
}

// Symbol
interface Symbol {
  readonly description: string | undefined;
  toString(): string;
  valueOf(): symbol;
}

interface SymbolConstructor {
  readonly prototype: Symbol;
  (description?: string | number): symbol;
  for(key: string): symbol;
  keyFor(sym: symbol): string | undefined;
  readonly iterator: unique symbol;
  readonly asyncIterator: unique symbol;
  readonly toStringTag: unique symbol;
  readonly hasInstance: unique symbol;
  readonly isConcatSpreadable: unique symbol;
  readonly match: unique symbol;
  readonly replace: unique symbol;
  readonly search: unique symbol;
  readonly species: unique symbol;
  readonly split: unique symbol;
  readonly toPrimitive: unique symbol;
  readonly unscopables: unique symbol;
}
declare var Symbol: SymbolConstructor;

// Template literal types
interface TemplateStringsArray extends ReadonlyArray<string> {
  readonly raw: readonly string[];
}

// Utility types
type Partial<T> = { [P in keyof T]?: T[P] };
type Required<T> = { [P in keyof T]-?: T[P] };
type Readonly<T> = { readonly [P in keyof T]: T[P] };
type Pick<T, K extends keyof T> = { [P in K]: T[P] };
type Record<K extends keyof any, T> = { [P in K]: T };
type Exclude<T, U> = T extends U ? never : T;
type Extract<T, U> = T extends U ? T : never;
type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>;
type NonNullable<T> = T & {};
type Parameters<T extends (...args: any) => any> = T extends (...args: infer P) => any ? P : never;
type ConstructorParameters<T extends abstract new (...args: any) => any> = T extends abstract new (
  ...args: infer P
) => any
  ? P
  : never;
type ReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R : any;
type InstanceType<T extends abstract new (...args: any) => any> = T extends abstract new (
  ...args: any
) => infer R
  ? R
  : any;
type ThisParameterType<T> = T extends (this: infer U, ...args: never) => any ? U : unknown;
type OmitThisParameter<T> =
  unknown extends ThisParameterType<T> ? T : T extends (...args: infer A) => infer R ? (...args: A) => R : T;
type Uppercase<S extends string> = intrinsic;
type Lowercase<S extends string> = intrinsic;
type Capitalize<S extends string> = intrinsic;
type Uncapitalize<S extends string> = intrinsic;
type NoInfer<T> = intrinsic;

type PropertyKey = string | number | symbol;

// ArrayBuffer and typed arrays (minimal, read-only focused)
interface ArrayBuffer {
  readonly byteLength: number;
  slice(begin: number, end?: number): ArrayBuffer;
}

interface ArrayBufferConstructor {
  readonly prototype: ArrayBuffer;
  new (byteLength: number): ArrayBuffer;
  isView(arg: any): arg is ArrayBufferView;
}
declare var ArrayBuffer: ArrayBufferConstructor;

interface ArrayBufferView {
  buffer: ArrayBufferLike;
  byteLength: number;
  byteOffset: number;
}

type ArrayBufferLike = ArrayBuffer;

interface DataView {
  readonly buffer: ArrayBuffer;
  readonly byteLength: number;
  readonly byteOffset: number;
  getFloat32(byteOffset: number, littleEndian?: boolean): number;
  getFloat64(byteOffset: number, littleEndian?: boolean): number;
  getInt8(byteOffset: number): number;
  getInt16(byteOffset: number, littleEndian?: boolean): number;
  getInt32(byteOffset: number, littleEndian?: boolean): number;
  getUint8(byteOffset: number): number;
  getUint16(byteOffset: number, littleEndian?: boolean): number;
  getUint32(byteOffset: number, littleEndian?: boolean): number;
  setFloat32(byteOffset: number, value: number, littleEndian?: boolean): void;
  setFloat64(byteOffset: number, value: number, littleEndian?: boolean): void;
  setInt8(byteOffset: number, value: number): void;
  setInt16(byteOffset: number, value: number, littleEndian?: boolean): void;
  setInt32(byteOffset: number, value: number, littleEndian?: boolean): void;
  setUint8(byteOffset: number, value: number): void;
  setUint16(byteOffset: number, value: number, littleEndian?: boolean): void;
  setUint32(byteOffset: number, value: number, littleEndian?: boolean): void;
}

interface DataViewConstructor {
  readonly prototype: DataView;
  new (buffer: ArrayBufferLike, byteOffset?: number, byteLength?: number): DataView;
}
declare var DataView: DataViewConstructor;

interface Uint8Array {
  readonly BYTES_PER_ELEMENT: number;
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
  readonly byteOffset: number;
  readonly length: number;
  [index: number]: number;
  copyWithin(target: number, start: number, end?: number): this;
  every(predicate: (value: number, index: number, array: Uint8Array) => unknown): boolean;
  fill(value: number, start?: number, end?: number): this;
  filter(predicate: (value: number, index: number, array: Uint8Array) => unknown): Uint8Array;
  find(predicate: (value: number, index: number, array: Uint8Array) => boolean): number | undefined;
  findIndex(predicate: (value: number, index: number, array: Uint8Array) => boolean): number;
  forEach(callbackfn: (value: number, index: number, array: Uint8Array) => void): void;
  includes(searchElement: number, fromIndex?: number): boolean;
  indexOf(searchElement: number, fromIndex?: number): number;
  join(separator?: string): string;
  lastIndexOf(searchElement: number, fromIndex?: number): number;
  map(callbackfn: (value: number, index: number, array: Uint8Array) => number): Uint8Array;
  reduce<U>(
    callbackfn: (previousValue: U, currentValue: number, currentIndex: number, array: Uint8Array) => U,
    initialValue: U,
  ): U;
  reduceRight<U>(
    callbackfn: (previousValue: U, currentValue: number, currentIndex: number, array: Uint8Array) => U,
    initialValue: U,
  ): U;
  reverse(): Uint8Array;
  set(array: ArrayLike<number>, offset?: number): void;
  slice(start?: number, end?: number): Uint8Array;
  some(predicate: (value: number, index: number, array: Uint8Array) => unknown): boolean;
  sort(compareFn?: (a: number, b: number) => number): this;
  subarray(begin?: number, end?: number): Uint8Array;
  valueOf(): Uint8Array;
  entries(): IterableIterator<[number, number]>;
  keys(): IterableIterator<number>;
  values(): IterableIterator<number>;
  [Symbol.iterator](): IterableIterator<number>;
}

interface Uint8ArrayConstructor {
  readonly prototype: Uint8Array;
  readonly BYTES_PER_ELEMENT: number;
  new (length: number): Uint8Array;
  new (array: ArrayLike<number>): Uint8Array;
  new (buffer: ArrayBufferLike, byteOffset?: number, length?: number): Uint8Array;
  from(arrayLike: ArrayLike<number>): Uint8Array;
  from<T>(arrayLike: ArrayLike<T>, mapfn: (v: T, k: number) => number): Uint8Array;
  of(...items: number[]): Uint8Array;
}
declare var Uint8Array: Uint8ArrayConstructor;

// TextEncoder/TextDecoder (useful for string <-> ArrayBuffer)
interface TextEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
}

interface TextEncoderConstructor {
  new (): TextEncoder;
}
declare var TextEncoder: TextEncoderConstructor;

interface TextDecoder {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  decode(input?: ArrayBufferView | ArrayBuffer, options?: { stream?: boolean }): string;
}

interface TextDecoderConstructor {
  new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder;
}
declare var TextDecoder: TextDecoderConstructor;

// Console - minimal, for debugging only
interface Console {
  log(...data: any[]): void;
  warn(...data: any[]): void;
  error(...data: any[]): void;
  info(...data: any[]): void;
  debug(...data: any[]): void;
}
declare var console: Console;

// URL and URLSearchParams - needed for HTTP-related code
interface URL {
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  readonly searchParams: URLSearchParams;
  username: string;
  toString(): string;
  toJSON(): string;
}

interface URLConstructor {
  new (url: string | URL, base?: string | URL): URL;
  readonly prototype: URL;
  canParse(url: string | URL, base?: string | URL): boolean;
}
declare var URL: URLConstructor;

interface URLSearchParams {
  append(name: string, value: string): void;
  delete(name: string, value?: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string, value?: string): boolean;
  set(name: string, value: string): void;
  sort(): void;
  toString(): string;
  forEach(callbackfn: (value: string, key: string, parent: URLSearchParams) => void, thisArg?: any): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
  readonly size: number;
}

interface URLSearchParamsConstructor {
  new (init?: string[][] | Record<string, string> | string | URLSearchParams): URLSearchParams;
  readonly prototype: URLSearchParams;
}
declare var URLSearchParams: URLSearchParamsConstructor;

// Headers - for HTTP request/response headers
interface Headers {
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  getSetCookie(): string[];
  has(name: string): boolean;
  set(name: string, value: string): void;
  forEach(callbackfn: (value: string, key: string, parent: Headers) => void, thisArg?: any): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

interface HeadersConstructor {
  new (init?: HeadersInit): Headers;
  readonly prototype: Headers;
}
declare var Headers: HeadersConstructor;

type HeadersInit = Headers | string[][] | Record<string, string>;

// Response - for HTTP responses
interface Body {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  formData(): Promise<FormData>;
  json(): Promise<any>;
  text(): Promise<string>;
}

interface Response extends Body {
  readonly headers: Headers;
  readonly ok: boolean;
  readonly redirected: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly type: ResponseType;
  readonly url: string;
  clone(): Response;
}

interface ResponseConstructor {
  new (body?: BodyInit | null, init?: ResponseInit): Response;
  readonly prototype: Response;
  error(): Response;
  json(data: any, init?: ResponseInit): Response;
  redirect(url: string | URL, status?: number): Response;
}
declare var Response: ResponseConstructor;

interface ResponseInit {
  headers?: HeadersInit;
  status?: number;
  statusText?: string;
}

type ResponseType = "basic" | "cors" | "default" | "error" | "opaque" | "opaqueredirect";

type BodyInit = ReadableStream<Uint8Array> | Blob | BufferSource | FormData | URLSearchParams | string;

// Minimal Blob interface
interface Blob {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  slice(start?: number, end?: number, contentType?: string): Blob;
  stream(): ReadableStream<Uint8Array>;
  text(): Promise<string>;
}

// Minimal FormData interface
interface FormData {
  append(name: string, value: string | Blob, fileName?: string): void;
  delete(name: string): void;
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
  has(name: string): boolean;
  set(name: string, value: string | Blob, fileName?: string): void;
  forEach(callbackfn: (value: FormDataEntryValue, key: string, parent: FormData) => void, thisArg?: any): void;
  entries(): IterableIterator<[string, FormDataEntryValue]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<FormDataEntryValue>;
  [Symbol.iterator](): IterableIterator<[string, FormDataEntryValue]>;
}

type FormDataEntryValue = File | string;

// Minimal File interface
interface File extends Blob {
  readonly lastModified: number;
  readonly name: string;
  readonly webkitRelativePath: string;
}

// Minimal ReadableStream interface
interface ReadableStream<R = any> {
  readonly locked: boolean;
  cancel(reason?: any): Promise<void>;
  getReader(): ReadableStreamDefaultReader<R>;
  pipeThrough<T>(transform: ReadableWritablePair<T, R>, options?: StreamPipeOptions): ReadableStream<T>;
  pipeTo(destination: WritableStream<R>, options?: StreamPipeOptions): Promise<void>;
  tee(): [ReadableStream<R>, ReadableStream<R>];
}

interface ReadableStreamDefaultReader<R = any> {
  readonly closed: Promise<undefined>;
  cancel(reason?: any): Promise<void>;
  read(): Promise<ReadableStreamReadResult<R>>;
  releaseLock(): void;
}

type ReadableStreamReadResult<T> = ReadableStreamReadValueResult<T> | ReadableStreamReadDoneResult;

interface ReadableStreamReadValueResult<T> {
  done: false;
  value: T;
}

interface ReadableStreamReadDoneResult {
  done: true;
  value?: undefined;
}

interface ReadableWritablePair<R = any, W = any> {
  readable: ReadableStream<R>;
  writable: WritableStream<W>;
}

interface StreamPipeOptions {
  preventAbort?: boolean;
  preventCancel?: boolean;
  preventClose?: boolean;
  signal?: AbortSignal;
}

interface WritableStream<W = any> {
  readonly locked: boolean;
  abort(reason?: any): Promise<void>;
  close(): Promise<void>;
  getWriter(): WritableStreamDefaultWriter<W>;
}

interface WritableStreamDefaultWriter<W = any> {
  readonly closed: Promise<undefined>;
  readonly desiredSize: number | null;
  readonly ready: Promise<undefined>;
  abort(reason?: any): Promise<void>;
  close(): Promise<void>;
  releaseLock(): void;
  write(chunk?: W): Promise<void>;
}

// AbortSignal and AbortController
interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: any;
  onabort: ((this: AbortSignal, ev: Event) => any) | null;
  throwIfAborted(): void;
}

interface AbortController {
  readonly signal: AbortSignal;
  abort(reason?: any): void;
}

interface AbortControllerConstructor {
  new (): AbortController;
  readonly prototype: AbortController;
}
declare var AbortController: AbortControllerConstructor;

// Minimal Event interface for AbortSignal
interface Event {
  readonly bubbles: boolean;
  cancelBubble: boolean;
  readonly cancelable: boolean;
  readonly composed: boolean;
  readonly currentTarget: EventTarget | null;
  readonly defaultPrevented: boolean;
  readonly eventPhase: number;
  readonly isTrusted: boolean;
  readonly target: EventTarget | null;
  readonly timeStamp: number;
  readonly type: string;
  composedPath(): EventTarget[];
  preventDefault(): void;
  stopImmediatePropagation(): void;
  stopPropagation(): void;
}

interface EventTarget {
  addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void;
  dispatchEvent(event: Event): boolean;
  removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void;
}

interface EventListener {
  (evt: Event): void;
}

interface EventListenerObject {
  handleEvent(object: Event): void;
}

type EventListenerOrEventListenerObject = EventListener | EventListenerObject;

interface AddEventListenerOptions extends EventListenerOptions {
  once?: boolean;
  passive?: boolean;
  signal?: AbortSignal;
}

interface EventListenerOptions {
  capture?: boolean;
}

type BufferSource = ArrayBufferView | ArrayBuffer;

// Global values
declare var undefined: undefined;
declare var NaN: number;
declare var Infinity: number;

declare function parseInt(string: string, radix?: number): number;
declare function parseFloat(string: string): number;
declare function isNaN(number: number): boolean;
declare function isFinite(number: number): boolean;
declare function encodeURIComponent(uriComponent: string | number | boolean): string;
declare function decodeURIComponent(encodedURIComponent: string): string;
declare function encodeURI(uri: string): string;
declare function decodeURI(encodedURI: string): string;

// Explicitly NOT included:
// - fetch, Request, Response, Headers (use sandbox APIs)
// - setTimeout, setInterval, clearTimeout, clearInterval
// - process, require, module, __dirname, __filename
// - window, document, localStorage, sessionStorage
// - fs, path, http, https, net, child_process
// - Buffer (node), Blob, File, FileReader
// - WebSocket, EventSource, XMLHttpRequest
// - crypto (use sandbox APIs if needed)
// - Worker, SharedWorker, ServiceWorker
`;

export const SANDBOX_TYPES = `/** Sleep for a given number of milliseconds */
declare function sleep(ms: number): Promise<void>;

/** Capture debug output for debugging. Can be accessed by users and agents only if debugging is enabled for the given job */
declare function debug(message: string, ...args: any[]): void;

/** Whether debug output is enabled for the current job */
declare const DEBUG_ENABLED: boolean;

type BashOptions = {
  /**
   * Working directory relative to \`/sandbox\` (e.g. \`"foo/bar"\` -> \`/sandbox/foo/bar\`).
   * Defaults to \`/sandbox\`.
   */
  cwd?: string;
  /** Maximum allowed execution time in milliseconds */
  timeoutMs?: number;
};

/** Execute a bash script/command in the sandbox (backed by just-bash). */
declare function bash(command: string, options?: BashOptions): Promise<string>;

type JSONValue = string | boolean | number | null | { [key: string]: JSONValue } | JSONValue[];

interface TokenspaceSession {
  readonly id: string;
  /**
   * Store a small JSON-serializable value scoped to this session.
   * Intended for lightweight state across agent tool calls within the same session.
   */
  setSessionVariable(name: string, value: JSONValue): Promise<void>;
  /**
   * Retrieve a session-scoped variable previously set via \`setSessionVariable\`.
   */
  getSessionVariable(name: string): Promise<JSONValue | undefined>;
  /**
   * Write an artifact (text or binary) scoped to this session.
   * Artifacts are intended for larger outputs that may be read by subsequent tool calls.
   */
  writeArtifact(name: string, body: ArrayBuffer | string): Promise<void>;
  /**
   * List artifact names previously written via \`writeArtifact\`.
   */
  listArtifacts(): Promise<string[]>;
  /**
   * Read an artifact previously written via \`writeArtifact\`.
   */
  readArtifact(name: string): Promise<ArrayBuffer>;
  /**
   * Read an artifact as UTF-8 text.
   */
  readArtifactText(name: string): Promise<string>;
}

declare const session: TokenspaceSession;

interface TokenspaceFilesystem {
  /** List direct children (files/dirs) of a directory path. */
  list(path: string): Promise<string[]>;
  /** Get basic metadata for a path. */
  stat(path: string): Promise<{
    isDirectory: boolean;
    isFile: boolean;
    size: number;
  }>;
  /** Read a file as raw bytes. */
  read(path: string): Promise<ArrayBuffer>;
  /** Read a file as UTF-8 text. */
  readText(path: string): Promise<string>;
  /** Write a file (creates parent directories as needed). */
  write(path: string, content: ArrayBuffer | string): Promise<void>;
  /** Delete a file or directory (recursively for directories). */
  delete(path: string): Promise<void>;
}

declare const fs: TokenspaceFilesystem;

declare class TokenspaceError extends Error {
  constructor(message: string, cause?: Error, details?: string, data?: Record<string, unknown>);
  readonly cause?: Error;
  readonly details?: string;
  readonly data?: Record<string, unknown>;
}

declare type ApprovalRequirement = {
  action: string;
  data?: Record<string, any>;
  info?: Record<string, any>;
  description?: string;
};

declare class ApprovalRequiredError extends TokenspaceError {
  constructor(req: ApprovalRequirement | ApprovalRequirement[]);
  readonly requirements: ApprovalRequirement[];
}

declare function isApprovalRequest(error: Error | unknown): error is ApprovalRequiredError;


/**
 * Minimal TypeScript lib definitions.
 * This includes basic language features but excludes browser/node globals.
 * Used by the agent sandbox for type checking generated code.
 */

// Basic types
interface Array<T> {
  length: number;
  [n: number]: T;
  push(...items: T[]): number;
  pop(): T | undefined;
  shift(): T | undefined;
  unshift(...items: T[]): number;
  slice(start?: number, end?: number): T[];
  splice(start: number, deleteCount?: number, ...items: T[]): T[];
  concat(...items: (T | ConcatArray<T>)[]): T[];
  join(separator?: string): string;
  indexOf(searchElement: T, fromIndex?: number): number;
  lastIndexOf(searchElement: T, fromIndex?: number): number;
  includes(searchElement: T, fromIndex?: number): boolean;
  forEach(callbackfn: (value: T, index: number, array: T[]) => void, thisArg?: any): void;
  map<U>(callbackfn: (value: T, index: number, array: T[]) => U, thisArg?: any): U[];
  filter(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): T[];
  filter<S extends T>(predicate: (value: T, index: number, array: T[]) => value is S, thisArg?: any): S[];
  reduce<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => U, initialValue: U): U;
  reduceRight<U>(
    callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => U,
    initialValue: U,
  ): U;
  find(predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any): T | undefined;
  find<S extends T>(predicate: (value: T, index: number, obj: T[]) => value is S, thisArg?: any): S | undefined;
  findIndex(predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any): number;
  every(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): boolean;
  some(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): boolean;
  sort(compareFn?: (a: T, b: T) => number): this;
  reverse(): T[];
  flat<D extends number = 1>(depth?: D): FlatArray<T, D>[];
  flatMap<U, This = undefined>(
    callback: (this: This, value: T, index: number, array: T[]) => U | ReadonlyArray<U>,
    thisArg?: This,
  ): U[];
  at(index: number): T | undefined;
  entries(): IterableIterator<[number, T]>;
  keys(): IterableIterator<number>;
  values(): IterableIterator<T>;
  [Symbol.iterator](): IterableIterator<T>;
}

interface ConcatArray<T> {
  readonly length: number;
  readonly [n: number]: T;
  join(separator?: string): string;
  slice(start?: number, end?: number): T[];
}

type FlatArray<Arr, Depth extends number> = Arr;

interface ReadonlyArray<T> {
  readonly length: number;
  readonly [n: number]: T;
  includes(searchElement: T, fromIndex?: number): boolean;
  indexOf(searchElement: T, fromIndex?: number): number;
  lastIndexOf(searchElement: T, fromIndex?: number): number;
  forEach(callbackfn: (value: T, index: number, array: readonly T[]) => void, thisArg?: any): void;
  map<U>(callbackfn: (value: T, index: number, array: readonly T[]) => U, thisArg?: any): U[];
  filter(predicate: (value: T, index: number, array: readonly T[]) => unknown, thisArg?: any): T[];
  reduce<U>(
    callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: readonly T[]) => U,
    initialValue: U,
  ): U;
  find(predicate: (value: T, index: number, obj: readonly T[]) => unknown, thisArg?: any): T | undefined;
  findIndex(predicate: (value: T, index: number, obj: readonly T[]) => unknown, thisArg?: any): number;
  every(predicate: (value: T, index: number, array: readonly T[]) => unknown, thisArg?: any): boolean;
  some(predicate: (value: T, index: number, array: readonly T[]) => unknown, thisArg?: any): boolean;
  slice(start?: number, end?: number): T[];
  concat(...items: (T | ConcatArray<T>)[]): T[];
  join(separator?: string): string;
  entries(): IterableIterator<[number, T]>;
  keys(): IterableIterator<number>;
  values(): IterableIterator<T>;
  [Symbol.iterator](): IterableIterator<T>;
}

interface ArrayConstructor {
  new <T>(...items: T[]): T[];
  <T>(...items: T[]): T[];
  isArray(arg: any): arg is any[];
  from<T>(arrayLike: ArrayLike<T>): T[];
  from<T, U>(arrayLike: ArrayLike<T>, mapfn: (v: T, k: number) => U, thisArg?: any): U[];
  from<T>(iterable: Iterable<T> | ArrayLike<T>): T[];
  from<T, U>(iterable: Iterable<T> | ArrayLike<T>, mapfn: (v: T, k: number) => U, thisArg?: any): U[];
  of<T>(...items: T[]): T[];
  readonly prototype: any[];
}
declare var Array: ArrayConstructor;

interface ArrayLike<T> {
  readonly length: number;
  readonly [n: number]: T;
}

interface String {
  readonly length: number;
  charAt(pos: number): string;
  charCodeAt(index: number): number;
  concat(...strings: string[]): string;
  indexOf(searchString: string, position?: number): number;
  lastIndexOf(searchString: string, position?: number): number;
  localeCompare(that: string): number;
  match(regexp: string | RegExp): RegExpMatchArray | null;
  replace(searchValue: string | RegExp, replaceValue: string): string;
  replace(searchValue: string | RegExp, replacer: (substring: string, ...args: any[]) => string): string;
  search(regexp: string | RegExp): number;
  slice(start?: number, end?: number): string;
  split(separator: string | RegExp, limit?: number): string[];
  substring(start: number, end?: number): string;
  toLowerCase(): string;
  toLocaleLowerCase(): string;
  toUpperCase(): string;
  toLocaleUpperCase(): string;
  trim(): string;
  trimStart(): string;
  trimEnd(): string;
  padStart(maxLength: number, fillString?: string): string;
  padEnd(maxLength: number, fillString?: string): string;
  repeat(count: number): string;
  startsWith(searchString: string, position?: number): boolean;
  endsWith(searchString: string, endPosition?: number): boolean;
  includes(searchString: string, position?: number): boolean;
  normalize(form?: string): string;
  at(index: number): string | undefined;
  [Symbol.iterator](): IterableIterator<string>;
}

interface StringConstructor {
  new (value?: any): String;
  (value?: any): string;
  fromCharCode(...codes: number[]): string;
  fromCodePoint(...codePoints: number[]): string;
  raw(template: TemplateStringsArray, ...substitutions: any[]): string;
  readonly prototype: String;
}
declare var String: StringConstructor;

interface Number {
  toFixed(fractionDigits?: number): string;
  toExponential(fractionDigits?: number): string;
  toPrecision(precision?: number): string;
  toString(radix?: number): string;
  toLocaleString(locales?: string | string[], options?: object): string;
  valueOf(): number;
}

interface NumberConstructor {
  new (value?: any): Number;
  (value?: any): number;
  readonly prototype: Number;
  readonly MAX_VALUE: number;
  readonly MIN_VALUE: number;
  readonly NaN: number;
  readonly NEGATIVE_INFINITY: number;
  readonly POSITIVE_INFINITY: number;
  readonly MAX_SAFE_INTEGER: number;
  readonly MIN_SAFE_INTEGER: number;
  readonly EPSILON: number;
  isFinite(number: unknown): boolean;
  isInteger(number: unknown): boolean;
  isNaN(number: unknown): boolean;
  isSafeInteger(number: unknown): boolean;
  parseFloat(string: string): number;
  parseInt(string: string, radix?: number): number;
}
declare var Number: NumberConstructor;

interface Boolean {
  valueOf(): boolean;
}

interface BooleanConstructor {
  new (value?: any): Boolean;
  <T>(value?: T): boolean;
  readonly prototype: Boolean;
}
declare var Boolean: BooleanConstructor;

interface Object {
  constructor: Function;
  toString(): string;
  valueOf(): Object;
  hasOwnProperty(v: PropertyKey): boolean;
}

interface ObjectConstructor {
  new (value?: any): Object;
  (value?: any): any;
  readonly prototype: Object;
  keys(o: object): string[];
  values<T>(o: { [s: string]: T } | ArrayLike<T>): T[];
  entries<T>(o: { [s: string]: T } | ArrayLike<T>): [string, T][];
  assign<T extends object, U>(target: T, source: U): T & U;
  assign<T extends object, U, V>(target: T, source1: U, source2: V): T & U & V;
  assign<T extends object>(target: T, ...sources: any[]): any;
  fromEntries<T = any>(entries: Iterable<readonly [PropertyKey, T]>): { [k: string]: T };
  freeze<T>(o: T): Readonly<T>;
  seal<T>(o: T): T;
  defineProperty<T>(o: T, p: PropertyKey, attributes: PropertyDescriptor & ThisType<any>): T;
  getOwnPropertyDescriptor(o: any, p: PropertyKey): PropertyDescriptor | undefined;
  getOwnPropertyNames(o: any): string[];
  getPrototypeOf(o: any): any;
  create(o: object | null, properties?: PropertyDescriptorMap & ThisType<any>): any;
  is(value1: any, value2: any): boolean;
}
declare var Object: ObjectConstructor;

interface PropertyDescriptor {
  configurable?: boolean;
  enumerable?: boolean;
  value?: any;
  writable?: boolean;
  get?(): any;
  set?(v: any): void;
}

interface PropertyDescriptorMap {
  [key: PropertyKey]: PropertyDescriptor;
}

interface Function {
  apply(this: Function, thisArg: any, argArray?: any): any;
  call(this: Function, thisArg: any, ...argArray: any[]): any;
  bind(this: Function, thisArg: any, ...argArray: any[]): any;
  toString(): string;
  prototype: any;
  readonly length: number;
  readonly name: string;
}

interface FunctionConstructor {
  new (...args: string[]): Function;
  (...args: string[]): Function;
  readonly prototype: Function;
}
declare var Function: FunctionConstructor;

interface RegExp {
  exec(string: string): RegExpExecArray | null;
  test(string: string): boolean;
  readonly source: string;
  readonly global: boolean;
  readonly ignoreCase: boolean;
  readonly multiline: boolean;
  readonly flags: string;
  lastIndex: number;
}

interface RegExpMatchArray extends Array<string> {
  index?: number;
  input?: string;
  groups?: { [key: string]: string };
}

interface RegExpExecArray extends Array<string> {
  index: number;
  input: string;
  groups?: { [key: string]: string };
}

interface RegExpConstructor {
  new (pattern: RegExp | string, flags?: string): RegExp;
  (pattern: RegExp | string, flags?: string): RegExp;
  readonly prototype: RegExp;
}
declare var RegExp: RegExpConstructor;

interface Date {
  toString(): string;
  toDateString(): string;
  toTimeString(): string;
  toLocaleString(): string;
  toLocaleDateString(): string;
  toLocaleTimeString(): string;
  valueOf(): number;
  getTime(): number;
  getFullYear(): number;
  getUTCFullYear(): number;
  getMonth(): number;
  getUTCMonth(): number;
  getDate(): number;
  getUTCDate(): number;
  getDay(): number;
  getUTCDay(): number;
  getHours(): number;
  getUTCHours(): number;
  getMinutes(): number;
  getUTCMinutes(): number;
  getSeconds(): number;
  getUTCSeconds(): number;
  getMilliseconds(): number;
  getUTCMilliseconds(): number;
  getTimezoneOffset(): number;
  setTime(time: number): number;
  setMilliseconds(ms: number): number;
  setUTCMilliseconds(ms: number): number;
  setSeconds(sec: number, ms?: number): number;
  setUTCSeconds(sec: number, ms?: number): number;
  setMinutes(min: number, sec?: number, ms?: number): number;
  setUTCMinutes(min: number, sec?: number, ms?: number): number;
  setHours(hour: number, min?: number, sec?: number, ms?: number): number;
  setUTCHours(hour: number, min?: number, sec?: number, ms?: number): number;
  setDate(date: number): number;
  setUTCDate(date: number): number;
  setMonth(month: number, date?: number): number;
  setUTCMonth(month: number, date?: number): number;
  setFullYear(year: number, month?: number, date?: number): number;
  setUTCFullYear(year: number, month?: number, date?: number): number;
  toUTCString(): string;
  toISOString(): string;
  toJSON(key?: any): string;
}

interface DateConstructor {
  new (): Date;
  new (value: number | string | Date): Date;
  new (
    year: number,
    monthIndex: number,
    date?: number,
    hours?: number,
    minutes?: number,
    seconds?: number,
    ms?: number,
  ): Date;
  (): string;
  readonly prototype: Date;
  parse(s: string): number;
  UTC(
    year: number,
    monthIndex: number,
    date?: number,
    hours?: number,
    minutes?: number,
    seconds?: number,
    ms?: number,
  ): number;
  now(): number;
}
declare var Date: DateConstructor;

interface Error {
  name: string;
  message: string;
  stack?: string;
}

interface ErrorConstructor {
  new (message?: string): Error;
  (message?: string): Error;
  readonly prototype: Error;
}
declare var Error: ErrorConstructor;

interface TypeError extends Error {}
interface TypeErrorConstructor extends ErrorConstructor {
  new (message?: string): TypeError;
  (message?: string): TypeError;
}
declare var TypeError: TypeErrorConstructor;

interface RangeError extends Error {}
interface RangeErrorConstructor extends ErrorConstructor {
  new (message?: string): RangeError;
  (message?: string): RangeError;
}
declare var RangeError: RangeErrorConstructor;

interface SyntaxError extends Error {}
interface SyntaxErrorConstructor extends ErrorConstructor {
  new (message?: string): SyntaxError;
  (message?: string): SyntaxError;
}
declare var SyntaxError: SyntaxErrorConstructor;

interface ReferenceError extends Error {}
interface ReferenceErrorConstructor extends ErrorConstructor {
  new (message?: string): ReferenceError;
  (message?: string): ReferenceError;
}
declare var ReferenceError: ReferenceErrorConstructor;

interface JSON {
  parse(text: string, reviver?: (this: any, key: string, value: any) => any): any;
  stringify(value: any, replacer?: (this: any, key: string, value: any) => any, space?: string | number): string;
  stringify(value: any, replacer?: (number | string)[] | null, space?: string | number): string;
}
declare var JSON: JSON;

interface Math {
  readonly E: number;
  readonly LN10: number;
  readonly LN2: number;
  readonly LOG2E: number;
  readonly LOG10E: number;
  readonly PI: number;
  readonly SQRT1_2: number;
  readonly SQRT2: number;
  abs(x: number): number;
  acos(x: number): number;
  asin(x: number): number;
  atan(x: number): number;
  atan2(y: number, x: number): number;
  ceil(x: number): number;
  cos(x: number): number;
  exp(x: number): number;
  floor(x: number): number;
  log(x: number): number;
  max(...values: number[]): number;
  min(...values: number[]): number;
  pow(x: number, y: number): number;
  random(): number;
  round(x: number): number;
  sin(x: number): number;
  sqrt(x: number): number;
  tan(x: number): number;
  trunc(x: number): number;
  sign(x: number): number;
  cbrt(x: number): number;
  hypot(...values: number[]): number;
  log10(x: number): number;
  log2(x: number): number;
}
declare var Math: Math;

// Promise
interface PromiseLike<T> {
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): PromiseLike<TResult1 | TResult2>;
}

interface Promise<T> {
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): Promise<TResult1 | TResult2>;
  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null,
  ): Promise<T | TResult>;
  finally(onfinally?: (() => void) | undefined | null): Promise<T>;
}

interface PromiseConstructor {
  readonly prototype: Promise<any>;
  new <T>(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void): Promise<T>;
  all<T extends readonly unknown[] | []>(values: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }>;
  race<T extends readonly unknown[] | []>(values: T): Promise<Awaited<T[number]>>;
  resolve(): Promise<void>;
  resolve<T>(value: T | PromiseLike<T>): Promise<Awaited<T>>;
  reject<T = never>(reason?: any): Promise<T>;
  allSettled<T extends readonly unknown[] | []>(
    values: T,
  ): Promise<{ -readonly [P in keyof T]: PromiseSettledResult<Awaited<T[P]>> }>;
  any<T extends readonly unknown[] | []>(values: T): Promise<Awaited<T[number]>>;
}
declare var Promise: PromiseConstructor;

interface PromiseFulfilledResult<T> {
  status: "fulfilled";
  value: T;
}

interface PromiseRejectedResult {
  status: "rejected";
  reason: any;
}

type PromiseSettledResult<T> = PromiseFulfilledResult<T> | PromiseRejectedResult;

type Awaited<T> = T extends null | undefined
  ? T
  : T extends object & { then(onfulfilled: infer F, ...args: infer _): any }
    ? F extends (value: infer V, ...args: infer _) => any
      ? Awaited<V>
      : never
    : T;

// Map and Set
interface Map<K, V> {
  readonly size: number;
  clear(): void;
  delete(key: K): boolean;
  forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: any): void;
  get(key: K): V | undefined;
  has(key: K): boolean;
  set(key: K, value: V): this;
  entries(): IterableIterator<[K, V]>;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  [Symbol.iterator](): IterableIterator<[K, V]>;
}

interface MapConstructor {
  new (): Map<any, any>;
  new <K, V>(entries?: readonly (readonly [K, V])[] | null): Map<K, V>;
  readonly prototype: Map<any, any>;
}
declare var Map: MapConstructor;

interface Set<T> {
  readonly size: number;
  add(value: T): this;
  clear(): void;
  delete(value: T): boolean;
  forEach(callbackfn: (value: T, value2: T, set: Set<T>) => void, thisArg?: any): void;
  has(value: T): boolean;
  entries(): IterableIterator<[T, T]>;
  keys(): IterableIterator<T>;
  values(): IterableIterator<T>;
  [Symbol.iterator](): IterableIterator<T>;
}

interface SetConstructor {
  new <T = any>(values?: readonly T[] | null): Set<T>;
  readonly prototype: Set<any>;
}
declare var Set: SetConstructor;

// Iterators
interface IteratorYieldResult<TYield> {
  done?: false;
  value: TYield;
}

interface IteratorReturnResult<TReturn> {
  done: true;
  value: TReturn;
}

type IteratorResult<T, TReturn = any> = IteratorYieldResult<T> | IteratorReturnResult<TReturn>;

interface Iterator<T, TReturn = any, TNext = any> {
  next(...[value]: [] | [TNext]): IteratorResult<T, TReturn>;
  return?(value?: TReturn): IteratorResult<T, TReturn>;
  throw?(e?: any): IteratorResult<T, TReturn>;
}

interface Iterable<T, TReturn = any, TNext = any> {
  [Symbol.iterator](): Iterator<T, TReturn, TNext>;
}

interface IterableIterator<T, TReturn = any, TNext = any> extends Iterator<T, TReturn, TNext> {
  [Symbol.iterator](): IterableIterator<T, TReturn, TNext>;
}

interface AsyncIterator<T, TReturn = any, TNext = any> {
  next(...[value]: [] | [TNext]): Promise<IteratorResult<T, TReturn>>;
  return?(value?: TReturn | PromiseLike<TReturn>): Promise<IteratorResult<T, TReturn>>;
  throw?(e?: any): Promise<IteratorResult<T, TReturn>>;
}

interface AsyncIterable<T, TReturn = any, TNext = any> {
  [Symbol.asyncIterator](): AsyncIterator<T, TReturn, TNext>;
}

interface AsyncIterableIterator<T, TReturn = any, TNext = any> extends AsyncIterator<T, TReturn, TNext> {
  [Symbol.asyncIterator](): AsyncIterableIterator<T, TReturn, TNext>;
}

// Generator
interface Generator<T = unknown, TReturn = any, TNext = unknown> extends Iterator<T, TReturn, TNext> {
  next(...[value]: [] | [TNext]): IteratorResult<T, TReturn>;
  return(value: TReturn): IteratorResult<T, TReturn>;
  throw(e: any): IteratorResult<T, TReturn>;
  [Symbol.iterator](): Generator<T, TReturn, TNext>;
}

interface AsyncGenerator<T = unknown, TReturn = any, TNext = unknown> extends AsyncIterator<T, TReturn, TNext> {
  next(...[value]: [] | [TNext]): Promise<IteratorResult<T, TReturn>>;
  return(value: TReturn | PromiseLike<TReturn>): Promise<IteratorResult<T, TReturn>>;
  throw(e: any): Promise<IteratorResult<T, TReturn>>;
  [Symbol.asyncIterator](): AsyncGenerator<T, TReturn, TNext>;
}

// Symbol
interface Symbol {
  readonly description: string | undefined;
  toString(): string;
  valueOf(): symbol;
}

interface SymbolConstructor {
  readonly prototype: Symbol;
  (description?: string | number): symbol;
  for(key: string): symbol;
  keyFor(sym: symbol): string | undefined;
  readonly iterator: unique symbol;
  readonly asyncIterator: unique symbol;
  readonly toStringTag: unique symbol;
  readonly hasInstance: unique symbol;
  readonly isConcatSpreadable: unique symbol;
  readonly match: unique symbol;
  readonly replace: unique symbol;
  readonly search: unique symbol;
  readonly species: unique symbol;
  readonly split: unique symbol;
  readonly toPrimitive: unique symbol;
  readonly unscopables: unique symbol;
}
declare var Symbol: SymbolConstructor;

// Template literal types
interface TemplateStringsArray extends ReadonlyArray<string> {
  readonly raw: readonly string[];
}

// Utility types
type Partial<T> = { [P in keyof T]?: T[P] };
type Required<T> = { [P in keyof T]-?: T[P] };
type Readonly<T> = { readonly [P in keyof T]: T[P] };
type Pick<T, K extends keyof T> = { [P in K]: T[P] };
type Record<K extends keyof any, T> = { [P in K]: T };
type Exclude<T, U> = T extends U ? never : T;
type Extract<T, U> = T extends U ? T : never;
type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>;
type NonNullable<T> = T & {};
type Parameters<T extends (...args: any) => any> = T extends (...args: infer P) => any ? P : never;
type ConstructorParameters<T extends abstract new (...args: any) => any> = T extends abstract new (
  ...args: infer P
) => any
  ? P
  : never;
type ReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R : any;
type InstanceType<T extends abstract new (...args: any) => any> = T extends abstract new (
  ...args: any
) => infer R
  ? R
  : any;
type ThisParameterType<T> = T extends (this: infer U, ...args: never) => any ? U : unknown;
type OmitThisParameter<T> =
  unknown extends ThisParameterType<T> ? T : T extends (...args: infer A) => infer R ? (...args: A) => R : T;
type Uppercase<S extends string> = intrinsic;
type Lowercase<S extends string> = intrinsic;
type Capitalize<S extends string> = intrinsic;
type Uncapitalize<S extends string> = intrinsic;
type NoInfer<T> = intrinsic;

type PropertyKey = string | number | symbol;

// ArrayBuffer and typed arrays (minimal, read-only focused)
interface ArrayBuffer {
  readonly byteLength: number;
  slice(begin: number, end?: number): ArrayBuffer;
}

interface ArrayBufferConstructor {
  readonly prototype: ArrayBuffer;
  new (byteLength: number): ArrayBuffer;
  isView(arg: any): arg is ArrayBufferView;
}
declare var ArrayBuffer: ArrayBufferConstructor;

interface ArrayBufferView {
  buffer: ArrayBufferLike;
  byteLength: number;
  byteOffset: number;
}

type ArrayBufferLike = ArrayBuffer;

interface DataView {
  readonly buffer: ArrayBuffer;
  readonly byteLength: number;
  readonly byteOffset: number;
  getFloat32(byteOffset: number, littleEndian?: boolean): number;
  getFloat64(byteOffset: number, littleEndian?: boolean): number;
  getInt8(byteOffset: number): number;
  getInt16(byteOffset: number, littleEndian?: boolean): number;
  getInt32(byteOffset: number, littleEndian?: boolean): number;
  getUint8(byteOffset: number): number;
  getUint16(byteOffset: number, littleEndian?: boolean): number;
  getUint32(byteOffset: number, littleEndian?: boolean): number;
  setFloat32(byteOffset: number, value: number, littleEndian?: boolean): void;
  setFloat64(byteOffset: number, value: number, littleEndian?: boolean): void;
  setInt8(byteOffset: number, value: number): void;
  setInt16(byteOffset: number, value: number, littleEndian?: boolean): void;
  setInt32(byteOffset: number, value: number, littleEndian?: boolean): void;
  setUint8(byteOffset: number, value: number): void;
  setUint16(byteOffset: number, value: number, littleEndian?: boolean): void;
  setUint32(byteOffset: number, value: number, littleEndian?: boolean): void;
}

interface DataViewConstructor {
  readonly prototype: DataView;
  new (buffer: ArrayBufferLike, byteOffset?: number, byteLength?: number): DataView;
}
declare var DataView: DataViewConstructor;

interface Uint8Array {
  readonly BYTES_PER_ELEMENT: number;
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
  readonly byteOffset: number;
  readonly length: number;
  [index: number]: number;
  copyWithin(target: number, start: number, end?: number): this;
  every(predicate: (value: number, index: number, array: Uint8Array) => unknown): boolean;
  fill(value: number, start?: number, end?: number): this;
  filter(predicate: (value: number, index: number, array: Uint8Array) => unknown): Uint8Array;
  find(predicate: (value: number, index: number, array: Uint8Array) => boolean): number | undefined;
  findIndex(predicate: (value: number, index: number, array: Uint8Array) => boolean): number;
  forEach(callbackfn: (value: number, index: number, array: Uint8Array) => void): void;
  includes(searchElement: number, fromIndex?: number): boolean;
  indexOf(searchElement: number, fromIndex?: number): number;
  join(separator?: string): string;
  lastIndexOf(searchElement: number, fromIndex?: number): number;
  map(callbackfn: (value: number, index: number, array: Uint8Array) => number): Uint8Array;
  reduce<U>(
    callbackfn: (previousValue: U, currentValue: number, currentIndex: number, array: Uint8Array) => U,
    initialValue: U,
  ): U;
  reduceRight<U>(
    callbackfn: (previousValue: U, currentValue: number, currentIndex: number, array: Uint8Array) => U,
    initialValue: U,
  ): U;
  reverse(): Uint8Array;
  set(array: ArrayLike<number>, offset?: number): void;
  slice(start?: number, end?: number): Uint8Array;
  some(predicate: (value: number, index: number, array: Uint8Array) => unknown): boolean;
  sort(compareFn?: (a: number, b: number) => number): this;
  subarray(begin?: number, end?: number): Uint8Array;
  valueOf(): Uint8Array;
  entries(): IterableIterator<[number, number]>;
  keys(): IterableIterator<number>;
  values(): IterableIterator<number>;
  [Symbol.iterator](): IterableIterator<number>;
}

interface Uint8ArrayConstructor {
  readonly prototype: Uint8Array;
  readonly BYTES_PER_ELEMENT: number;
  new (length: number): Uint8Array;
  new (array: ArrayLike<number>): Uint8Array;
  new (buffer: ArrayBufferLike, byteOffset?: number, length?: number): Uint8Array;
  from(arrayLike: ArrayLike<number>): Uint8Array;
  from<T>(arrayLike: ArrayLike<T>, mapfn: (v: T, k: number) => number): Uint8Array;
  of(...items: number[]): Uint8Array;
}
declare var Uint8Array: Uint8ArrayConstructor;

// TextEncoder/TextDecoder (useful for string <-> ArrayBuffer)
interface TextEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
}

interface TextEncoderConstructor {
  new (): TextEncoder;
}
declare var TextEncoder: TextEncoderConstructor;

interface TextDecoder {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  decode(input?: ArrayBufferView | ArrayBuffer, options?: { stream?: boolean }): string;
}

interface TextDecoderConstructor {
  new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder;
}
declare var TextDecoder: TextDecoderConstructor;

// Console - minimal, for debugging only
interface Console {
  log(...data: any[]): void;
  warn(...data: any[]): void;
  error(...data: any[]): void;
  info(...data: any[]): void;
  debug(...data: any[]): void;
}
declare var console: Console;

// URL and URLSearchParams - needed for HTTP-related code
interface URL {
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  readonly searchParams: URLSearchParams;
  username: string;
  toString(): string;
  toJSON(): string;
}

interface URLConstructor {
  new (url: string | URL, base?: string | URL): URL;
  readonly prototype: URL;
  canParse(url: string | URL, base?: string | URL): boolean;
}
declare var URL: URLConstructor;

interface URLSearchParams {
  append(name: string, value: string): void;
  delete(name: string, value?: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string, value?: string): boolean;
  set(name: string, value: string): void;
  sort(): void;
  toString(): string;
  forEach(callbackfn: (value: string, key: string, parent: URLSearchParams) => void, thisArg?: any): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
  readonly size: number;
}

interface URLSearchParamsConstructor {
  new (init?: string[][] | Record<string, string> | string | URLSearchParams): URLSearchParams;
  readonly prototype: URLSearchParams;
}
declare var URLSearchParams: URLSearchParamsConstructor;

// Headers - for HTTP request/response headers
interface Headers {
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  getSetCookie(): string[];
  has(name: string): boolean;
  set(name: string, value: string): void;
  forEach(callbackfn: (value: string, key: string, parent: Headers) => void, thisArg?: any): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

interface HeadersConstructor {
  new (init?: HeadersInit): Headers;
  readonly prototype: Headers;
}
declare var Headers: HeadersConstructor;

type HeadersInit = Headers | string[][] | Record<string, string>;

// Response - for HTTP responses
interface Body {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  formData(): Promise<FormData>;
  json(): Promise<any>;
  text(): Promise<string>;
}

interface Response extends Body {
  readonly headers: Headers;
  readonly ok: boolean;
  readonly redirected: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly type: ResponseType;
  readonly url: string;
  clone(): Response;
}

interface ResponseConstructor {
  new (body?: BodyInit | null, init?: ResponseInit): Response;
  readonly prototype: Response;
  error(): Response;
  json(data: any, init?: ResponseInit): Response;
  redirect(url: string | URL, status?: number): Response;
}
declare var Response: ResponseConstructor;

interface ResponseInit {
  headers?: HeadersInit;
  status?: number;
  statusText?: string;
}

type ResponseType = "basic" | "cors" | "default" | "error" | "opaque" | "opaqueredirect";

type BodyInit = ReadableStream<Uint8Array> | Blob | BufferSource | FormData | URLSearchParams | string;

// Minimal Blob interface
interface Blob {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  slice(start?: number, end?: number, contentType?: string): Blob;
  stream(): ReadableStream<Uint8Array>;
  text(): Promise<string>;
}

// Minimal FormData interface
interface FormData {
  append(name: string, value: string | Blob, fileName?: string): void;
  delete(name: string): void;
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
  has(name: string): boolean;
  set(name: string, value: string | Blob, fileName?: string): void;
  forEach(callbackfn: (value: FormDataEntryValue, key: string, parent: FormData) => void, thisArg?: any): void;
  entries(): IterableIterator<[string, FormDataEntryValue]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<FormDataEntryValue>;
  [Symbol.iterator](): IterableIterator<[string, FormDataEntryValue]>;
}

type FormDataEntryValue = File | string;

// Minimal File interface
interface File extends Blob {
  readonly lastModified: number;
  readonly name: string;
  readonly webkitRelativePath: string;
}

// Minimal ReadableStream interface
interface ReadableStream<R = any> {
  readonly locked: boolean;
  cancel(reason?: any): Promise<void>;
  getReader(): ReadableStreamDefaultReader<R>;
  pipeThrough<T>(transform: ReadableWritablePair<T, R>, options?: StreamPipeOptions): ReadableStream<T>;
  pipeTo(destination: WritableStream<R>, options?: StreamPipeOptions): Promise<void>;
  tee(): [ReadableStream<R>, ReadableStream<R>];
}

interface ReadableStreamDefaultReader<R = any> {
  readonly closed: Promise<undefined>;
  cancel(reason?: any): Promise<void>;
  read(): Promise<ReadableStreamReadResult<R>>;
  releaseLock(): void;
}

type ReadableStreamReadResult<T> = ReadableStreamReadValueResult<T> | ReadableStreamReadDoneResult;

interface ReadableStreamReadValueResult<T> {
  done: false;
  value: T;
}

interface ReadableStreamReadDoneResult {
  done: true;
  value?: undefined;
}

interface ReadableWritablePair<R = any, W = any> {
  readable: ReadableStream<R>;
  writable: WritableStream<W>;
}

interface StreamPipeOptions {
  preventAbort?: boolean;
  preventCancel?: boolean;
  preventClose?: boolean;
  signal?: AbortSignal;
}

interface WritableStream<W = any> {
  readonly locked: boolean;
  abort(reason?: any): Promise<void>;
  close(): Promise<void>;
  getWriter(): WritableStreamDefaultWriter<W>;
}

interface WritableStreamDefaultWriter<W = any> {
  readonly closed: Promise<undefined>;
  readonly desiredSize: number | null;
  readonly ready: Promise<undefined>;
  abort(reason?: any): Promise<void>;
  close(): Promise<void>;
  releaseLock(): void;
  write(chunk?: W): Promise<void>;
}

// AbortSignal and AbortController
interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: any;
  onabort: ((this: AbortSignal, ev: Event) => any) | null;
  throwIfAborted(): void;
}

interface AbortController {
  readonly signal: AbortSignal;
  abort(reason?: any): void;
}

interface AbortControllerConstructor {
  new (): AbortController;
  readonly prototype: AbortController;
}
declare var AbortController: AbortControllerConstructor;

// Minimal Event interface for AbortSignal
interface Event {
  readonly bubbles: boolean;
  cancelBubble: boolean;
  readonly cancelable: boolean;
  readonly composed: boolean;
  readonly currentTarget: EventTarget | null;
  readonly defaultPrevented: boolean;
  readonly eventPhase: number;
  readonly isTrusted: boolean;
  readonly target: EventTarget | null;
  readonly timeStamp: number;
  readonly type: string;
  composedPath(): EventTarget[];
  preventDefault(): void;
  stopImmediatePropagation(): void;
  stopPropagation(): void;
}

interface EventTarget {
  addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void;
  dispatchEvent(event: Event): boolean;
  removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void;
}

interface EventListener {
  (evt: Event): void;
}

interface EventListenerObject {
  handleEvent(object: Event): void;
}

type EventListenerOrEventListenerObject = EventListener | EventListenerObject;

interface AddEventListenerOptions extends EventListenerOptions {
  once?: boolean;
  passive?: boolean;
  signal?: AbortSignal;
}

interface EventListenerOptions {
  capture?: boolean;
}

type BufferSource = ArrayBufferView | ArrayBuffer;

// Global values
declare var undefined: undefined;
declare var NaN: number;
declare var Infinity: number;

declare function parseInt(string: string, radix?: number): number;
declare function parseFloat(string: string): number;
declare function isNaN(number: number): boolean;
declare function isFinite(number: number): boolean;
declare function encodeURIComponent(uriComponent: string | number | boolean): string;
declare function decodeURIComponent(encodedURIComponent: string): string;
declare function encodeURI(uri: string): string;
declare function decodeURI(encodedURI: string): string;

// Explicitly NOT included:
// - fetch, Request, Response, Headers (use sandbox APIs)
// - setTimeout, setInterval, clearTimeout, clearInterval
// - process, require, module, __dirname, __filename
// - window, document, localStorage, sessionStorage
// - fs, path, http, https, net, child_process
// - Buffer (node), Blob, File, FileReader
// - WebSocket, EventSource, XMLHttpRequest
// - crypto (use sandbox APIs if needed)
// - Worker, SharedWorker, ServiceWorker
`;
