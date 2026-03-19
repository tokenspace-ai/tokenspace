import ts from "typescript";
import type { CapabilitySummary } from "./workspaceMetadata";

export type CapabilityMethodParam = {
  path: string;
  description: string;
};

export type CapabilityMethod = {
  name: string;
  signature: string;
  params: CapabilityMethodParam[];
};

export type CapabilityExplorerEntry = {
  namespace: string;
  name: string;
  description: string;
  capabilityPath: string;
  typesPath: string;
  iconPath?: string;
  markdown: string;
  declaration: string;
  methods: CapabilityMethod[];
};

export function getCapabilityNamespace(summary: Pick<CapabilitySummary, "path" | "typesPath" | "name">): string {
  const match = summary.typesPath.match(/^capabilities\/([^/]+)\//) ?? summary.path.match(/^capabilities\/([^/]+)\//);
  return match?.[1] ?? summary.name.toLowerCase();
}

export function selectCapabilityIconPath(
  namespace: string,
  options: { hasSvg: boolean; hasPng: boolean },
): string | undefined {
  if (options.hasSvg) {
    return `capabilities/${namespace}/icon.svg`;
  }
  if (options.hasPng) {
    return `capabilities/${namespace}/icon.png`;
  }
  return undefined;
}

export function extractCapabilityMethodsFromDeclaration(content: string): CapabilityMethod[] {
  const sourceFile = ts.createSourceFile("capability.d.ts", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const methods: CapabilityMethod[] = [];

  collectMethodsFromStatements(sourceFile.statements, sourceFile, methods);

  return methods;
}

function collectMethodsFromStatements(
  statements: ts.NodeArray<ts.Statement>,
  sourceFile: ts.SourceFile,
  methods: CapabilityMethod[],
): void {
  for (const statement of statements) {
    if (ts.isModuleDeclaration(statement)) {
      const block = getModuleBlock(statement);
      if (block) {
        collectMethodsFromStatements(block.statements, sourceFile, methods);
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const params = extractParamDocs(statement, sourceFile);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.type || !isCallableTypeNode(declaration.type)) {
          continue;
        }

        methods.push({
          name: declaration.name.text,
          signature: `${declaration.name.text}: ${compactSignature(declaration.type.getText(sourceFile))}`,
          params,
        });
      }
      continue;
    }

    if (!ts.isFunctionDeclaration(statement) || !statement.name) {
      continue;
    }

    methods.push({
      name: statement.name.text,
      signature: compactSignature(
        statement
          .getText(sourceFile)
          .replace(/^declare\s+/, "")
          .replace(/;$/, ""),
      ),
      params: extractParamDocs(statement, sourceFile),
    });
  }
}

export function stripLeadingMarkdownFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n")) {
    return normalized;
  }

  const lines = normalized.split("\n");
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line === "---" || line === "...") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return normalized;
  }

  return lines
    .slice(endIndex + 1)
    .join("\n")
    .trimStart();
}

function isCallableTypeNode(typeNode: ts.TypeNode): boolean {
  if (ts.isFunctionTypeNode(typeNode)) {
    return true;
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return isCallableTypeNode(typeNode.type);
  }
  if (ts.isTypeLiteralNode(typeNode)) {
    return typeNode.members.some((member) => ts.isCallSignatureDeclaration(member));
  }
  return false;
}

function getModuleBlock(statement: ts.ModuleDeclaration): ts.ModuleBlock | null {
  let body = statement.body;
  while (body) {
    if (ts.isModuleBlock(body)) {
      return body;
    }
    if (!ts.isModuleDeclaration(body)) {
      return null;
    }
    body = body.body;
  }
  return null;
}

function compactSignature(signature: string): string {
  return signature.replace(/\s+/g, " ").trim();
}

function extractParamDocs(node: ts.Node, sourceFile: ts.SourceFile): CapabilityMethodParam[] {
  const params: CapabilityMethodParam[] = [];

  for (const tag of ts.getJSDocTags(node)) {
    if (!ts.isJSDocParameterTag(tag)) {
      continue;
    }

    const rawName = tag.name.getText(sourceFile).trim();
    if (!rawName.startsWith("args.")) {
      continue;
    }

    const description = flattenJSDocComment(tag.comment);
    if (!description) {
      continue;
    }

    params.push({
      path: rawName.slice("args.".length),
      description,
    });
  }

  return params;
}

function flattenJSDocComment(comment: string | ts.NodeArray<ts.JSDocComment> | undefined): string {
  if (!comment) {
    return "";
  }
  if (typeof comment === "string") {
    return comment.replace(/\s+/g, " ").trim();
  }

  return comment
    .map((part) => part.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
