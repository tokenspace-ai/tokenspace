import { TokenspaceError } from "./error";

export type SerializableValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SerializableValue[]
  | { [key: string]: SerializableValue };

export type SerializableObject = { [key: string]: SerializableValue };

type ParseSchema<TInput, TOutput> = {
  parse(input: unknown): TOutput;
  _input: TInput;
  _output: TOutput;
};

type AnyCallable = (...args: never[]) => unknown;

const ACTION_MARKER = Symbol("tokenspace.integration.action");
const actionRegistry = new WeakSet<AnyCallable>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertSerializableInternal(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value == null) {
    return;
  }

  const valueType = typeof value;

  if (valueType === "string" || valueType === "number" || valueType === "boolean") {
    if (valueType === "number" && !Number.isFinite(value as number)) {
      throw new TokenspaceError(`Non-serializable value at ${path}: number must be finite`);
    }
    return;
  }

  if (valueType === "function") {
    throw new TokenspaceError(`Non-serializable value at ${path}: functions are not allowed`);
  }

  if (valueType === "symbol") {
    throw new TokenspaceError(`Non-serializable value at ${path}: symbols are not allowed`);
  }

  if (valueType === "bigint") {
    throw new TokenspaceError(`Non-serializable value at ${path}: bigint is not allowed`);
  }

  if (valueType !== "object") {
    throw new TokenspaceError(`Non-serializable value at ${path}: unsupported type ${valueType}`);
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    throw new TokenspaceError(`Non-serializable value at ${path}: circular references are not allowed`);
  }
  seen.add(objectValue);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertSerializableInternal(value[i], `${path}[${i}]`, seen);
    }
    seen.delete(objectValue);
    return;
  }

  if (!isPlainObject(value)) {
    const ctor = (value as { constructor?: { name?: string } }).constructor?.name ?? "unknown";
    throw new TokenspaceError(`Non-serializable value at ${path}: expected plain object, received ${ctor}`);
  }

  for (const [key, nested] of Object.entries(value)) {
    assertSerializableInternal(nested, `${path}.${key}`, seen);
  }

  seen.delete(objectValue);
}

export function assertSerializable(value: unknown, label = "value"): asserts value is SerializableValue {
  assertSerializableInternal(value, label, new WeakSet());
}

function markAction(fn: AnyCallable): void {
  actionRegistry.add(fn);
  Object.defineProperty(fn, ACTION_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export function isAction(value: unknown): value is (args: SerializableObject) => Promise<SerializableValue> {
  if (typeof value !== "function") {
    return false;
  }
  return actionRegistry.has(value as AnyCallable);
}

/**
 * Define a capability action with runtime validation.
 *
 * - `schema` must parse the input object shape.
 * - Parsed input and handler output must be JSON-serializable.
 */
export function action<
  TInput extends SerializableObject,
  TParsed extends SerializableObject,
  TResult extends SerializableValue,
>(
  schema: ParseSchema<TInput, TParsed>,
  handler: (args: TParsed) => Promise<TResult> | TResult,
): (args: TInput) => Promise<TResult> {
  const wrapped = async (args: TInput): Promise<TResult> => {
    const parsed = schema.parse(args);
    assertSerializable(parsed, "action input");

    const result = await handler(parsed);
    assertSerializable(result, "action output");

    return result;
  };

  markAction(wrapped);
  return wrapped;
}
