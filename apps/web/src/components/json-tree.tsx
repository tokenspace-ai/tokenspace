import { createContext, type MouseEvent, useCallback, useContext, useEffect, useMemo, useState } from "react";

type JSONTreeBaseProps = {
  data: any;
  showExpandAll?: boolean;
  stringTruncateLength?: number;
};

type JSONTreeProps =
  | (JSONTreeBaseProps & {
      initialMaxLines: number;
      initialExpandDepth?: never;
    })
  | (JSONTreeBaseProps & {
      initialExpandDepth?: number;
      initialMaxLines?: never;
    });

type Prefs = {
  stringTruncateLength: number;
};

const PrefsContext = createContext<Prefs>({
  stringTruncateLength: 120,
});

const ARRAY_INITIAL_TRUNCATE = 5;
const ARRAY_SHOW_MORE_STEP = 10;
const OBJECT_INITIAL_TRUNCATE = 15;
const OBJECT_SHOW_MORE_STEP = 20;

function JSONString({ data, trailingComma }: { data: string; trailingComma?: boolean }) {
  const { stringTruncateLength } = useContext(PrefsContext);
  if (data.length > stringTruncateLength) return <LongJSONString data={data} trailingComma={trailingComma} />;
  return (
    <>
      <span className="text-(--syntax-string)">{JSON.stringify(data)}</span>
      {trailingComma ? <Comma /> : null}
    </>
  );
}

function LongJSONString({ data, trailingComma }: { data: string; trailingComma?: boolean }) {
  const [truncated, setTruncated] = useState(true);
  const expand = useCallback(() => setTruncated(false), []);
  const collapse = useCallback(() => setTruncated(true), []);
  const { stringTruncateLength } = useContext(PrefsContext);
  if (truncated) {
    const str = data.slice(0, stringTruncateLength);
    return (
      <span className="cursor-pointer" onClick={expand}>
        <span className="text-(--syntax-string)">{JSON.stringify(str).slice(0, -1)}</span>
        <span className="text-muted-foreground">…</span>
        <span className="text-(--syntax-string)">&quot;</span>
        {trailingComma ? <Comma /> : null}
      </span>
    );
  }
  return (
    <span className="cursor-pointer" onClick={collapse}>
      <span className="text-(--syntax-string)">{JSON.stringify(data)}</span>
      {trailingComma ? <Comma /> : null}
    </span>
  );
}

function JSONNumber({ data, trailingComma }: { data: number; trailingComma?: boolean }) {
  return (
    <>
      <span className="text-(--syntax-number)">{JSON.stringify(data)}</span>
      {trailingComma ? <Comma /> : null}
    </>
  );
}

function JSONBoolean({ data, trailingComma }: { data: boolean; trailingComma?: boolean }) {
  return (
    <>
      <span className="text-(--syntax-boolean)">{data ? "true" : "false"}</span>
      {trailingComma ? <Comma /> : null}
    </>
  );
}

function JSONNull({ trailingComma }: { trailingComma?: boolean }) {
  return (
    <>
      <span className="text-(--syntax-keyword)">null</span>
      {trailingComma ? <Comma /> : null}
    </>
  );
}

function Comma() {
  return <span className="text-muted-foreground/50">,</span>;
}

function JSONArray({
  data,
  depth,
  openDepth,
  trailingComma = false,
}: {
  data: any;
  depth: number;
  openDepth: number;
  trailingComma?: boolean;
}) {
  return data.length === 0 ? (
    <span className="">
      <Bracket>[]</Bracket>
      {trailingComma ? <Comma /> : null}
    </span>
  ) : (
    <NonEmptyJSONArray data={data} depth={depth} openDepth={openDepth} trailingComma={trailingComma} />
  );
}

function Bracket({ children }: { children: React.ReactNode }) {
  return <span className="text-(--syntax-punctuation)">{children}</span>;
}

function Indent({ depth }: { depth: number }) {
  return <span>{Array(depth).fill("  ").join("")}</span>;
}

function NonEmptyJSONArray({
  data,
  depth,
  openDepth,
  trailingComma,
}: {
  data: any;
  depth: number;
  openDepth: number;
  trailingComma?: boolean;
}) {
  const [expanded, setExpanded] = useState(depth <= openDepth);
  const [subOpenDepth, setSubOpenDepth] = useState<number>(openDepth);
  const onCollapse = useCallback(() => {
    setExpanded(false);
    setSubOpenDepth(0);
    setTruncAt(Math.max(ARRAY_INITIAL_TRUNCATE, ARRAY_SHOW_MORE_STEP));
  }, []);
  const onExpand = useCallback((e: MouseEvent) => {
    setExpanded(true);
    if (e.shiftKey) {
      setSubOpenDepth(100);
    }
  }, []);
  const [truncAt, setTruncAt] = useState<number>(ARRAY_INITIAL_TRUNCATE);
  const showMore = useCallback(
    (e: MouseEvent) => {
      if (e.shiftKey) setTruncAt(data.length);
      else setTruncAt((prev) => Math.min(data.length, prev + ARRAY_SHOW_MORE_STEP));
    },
    [data.length],
  );
  const isTruncated = truncAt < data.length;

  if (expanded) {
    return (
      <>
        <span className="">
          <Bracket>[</Bracket>
          <span
            onClick={onCollapse}
            className="select-none px-1 text-muted-foreground/50 cursor-pointer hover:text-foreground"
          >
            [-]
          </span>
        </span>
        <div className="">
          {data.slice(0, truncAt).map((item: any, index: number) => (
            <JSONTreeNode
              key={index}
              data={item}
              depth={depth + 1}
              openDepth={subOpenDepth}
              trailingComma={index !== data.length - 1}
            />
          ))}
          {isTruncated ? (
            <div className="select-none">
              <Indent depth={depth + 1} />
              <span
                className="text-muted-foreground/50 cursor-pointer hover:text-foreground select-none"
                onClick={showMore}
              >
                [... {data.length - truncAt} more items]
              </span>
            </div>
          ) : null}
        </div>
        <div className="">
          <Indent depth={depth} />
          <Bracket>]</Bracket>
          {trailingComma ? <Comma /> : null}
        </div>
      </>
    );
  }

  return (
    <>
      <span className="cursor-pointer" onClick={onExpand}>
        <Bracket>[</Bracket>
        <span className="select-none px-2 text-muted-foreground/50 italic">
          {data.length} item{data.length === 1 ? "" : "s"}
        </span>
        <Bracket>]</Bracket>
      </span>
      {trailingComma ? <Comma /> : null}
    </>
  );
}
function JSONObject({
  data,
  depth,
  openDepth,
  trailingComma,
}: {
  data: any;
  depth: number;
  openDepth: number;
  trailingComma?: boolean;
}) {
  const empty = useMemo(() => Object.keys(data).length === 0, [data]);
  return empty ? (
    <span className="">
      <Bracket>{"{}"}</Bracket>
      {trailingComma ? <Comma /> : null}
    </span>
  ) : (
    <NonEmptyJSONObject data={data} depth={depth} openDepth={openDepth} trailingComma={trailingComma} />
  );
}

function NonEmptyJSONObject({
  data,
  depth,
  openDepth,
  trailingComma,
}: {
  data: any;
  depth: number;
  openDepth: number;
  trailingComma?: boolean;
}) {
  const length = useMemo(() => Object.keys(data).length, [data]);
  const [expanded, setExpanded] = useState(depth <= openDepth);
  const onCollapse = useCallback(() => setExpanded(false), []);
  const onExpand = useCallback(() => setExpanded(true), []);
  if (!expanded) {
    return (
      <span className="">
        <span className="cursor-pointer" onClick={onExpand}>
          <Bracket>{"{"}</Bracket>
          <span className="select-none px-2 text-muted-foreground/50 italic">
            {length} {length === 1 ? "property" : "properties"}
          </span>
          <Bracket>{"}"}</Bracket>
        </span>
        {trailingComma ? <Comma /> : null}
      </span>
    );
  }
  return (
    <ExpandedJSONObject
      data={data}
      depth={depth}
      openDepth={openDepth}
      trailingComma={trailingComma}
      onCollapse={onCollapse}
    />
  );
}

function ExpandedJSONObject({
  data,
  depth,
  openDepth,
  trailingComma,
  onCollapse,
}: {
  data: any;
  depth: number;
  openDepth: number;
  trailingComma?: boolean;
  onCollapse?: () => void;
}) {
  const entries = useMemo(() => Object.entries(data), [data]);
  const length = entries.length;
  const [truncAt, setTruncAt] = useState<number>(OBJECT_INITIAL_TRUNCATE);
  const visibleCount = Math.min(truncAt, length);
  const showMore = useCallback(
    (e: MouseEvent) => {
      if (e.shiftKey) setTruncAt(length);
      else setTruncAt((prev) => Math.min(length, prev + OBJECT_SHOW_MORE_STEP));
    },
    [length],
  );
  const renderedEntries = useMemo(
    () =>
      entries.slice(0, visibleCount).map(([key, value], index) => (
        <div key={key} className="">
          <Indent depth={depth + 1} />
          <span className="text-(--syntax-property)">{JSON.stringify(key)}</span>
          <span className="text-(--syntax-punctuation)">: </span>
          <JSONTreeNode
            data={value}
            depth={depth + 1}
            openDepth={openDepth}
            trailingComma={index !== length - 1}
            inline
          />
        </div>
      )),
    [depth, entries, length, openDepth, visibleCount],
  );
  const isTruncated = visibleCount < length;

  return (
    <span>
      <Bracket>{"{"}</Bracket>
      <span
        onClick={onCollapse}
        className="select-none px-1 text-muted-foreground/50 cursor-pointer hover:text-foreground"
      >
        [-]
      </span>
      <div className="">
        {renderedEntries}
        {isTruncated ? (
          <div className="select-none">
            <Indent depth={depth + 1} />
            <span
              className="text-muted-foreground/50 cursor-pointer hover:text-foreground select-none"
              onClick={showMore}
            >
              [... {length - visibleCount} more properties]
            </span>
          </div>
        ) : null}
      </div>
      <div className="">
        <Indent depth={depth} />
        <Bracket>{"}"}</Bracket>
        {trailingComma ? <Comma /> : null}
      </div>
    </span>
  );
}

function JSONTreeNode({
  data,
  depth,
  openDepth,
  trailingComma,
  inline = false,
}: {
  data: any;
  depth: number;
  openDepth: number;
  trailingComma?: boolean;
  inline?: boolean;
}) {
  const node = <InlineJSONTreeNode data={data} depth={depth} openDepth={openDepth} trailingComma={trailingComma} />;
  if (inline) return node;
  return (
    <div className="">
      <Indent depth={depth} />
      {node}
    </div>
  );
}

function InlineJSONTreeNode({
  data,
  depth,
  openDepth,
  trailingComma,
}: {
  data: any;
  depth: number;
  openDepth: number;
  trailingComma?: boolean;
}) {
  switch (typeof data) {
    case "string":
      return <JSONString data={data} trailingComma={trailingComma} />;
    case "number":
      return <JSONNumber data={data} trailingComma={trailingComma} />;
    case "boolean":
      return <JSONBoolean data={data} trailingComma={trailingComma} />;
    case "object":
      if (data === null) return <JSONNull trailingComma={trailingComma} />;
      if (Array.isArray(data))
        return <JSONArray data={data} depth={depth} openDepth={openDepth} trailingComma={trailingComma} />;
      return <JSONObject data={data} depth={depth} openDepth={openDepth} trailingComma={trailingComma} />;
    default:
      return <div className="">Unknown</div>;
  }
}

function calculateExpandDepthFromMaxLines(data: any, maxLines: number): number {
  if (!Number.isFinite(maxLines)) return 1;
  const safeMaxLines = Math.max(1, Math.floor(maxLines));
  const maxDepth = getMaxDepthForInitialView(data);
  let bestDepth = -1;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const lines = countLinesForDepth(data, depth);
    if (lines <= safeMaxLines) {
      bestDepth = depth;
    } else {
      break;
    }
  }
  return Math.max(0, bestDepth);
}

function getMaxDepthForInitialView(data: any): number {
  if (data === null || typeof data !== "object") return 0;
  if (Array.isArray(data)) {
    if (data.length === 0) return 0;
    let maxChildDepth = 0;
    for (let index = 0; index < Math.min(ARRAY_INITIAL_TRUNCATE, data.length); index += 1) {
      maxChildDepth = Math.max(maxChildDepth, getMaxDepthForInitialView(data[index]));
    }
    return maxChildDepth + 1;
  }
  const values = Object.values(data);
  if (values.length === 0) return 0;
  let maxChildDepth = 0;
  const limit = Math.min(OBJECT_INITIAL_TRUNCATE, values.length);
  for (let index = 0; index < limit; index += 1) {
    const value = values[index];
    maxChildDepth = Math.max(maxChildDepth, getMaxDepthForInitialView(value));
  }
  return maxChildDepth + 1;
}

function countLinesForDepth(data: any, openDepth: number, depth = 0): number {
  if (data === null || typeof data !== "object") return 1;
  if (Array.isArray(data)) {
    if (data.length === 0) return 1;
    if (openDepth < depth) return 1;
    const itemsToShow = Math.min(ARRAY_INITIAL_TRUNCATE, data.length);
    let lines = 1;
    for (let index = 0; index < itemsToShow; index += 1) {
      lines += countLinesForDepth(data[index], openDepth, depth + 1);
    }
    if (data.length > itemsToShow) {
      lines += 1;
    }
    lines += 1;
    return lines;
  }
  const entries = Object.entries(data);
  if (entries.length === 0) return 1;
  if (openDepth < depth) return 1;
  let lines = 1;
  const itemsToShow = Math.min(OBJECT_INITIAL_TRUNCATE, entries.length);
  for (let index = 0; index < itemsToShow; index += 1) {
    const [, value] = entries[index]!;
    lines += countLinesForDepth(value, openDepth, depth + 1);
  }
  if (entries.length > itemsToShow) {
    lines += 1;
  }
  lines += 1;
  return lines;
}

export function JsonTree(props: JSONTreeProps) {
  const { data, showExpandAll, stringTruncateLength = 120 } = props;
  const initialMaxLines = "initialMaxLines" in props ? props.initialMaxLines : undefined;
  const initialExpandDepthProp = "initialMaxLines" in props ? undefined : props.initialExpandDepth;
  const resolvedInitialExpandDepth = useMemo(() => {
    if (initialMaxLines != null) {
      return calculateExpandDepthFromMaxLines(data, initialMaxLines);
    }
    return initialExpandDepthProp ?? 1;
  }, [data, initialExpandDepthProp, initialMaxLines]);
  const [expandDepth, setExpandDepth] = useState(resolvedInitialExpandDepth);
  useEffect(() => {
    setExpandDepth((prev) => (prev === resolvedInitialExpandDepth ? prev : resolvedInitialExpandDepth));
  }, [resolvedInitialExpandDepth]);
  const handleExpandAll = useCallback(() => {
    setExpandDepth(1000);
  }, []);
  const prefs = useMemo(() => ({ stringTruncateLength }), [stringTruncateLength]);
  return (
    <PrefsContext.Provider value={prefs}>
      <div className="">
        <pre className="font-mono text-xs max-w-full text-wrap">
          <JSONTreeNode key={expandDepth} data={data} depth={0} openDepth={expandDepth} />
        </pre>
        {showExpandAll ? (
          <div className="text-[9px] text-muted-foreground">
            <button type="button" className="underline cursor-pointer" onClick={handleExpandAll}>
              Expand all
            </button>
          </div>
        ) : null}
      </div>
    </PrefsContext.Provider>
  );
}
