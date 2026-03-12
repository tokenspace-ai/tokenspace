import { MINIMAL_LIB, SANDBOX_TYPES } from "@tokenspace/types";
import ts from "typescript";

// Verify TypeScript is properly loaded
if (!ts || !ts.createProgram) {
  throw new Error("[compiler] TypeScript module not properly loaded");
}

// ============================================================================
// Type Declaration Compiler
// ============================================================================

export interface SourceFile {
  /** File path (e.g., "src/capabilities/splunk/capability.ts") */
  fileName: string;
  /** File content */
  content: string;
}

export interface GeneratedDeclaration {
  /** Original source file path */
  sourceFileName: string;
  /** Output declaration file path (e.g., "capabilities/splunk/capability.d.ts") - strips src/ prefix and changes extension */
  declarationFileName: string;
  /** Generated declaration content (with exports converted to globals) */
  content: string;
}

export interface DeclarationCompilationResult {
  success: boolean;
  declarations: GeneratedDeclaration[];
  diagnostics: CompilationDiagnostic[];
}

export interface DeclarationCompilerOptions {
  /**
   * Optional virtual type declarations injected by the caller.
   * This is primarily for test fixtures; workspace builds should resolve from node_modules.
   */
  externalTypes?: Map<string, string>;
  /**
   * Workspace/project root used for filesystem-based module resolution.
   */
  projectRoot?: string;
  /**
   * Resolve modules from real node_modules on disk when true.
   */
  resolveNodeModules?: boolean;
}

type ActionInputDescription = {
  actionName: string;
  fields: Array<{ path: string; description: string }>;
};

const ZOD_PASSTHROUGH_METHODS = new Set([
  "optional",
  "nullable",
  "nullish",
  "default",
  "catch",
  "brand",
  "readonly",
  "describe",
  "min",
  "max",
  "int",
  "positive",
  "nonnegative",
  "finite",
  "safe",
  "trim",
  "toLowerCase",
  "toUpperCase",
  "email",
  "url",
  "uuid",
  "regex",
  "startsWith",
  "endsWith",
  "includes",
  "length",
  "nonempty",
  "gte",
  "gt",
  "lte",
  "lt",
]);

const ZOD_STATIC_PASSTHROUGH_CALLS = new Set(["optional", "nullable", "nullish", "default", "catch"]);

function stripParentheses(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function resolveSchemaExpression(
  expr: ts.Expression,
  schemaBindings: Map<string, ts.Expression>,
  seen = new Set<string>(),
): ts.Expression {
  let current = stripParentheses(expr);
  while (ts.isIdentifier(current)) {
    const name = current.text;
    const binding = schemaBindings.get(name);
    if (!binding || seen.has(name)) {
      break;
    }
    seen.add(name);
    current = stripParentheses(binding);
  }
  return current;
}

function getPropertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function addDescribedField(out: Map<string, string>, path: string, rawDescription: string): void {
  const description = rawDescription.replace(/\s+/g, " ").trim();
  if (!path || !description || out.has(path)) {
    return;
  }
  out.set(path, description);
}

function collectZodDescriptions(
  expr: ts.Expression,
  path: string,
  out: Map<string, string>,
  schemaBindings: Map<string, ts.Expression>,
): void {
  const resolvedExpr = resolveSchemaExpression(expr, schemaBindings);
  const node = stripParentheses(resolvedExpr);

  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "describe"
  ) {
    const descriptionArg = node.arguments[0];
    if (descriptionArg && ts.isStringLiteralLike(descriptionArg)) {
      addDescribedField(out, path, descriptionArg.text);
    }
    collectZodDescriptions(node.expression.expression, path, out, schemaBindings);
    return;
  }

  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const methodName = node.expression.name.text;
    const calleeTarget = node.expression.expression;
    const isStaticZCall = ts.isIdentifier(calleeTarget) && calleeTarget.text === "z";

    if (isStaticZCall) {
      if (methodName === "object") {
        const shapeArg = node.arguments[0];
        if (shapeArg && ts.isObjectLiteralExpression(shapeArg)) {
          for (const prop of shapeArg.properties) {
            if (!ts.isPropertyAssignment(prop)) {
              continue;
            }
            const propertyName = getPropertyNameText(prop.name);
            if (!propertyName) {
              continue;
            }
            const childPath = path ? `${path}.${propertyName}` : propertyName;
            collectZodDescriptions(prop.initializer, childPath, out, schemaBindings);
          }
        }
        return;
      }

      if (methodName === "array" && node.arguments[0]) {
        const arrayPath = path ? `${path}[]` : path;
        collectZodDescriptions(node.arguments[0], arrayPath, out, schemaBindings);
        return;
      }

      if (ZOD_STATIC_PASSTHROUGH_CALLS.has(methodName) && node.arguments[0]) {
        collectZodDescriptions(node.arguments[0], path, out, schemaBindings);
        return;
      }

      return;
    }

    if (methodName === "object") {
      const shapeArg = node.arguments[0];
      if (shapeArg && ts.isObjectLiteralExpression(shapeArg)) {
        for (const prop of shapeArg.properties) {
          if (!ts.isPropertyAssignment(prop)) {
            continue;
          }
          const propertyName = getPropertyNameText(prop.name);
          if (!propertyName) {
            continue;
          }
          const childPath = path ? `${path}.${propertyName}` : propertyName;
          collectZodDescriptions(prop.initializer, childPath, out, schemaBindings);
        }
      }
      return;
    }

    if (methodName === "array") {
      const arrayPath = path ? `${path}[]` : path;
      collectZodDescriptions(node.expression.expression, arrayPath, out, schemaBindings);
      return;
    }

    if (ZOD_PASSTHROUGH_METHODS.has(methodName)) {
      collectZodDescriptions(node.expression.expression, path, out, schemaBindings);
      return;
    }

    return;
  }
}

function isActionFactoryCall(expr: ts.Expression): expr is ts.CallExpression {
  if (!ts.isCallExpression(expr)) {
    return false;
  }
  if (ts.isIdentifier(expr.expression)) {
    return expr.expression.text === "action";
  }
  return false;
}

function isExportedVariableDeclaration(declaration: ts.VariableDeclaration): boolean {
  const variableStatement = declaration.parent.parent;
  return (
    ts.isVariableStatement(variableStatement) &&
    variableStatement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true
  );
}

function extractActionInputDescriptions(source: SourceFile): ActionInputDescription[] {
  const sourceFile = ts.createSourceFile(
    source.fileName,
    source.content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const schemaBindings = new Map<string, ts.Expression>();

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
        continue;
      }
      schemaBindings.set(declaration.name.text, declaration.initializer);
    }
  }

  const describedActions: ActionInputDescription[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (!isExportedVariableDeclaration(declaration)) {
        continue;
      }
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
        continue;
      }
      if (!isActionFactoryCall(declaration.initializer)) {
        continue;
      }

      const schemaArg = declaration.initializer.arguments[0];
      if (!schemaArg) {
        continue;
      }

      const fields = new Map<string, string>();
      collectZodDescriptions(schemaArg, "", fields, schemaBindings);

      if (fields.size > 0) {
        describedActions.push({
          actionName: declaration.name.text,
          fields: [...fields.entries()].map(([path, description]) => ({ path, description })),
        });
      }
    }
  }

  return describedActions;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildActionInputComment(descriptions: Array<{ path: string; description: string }>): string {
  const lines = ["/**"];
  for (const field of descriptions) {
    const sanitizedDescription = field.description.replace(/\*\//g, "*\\/");
    lines.push(` * @param args.${field.path} ${sanitizedDescription}`);
  }
  lines.push(" */");
  return lines.join("\n");
}

function annotateDeclarationWithInputDescriptions(
  declarationContent: string,
  descriptions: ActionInputDescription[],
): string {
  let content = declarationContent;

  for (const description of descriptions) {
    const sortedFields = [...description.fields].sort((a, b) => a.path.localeCompare(b.path));
    if (sortedFields.length === 0) {
      continue;
    }

    const comment = buildActionInputComment(sortedFields);
    const declarationPattern = new RegExp(
      `(^\\s*declare\\s+const\\s+${escapeForRegExp(description.actionName)}\\s*:)`,
      "m",
    );

    if (!declarationPattern.test(content)) {
      continue;
    }

    content = content.replace(declarationPattern, `${comment}\n$1`);
  }

  return content;
}

type TextEdit = {
  start: number;
  end: number;
  text: string;
};

type ZodSchemaTypeInfo = {
  inputType: string;
  outputType: string;
};

function getImportTypeModuleSpecifier(node: ts.ImportTypeNode): string | null {
  if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal)) {
    return null;
  }
  return node.argument.literal.text;
}

function isZodImport(statement: ts.Statement): boolean {
  if (!ts.isImportDeclaration(statement)) {
    return false;
  }
  const moduleSpecifier = statement.moduleSpecifier;
  return ts.isStringLiteral(moduleSpecifier) && moduleSpecifier.text === "zod";
}

function getSchemaTypeInfo(typeNode: ts.TypeNode, sourceFile: ts.SourceFile): ZodSchemaTypeInfo | null {
  if (!ts.isImportTypeNode(typeNode)) {
    return null;
  }

  if (getImportTypeModuleSpecifier(typeNode) !== "zod") {
    return null;
  }

  if (!typeNode.qualifier || !ts.isIdentifier(typeNode.qualifier) || typeNode.qualifier.text !== "ZodType") {
    return null;
  }

  const outputType = typeNode.typeArguments?.[0]?.getText(sourceFile).trim();
  if (!outputType) {
    return null;
  }

  const inputType = typeNode.typeArguments?.[1]?.getText(sourceFile).trim() ?? outputType;
  return {
    inputType,
    outputType,
  };
}

function getSchemaNameFromZodAliasTypeNode(
  typeNode: ts.TypeNode,
): { schemaName: string; mode: "input" | "output" } | null {
  if (!ts.isTypeReferenceNode(typeNode)) {
    return null;
  }

  if (!ts.isQualifiedName(typeNode.typeName)) {
    return null;
  }

  const left = typeNode.typeName.left;
  const right = typeNode.typeName.right;
  if (!ts.isIdentifier(left) || left.text !== "z") {
    return null;
  }

  const mode = right.text === "input" ? "input" : right.text === "infer" || right.text === "output" ? "output" : null;
  if (!mode) {
    return null;
  }

  const schemaTypeArg = typeNode.typeArguments?.[0];
  if (!schemaTypeArg || !ts.isTypeQueryNode(schemaTypeArg) || !ts.isIdentifier(schemaTypeArg.exprName)) {
    return null;
  }

  return {
    schemaName: schemaTypeArg.exprName.text,
    mode,
  };
}

function applyTextEdits(content: string, edits: TextEdit[]): string {
  if (edits.length === 0) {
    return content;
  }
  const sortedEdits = [...edits].sort((a, b) => b.start - a.start);
  let next = content;
  for (const edit of sortedEdits) {
    next = `${next.slice(0, edit.start)}${edit.text}${next.slice(edit.end)}`;
  }
  return next;
}

function stripZodReferencesFromDeclaration(declarationContent: string): string {
  const sourceFile = ts.createSourceFile(
    "declaration.d.ts",
    declarationContent,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const schemaTypesByName = new Map<string, ZodSchemaTypeInfo>();
  const edits: TextEdit[] = [];

  for (const statement of sourceFile.statements) {
    if (isZodImport(statement)) {
      edits.push({ start: statement.getFullStart(), end: statement.getEnd(), text: "" });
      continue;
    }

    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.type) {
        continue;
      }
      const schemaInfo = getSchemaTypeInfo(declaration.type, sourceFile);
      if (!schemaInfo) {
        continue;
      }
      schemaTypesByName.set(declaration.name.text, schemaInfo);
      edits.push({ start: statement.getFullStart(), end: statement.getEnd(), text: "" });
      break;
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(statement)) {
      continue;
    }

    const schemaAliasInfo = getSchemaNameFromZodAliasTypeNode(statement.type);
    if (!schemaAliasInfo) {
      continue;
    }

    const schemaTypeInfo = schemaTypesByName.get(schemaAliasInfo.schemaName);
    if (!schemaTypeInfo) {
      continue;
    }

    const replacementType = schemaAliasInfo.mode === "input" ? schemaTypeInfo.inputType : schemaTypeInfo.outputType;
    edits.push({
      start: statement.type.getStart(sourceFile),
      end: statement.type.getEnd(),
      text: replacementType,
    });
  }

  const rewritten = applyTextEdits(declarationContent, edits)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return rewritten ? `${rewritten}\n` : "";
}

/**
 * Compiles TypeScript source files to declaration files (.d.ts).
 * The output declarations are converted to globals (export keywords removed).
 *
 * @param sources - Array of source files to compile
 * @param options - Optional compiler options including external type definitions
 * @returns Compilation result with generated declarations
 */
export function compileDeclarations(
  sources: SourceFile[],
  options: DeclarationCompilerOptions = {},
): DeclarationCompilationResult {
  if (sources.length === 0) {
    return { success: true, declarations: [], diagnostics: [] };
  }

  const { externalTypes = new Map(), projectRoot, resolveNodeModules = false } = options;
  const projectRootNormalized = projectRoot?.replace(/\\/g, "/").replace(/\/+$/, "");
  const useFsModuleResolution = resolveNodeModules && Boolean(projectRootNormalized) && Boolean(ts.sys);
  const actionDescriptionsBySource = new Map<string, ActionInputDescription[]>();

  const normalizeCompilerPath = (fileName: string): string => {
    const normalized = fileName
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/{2,}/g, "/");
    const parts = normalized.split("/");
    const resolvedParts: string[] = [];

    for (const part of parts) {
      if (!part || part === ".") {
        continue;
      }
      if (part === "..") {
        if (resolvedParts.length > 0) {
          resolvedParts.pop();
        }
        continue;
      }
      resolvedParts.push(part);
    }

    return resolvedParts.join("/");
  };

  // Store files in a map for the compiler host
  const files = new Map<string, string>();
  const sourceFileNames: string[] = [];
  const normalizedSourceFileNameSet = new Set<string>();

  const candidatePathKeys = (fileName: string): string[] => {
    const normalized = normalizeCompilerPath(fileName);
    if (!normalized) {
      return [fileName];
    }
    const keys = [fileName, normalized, `/${normalized}`];
    if (projectRootNormalized) {
      keys.push(`${projectRootNormalized}/${normalized}`);
    }
    return keys;
  };

  const setVirtualFile = (fileName: string, content: string): void => {
    for (const key of new Set(candidatePathKeys(fileName))) {
      files.set(key, content);
    }
  };

  const getVirtualFile = (fileName: string): string | undefined => {
    for (const key of candidatePathKeys(fileName)) {
      const content = files.get(key);
      if (content !== undefined) {
        return content;
      }
    }
    return undefined;
  };

  const hasVirtualFile = (fileName: string): boolean => getVirtualFile(fileName) !== undefined;
  const readRealFile = (fileName: string): string | undefined =>
    useFsModuleResolution ? ts.sys.readFile(fileName) : undefined;
  const hasRealFile = (fileName: string): boolean => (useFsModuleResolution ? ts.sys.fileExists(fileName) : false);
  const getScriptKind = (fileName: string): ts.ScriptKind => {
    if (fileName.endsWith(".d.ts")) return ts.ScriptKind.TS;
    if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
    if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
    if (fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs")) {
      return ts.ScriptKind.JS;
    }
    return ts.ScriptKind.TS;
  };
  const toAbsoluteCompilerPath = (fileName: string): string => {
    const normalized = normalizeCompilerPath(fileName);
    if (fileName.startsWith("/") || /^[A-Za-z]:\//.test(fileName)) {
      return fileName;
    }
    if (projectRootNormalized) {
      return `${projectRootNormalized}/${normalized}`;
    }
    return `/${normalized}`;
  };

  for (const source of sources) {
    setVirtualFile(source.fileName, source.content);
    sourceFileNames.push(source.fileName);
    normalizedSourceFileNameSet.add(normalizeCompilerPath(source.fileName));
    actionDescriptionsBySource.set(source.fileName, extractActionInputDescriptions(source));
  }

  // Add external type declarations as virtual files
  for (const [moduleName, content] of externalTypes) {
    const virtualPath = `/node_modules/${moduleName}/index.d.ts`;
    setVirtualFile(virtualPath, content);
  }

  // Capture emitted declaration files
  const emittedFiles = new Map<string, string>();

  const minimalLibFileName = "lib.minimal.d.ts";

  if (!useFsModuleResolution) {
    // Environments without filesystem access (e.g. Convex V8) need an in-memory lib.
    setVirtualFile(minimalLibFileName, MINIMAL_LIB);
  }

  const inferredTypes: string[] = [];
  if (useFsModuleResolution && projectRootNormalized && ts.sys.directoryExists) {
    const typesRoot = `${projectRootNormalized}/node_modules/@types`;
    if (ts.sys.directoryExists(typesRoot)) {
      if (ts.sys.directoryExists(`${typesRoot}/bun`)) {
        inferredTypes.push("bun");
      }
      if (ts.sys.directoryExists(`${typesRoot}/node`)) {
        inferredTypes.push("node");
      }
    }
  }

  // TypeScript compiler options for declaration generation
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
    skipLibCheck: true,
    // We need to allow JS for flexible input
    allowJs: true,
    // Don't require strict mode for source files
    strict: false,
    // Use default libs when we can access filesystem node_modules.
    noLib: !useFsModuleResolution,
    ...(inferredTypes.length > 0 ? { types: inferredTypes } : {}),
  };

  // Create a custom compiler host with module resolution
  const compilerHost: ts.CompilerHost = {
    getSourceFile(fileName: string, languageVersion: ts.ScriptTarget): ts.SourceFile | undefined {
      const content = getVirtualFile(fileName) ?? readRealFile(fileName);
      if (content !== undefined) {
        return ts.createSourceFile(fileName, content, languageVersion, true, getScriptKind(fileName));
      }
      return undefined;
    },
    getDefaultLibFileName: () =>
      useFsModuleResolution ? ts.getDefaultLibFilePath(compilerOptions) : minimalLibFileName,
    writeFile: (fileName: string, content: string) => {
      emittedFiles.set(fileName, content);
    },
    getCurrentDirectory: () => projectRootNormalized ?? "/",
    directoryExists:
      useFsModuleResolution && ts.sys.directoryExists ? (dir) => ts.sys.directoryExists!(dir) : undefined,
    getDirectories: (dir: string) => (useFsModuleResolution ? ts.sys.getDirectories(dir) : []),
    readDirectory:
      useFsModuleResolution && ts.sys.readDirectory
        ? (rootDir, extensions, excludes, includes, depth) =>
            ts.sys.readDirectory!(rootDir, extensions, excludes, includes, depth)
        : undefined,
    realpath: useFsModuleResolution && ts.sys.realpath ? (p) => ts.sys.realpath!(p) : undefined,
    fileExists: (fileName: string) => hasVirtualFile(fileName) || hasRealFile(fileName),
    readFile: (fileName: string) => getVirtualFile(fileName) ?? readRealFile(fileName),
    getCanonicalFileName: (fileName: string) => (ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => "\n",
    resolveModuleNames(moduleNames: string[], containingFile: string): (ts.ResolvedModule | undefined)[] {
      return moduleNames.map((moduleName) => {
        // Check if we have external types for this module
        const virtualPath = `/node_modules/${moduleName}/index.d.ts`;
        if (hasVirtualFile(virtualPath)) {
          return { resolvedFileName: virtualPath, isExternalLibraryImport: true };
        }

        // For local relative imports, resolve them
        if (moduleName.startsWith(".")) {
          const containing = normalizeCompilerPath(containingFile);
          const dir = containing.substring(0, containing.lastIndexOf("/"));
          const resolved = normalizeCompilerPath(`${dir}/${moduleName}`).replace(/\/\.\//g, "/");
          const candidates = [
            resolved,
            `${resolved}.ts`,
            `${resolved}.tsx`,
            `${resolved}/index.ts`,
            `${resolved}/index.tsx`,
          ];
          for (const candidate of candidates) {
            if (hasVirtualFile(candidate)) {
              return { resolvedFileName: candidate };
            }
          }
        }

        if (useFsModuleResolution) {
          const resolutionHost: ts.ModuleResolutionHost = {
            fileExists: (fileName: string) => hasVirtualFile(fileName) || ts.sys.fileExists(fileName),
            readFile: (fileName: string) => getVirtualFile(fileName) ?? ts.sys.readFile(fileName),
            directoryExists: ts.sys.directoryExists ? (dirName: string) => ts.sys.directoryExists!(dirName) : undefined,
            getDirectories: ts.sys.getDirectories ? (dirName: string) => ts.sys.getDirectories(dirName) : undefined,
            realpath: ts.sys.realpath ? (p: string) => ts.sys.realpath!(p) : undefined,
            getCurrentDirectory: () => projectRootNormalized ?? "/",
          };
          const resolved = ts.resolveModuleName(
            moduleName,
            toAbsoluteCompilerPath(containingFile),
            compilerOptions,
            resolutionHost,
          );
          if (resolved.resolvedModule) {
            return resolved.resolvedModule;
          }
        }

        // Return undefined for unresolved modules - TypeScript will report an error
        return undefined;
      });
    },
  };

  // Create program
  const rootNames = useFsModuleResolution ? sourceFileNames : [minimalLibFileName, ...sourceFileNames];
  const program = ts.createProgram(rootNames, compilerOptions, compilerHost);

  // Emit declarations
  const emitResult = program.emit();

  // Collect diagnostics (only errors, not warnings for declaration compilation)
  const allDiagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...emitResult.diagnostics,
  ];

  // Filter to only show diagnostics from the source files (not external types)
  const relevantDiagnostics = allDiagnostics.filter((d) => {
    if (!d.file) return true;
    return normalizedSourceFileNameSet.has(normalizeCompilerPath(d.file.fileName));
  });

  const diagnostics: CompilationDiagnostic[] = relevantDiagnostics.map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    let line: number | undefined;
    let column: number | undefined;
    let file: string | undefined;

    if (d.file?.fileName) {
      const normalizedFileName = d.file.fileName.replace(/\\/g, "/");
      if (projectRootNormalized && normalizedFileName.startsWith(`${projectRootNormalized}/`)) {
        file = normalizedFileName.slice(projectRootNormalized.length + 1);
      } else {
        file = normalizedFileName;
      }
    }

    if (d.file && d.start !== undefined) {
      const pos = d.file.getLineAndCharacterOfPosition(d.start);
      line = pos.line + 1;
      column = pos.character + 1;
    }

    return { file, message, line, column, code: d.code };
  });

  // Convert emitted files to declarations with globals
  const declarations: GeneratedDeclaration[] = [];

  for (const [emittedFileName, content] of emittedFiles) {
    // Skip external type declarations
    if (emittedFileName.includes("/node_modules/")) {
      continue;
    }

    // Find the corresponding source file
    const sourceFileName = sourceFileNames.find((sf) => {
      const expectedDts = sf.replace(/\.tsx?$/, ".d.ts");
      const normalizedExpected = normalizeCompilerPath(expectedDts);
      const normalizedEmitted = normalizeCompilerPath(emittedFileName);
      return normalizedEmitted === normalizedExpected || normalizedEmitted.endsWith(`/${normalizedExpected}`);
    });

    if (sourceFileName) {
      // Transform the output path: strip src/ prefix and change extension
      // e.g., src/capabilities/github/capability.ts → capabilities/github/capability.d.ts
      const declarationFileName = sourceFileName.replace(/^src\//, "").replace(/\.tsx?$/, ".d.ts");

      declarations.push({
        sourceFileName,
        declarationFileName,
        content: stripZodReferencesFromDeclaration(
          annotateDeclarationWithInputDescriptions(
            makeGlobalDeclarations(content),
            actionDescriptionsBySource.get(sourceFileName) ?? [],
          ),
        ),
      });
    }
  }

  return {
    success: sources.length === 0 || diagnostics.length === 0,
    declarations,
    diagnostics,
  };
}

// ============================================================================
// Agent Code Compiler
// ============================================================================

export interface CompilationResult {
  success: boolean;
  diagnostics: CompilationDiagnostic[];
}

export interface CompilationDiagnostic {
  file?: string;
  message: string;
  line?: number;
  column?: number;
  code: number;
}

export interface CompilerOptions {
  /** Sandbox API declaration files (e.g., capabilities/github/capability.d.ts) */
  sandboxApis: { fileName: string; content: string }[];
}

/**
 * Compiles agent-generated TypeScript code against sandbox API type definitions.
 * Sandbox APIs are available as globals - no imports needed or allowed.
 * Does NOT allow access to browser/node APIs (e.g. global fetch, node:fs APIs, process, etc.)
 * Note: a revision filesystem is provided via the built-in `fs` global (see builtins).
 */
export function compileAgentCode(code: string, options: CompilerOptions): CompilationResult {
  const { sandboxApis } = options;

  // Virtual filename for the agent's code
  const virtualFileName = "agent-code.ts";

  // Collect sandbox API declarations and convert to global declarations
  // const globalApiDeclarations = collectGlobalApiDeclarations(sandboxApis);

  // Debug: log lib content length to help diagnose bundling issues
  if (MINIMAL_LIB.length < 1000) {
    console.error("[compiler] WARNING: LIB is unexpectedly short:", MINIMAL_LIB.length, "chars");
  }

  // Store files in a map for the compiler host
  const files = new Map<string, string>();
  // files.set("lib.minimal.d.ts", MINIMAL_LIB);
  // files.set("builtins.d.ts", BUILTINS);
  files.set("sandbox-types.d.ts", SANDBOX_TYPES);
  files.set(virtualFileName, code);

  const includeLibs = ["sandbox-types.d.ts"];

  for (const { fileName, content } of sandboxApis) {
    if (fileName.endsWith(".d.ts")) {
      files.set(fileName, makeGlobalDeclarations(content));
      includeLibs.push(fileName);
    }
  }
  // Create a custom compiler host
  const compilerHost: ts.CompilerHost = {
    getSourceFile(fileName: string, languageVersion: ts.ScriptTarget): ts.SourceFile | undefined {
      const content = files.get(fileName);
      if (content !== undefined) {
        return ts.createSourceFile(fileName, content, languageVersion, true, ts.ScriptKind.TS);
      }
      return undefined;
    },
    getDefaultLibFileName: () => "sandbox-types.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (fileName: string) => files.has(fileName),
    readFile: (fileName: string) => files.get(fileName),
    getCanonicalFileName: (fileName: string) => fileName.toLowerCase(),
    useCaseSensitiveFileNames: () => false,
    getNewLine: () => "\n",
  };

  // TypeScript compiler options - relaxed for agent-generated code
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    // Force module detection so top-level await is allowed (without requiring imports/exports)
    moduleDetection: ts.ModuleDetectionKind.Force,
    // Don't require strict mode - agent code often indexes objects with strings, etc.
    strict: false,
    noEmit: true,
    skipLibCheck: false,
    // Use our minimal lib instead of default libs
    noLib: true,
  };

  // Create program and get diagnostics
  // Include the minimal lib file as a root file so TypeScript loads it
  const program = ts.createProgram([...includeLibs, virtualFileName], compilerOptions, compilerHost);

  const allDiagnostics = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];

  // Filter to only show diagnostics from the agent's code
  const relevantDiagnostics = allDiagnostics.filter((d) => {
    if (!d.file) return true;
    return d.file.fileName === virtualFileName;
  });

  const diagnostics: CompilationDiagnostic[] = relevantDiagnostics.map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    let line: number | undefined;
    let column: number | undefined;
    let file: string | undefined;

    if (d.file?.fileName) {
      file = d.file.fileName.replace(/\\/g, "/");
    }

    if (d.file && d.start !== undefined) {
      const pos = d.file.getLineAndCharacterOfPosition(d.start);
      line = pos.line + 1;
      column = pos.character + 1;
    }

    return { file, message, line, column, code: d.code };
  });

  return {
    success: diagnostics.length === 0,
    diagnostics,
  };
}

/**
 * Converts module declarations to global declarations by removing export keywords.
 * This makes the declarations available as globals without requiring imports.
 */
export function makeGlobalDeclarations(content: string): string {
  // Convert module exports to global declarations:
  // - Remove 'export' keyword from declarations
  // - Keep type definitions as-is (they become global types)
  const globalContent = content
    // Convert "export declare function" to "declare function"
    .replace(/^export\s+declare\s+/gm, "declare ")
    // Convert "export declare class" to "declare class"
    .replace(/^export\s+declare\s+class\s+/gm, "declare class ")
    // Convert "export declare const/let/var" to "declare const/let/var"
    .replace(/^export\s+declare\s+(const|let|var)\s+/gm, "declare $1 ")
    // Convert "export type" to "type" (already global in ambient context)
    .replace(/^export\s+type\s+/gm, "type ")
    // Convert "export interface" to "interface"
    .replace(/^export\s+interface\s+/gm, "interface ")
    // Convert "export enum" to "enum"
    .replace(/^export\s+enum\s+/gm, "enum ")
    // Convert "export const enum" to "const enum"
    .replace(/^export\s+const\s+enum\s+/gm, "const enum ")
    // Convert "export namespace" to "namespace"
    .replace(/^export\s+namespace\s+/gm, "namespace ")
    // Remove any remaining standalone "export" statements like "export {};" or "export { foo, bar };"
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, "")
    // Remove empty lines that might be left after removing export statements
    .replace(/\n{3,}/g, "\n\n");

  return `${globalContent.trim()}\n`;
}
