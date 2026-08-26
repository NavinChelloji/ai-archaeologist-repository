import ts from "typescript";

/**
 * Syntactic-only extraction (REPOSITORY_PROCESSOR_SERVICE_PLAN.md "Parsing
 * Approach"): `ts.createSourceFile` with no `ts.Program`/type checker, since
 * building one would require resolving every import — which requires
 * `node_modules`, which we never install (RULES.md "never execute repository
 * code, never install dependencies"). Signatures below are the *written*
 * text of parameters/types, not the checker's inferred types.
 */

export type SymbolType = "class" | "interface" | "function" | "method" | "type" | "enum" | "variable";
export const SYMBOL_TYPES: readonly SymbolType[] = ["class", "interface", "function", "method", "type", "enum", "variable"];

export interface RawHeritage {
  extendsNames: string[];
  implementsNames: string[];
}

export interface RawSymbol {
  symbolType: SymbolType;
  name: string;
  qualifiedName: string | null;
  signature: string | null;
  isExported: boolean;
  startLine: number;
  endLine: number;
  /** Index into the same result array of this symbol's enclosing class/interface, if any. */
  parentIndex: number | null;
  /** Non-null only for class/interface — the graph module resolves these names against sibling symbols to build extends/implements edges (GRAPH_SERVICE_PLAN.md). */
  heritage: RawHeritage | null;
}

export type ImportKind = "esm" | "require" | "dynamic" | "export_from" | "type_only";

export interface RawImport {
  /** The literal specifier text, or (dynamic import only) the source text of a non-literal argument expression. */
  specifier: string;
  kind: ImportKind;
  /** False only for a dynamic `import()` whose argument isn't a string literal — resolves to `dynamic_unresolvable`. */
  isLiteralSpecifier: boolean;
  line: number;
}

export interface AstExtractionResult {
  symbols: RawSymbol[];
  imports: RawImport[];
}

export interface LanguageParser {
  readonly language: string;
  parse(relativePath: string, content: string): AstExtractionResult;
}

/** Long written-out types (giant mapped/union types, minified declaration files) shouldn't blow up a single DB row. */
const MAX_SIGNATURE_LENGTH = 2000;

function scriptKindFor(relativePath: string): ts.ScriptKind {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function truncate(text: string): string {
  return text.length > MAX_SIGNATURE_LENGTH ? `${text.slice(0, MAX_SIGNATURE_LENGTH)}…` : text;
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function lineRangeOf(sourceFile: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { startLine: start, endLine: end };
}

function functionSignature(name: string, params: ts.NodeArray<ts.ParameterDeclaration>, returnType: ts.TypeNode | undefined, sourceFile: ts.SourceFile): string {
  const paramsText = params.map((p) => p.getText(sourceFile)).join(", ");
  const returnText = returnType ? `: ${returnType.getText(sourceFile)}` : "";
  return truncate(`${name}(${paramsText})${returnText}`);
}

interface MethodLikeInfo {
  name: string;
  params: ts.NodeArray<ts.ParameterDeclaration>;
  returnType: ts.TypeNode | undefined;
}

function methodLikeInfo(member: ts.ClassElement | ts.TypeElement, sourceFile: ts.SourceFile): MethodLikeInfo | null {
  if (ts.isConstructorDeclaration(member)) {
    return { name: "constructor", params: member.parameters, returnType: member.type };
  }
  if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
    const name = member.name && ts.isPropertyName(member.name) ? member.name.getText(sourceFile) : null;
    return name ? { name, params: member.parameters, returnType: member.type } : null;
  }
  return null;
}

/** Methods and constructors nested one level inside a class/interface — see the module doc comment for the scope trim. */
function extractMembers(
  sourceFile: ts.SourceFile,
  members: ts.NodeArray<ts.ClassElement | ts.TypeElement>,
  parentName: string,
  parentIndex: number,
  out: RawSymbol[]
): void {
  for (const member of members) {
    const info = methodLikeInfo(member, sourceFile);
    if (!info) continue;

    const { name, params, returnType } = info;
    const { startLine, endLine } = lineRangeOf(sourceFile, member);
    out.push({
      symbolType: "method",
      name,
      qualifiedName: `${parentName}.${name}`,
      signature: functionSignature(name, params, returnType, sourceFile),
      isExported: hasExportModifier(member) || hasExportModifier(member.parent),
      startLine,
      endLine,
      parentIndex,
      heritage: null,
    });
  }
}

/** Bare heritage names only — `Foo<T>` contributes `"Foo"`, generic type arguments are dropped since resolution matches on `code_symbols.name`. */
function extractHeritageNames(clauses: ts.NodeArray<ts.HeritageClause> | undefined, sourceFile: ts.SourceFile): RawHeritage {
  const extendsNames: string[] = [];
  const implementsNames: string[] = [];
  for (const clause of clauses ?? []) {
    const bucket = clause.token === ts.SyntaxKind.ExtendsKeyword ? extendsNames : implementsNames;
    for (const type of clause.types) {
      bucket.push(type.expression.getText(sourceFile));
    }
  }
  return { extendsNames, implementsNames };
}

function extractSymbols(sourceFile: ts.SourceFile): RawSymbol[] {
  const out: RawSymbol[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      const name = statement.name?.getText(sourceFile) ?? "default";
      const { startLine, endLine } = lineRangeOf(sourceFile, statement);
      const heritageText = statement.heritageClauses?.map((h) => h.getText(sourceFile)).join(" ") ?? null;
      const index = out.length;
      out.push({
        symbolType: ts.isClassDeclaration(statement) ? "class" : "interface",
        name,
        qualifiedName: name,
        signature: heritageText ? truncate(heritageText) : null,
        isExported: hasExportModifier(statement),
        startLine,
        endLine,
        parentIndex: null,
        heritage: extractHeritageNames(statement.heritageClauses, sourceFile),
      });
      extractMembers(sourceFile, statement.members, name, index, out);
      continue;
    }

    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.getText(sourceFile) ?? "default";
      const { startLine, endLine } = lineRangeOf(sourceFile, statement);
      out.push({
        symbolType: "function",
        name,
        qualifiedName: name,
        signature: functionSignature(name, statement.parameters, statement.type, sourceFile),
        isExported: hasExportModifier(statement),
        startLine,
        endLine,
        parentIndex: null,
        heritage: null,
      });
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      const name = statement.name.getText(sourceFile);
      const { startLine, endLine } = lineRangeOf(sourceFile, statement);
      out.push({
        symbolType: "type",
        name,
        qualifiedName: name,
        signature: truncate(statement.type.getText(sourceFile)),
        isExported: hasExportModifier(statement),
        startLine,
        endLine,
        parentIndex: null,
        heritage: null,
      });
      continue;
    }

    if (ts.isEnumDeclaration(statement)) {
      const name = statement.name.getText(sourceFile);
      const { startLine, endLine } = lineRangeOf(sourceFile, statement);
      out.push({
        symbolType: "enum",
        name,
        qualifiedName: name,
        signature: null,
        isExported: hasExportModifier(statement),
        startLine,
        endLine,
        parentIndex: null,
        heritage: null,
      });
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const exported = hasExportModifier(statement);
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue; // skip destructuring patterns
        const name = decl.name.text;
        const isFunctionLike = decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
        const { startLine, endLine } = lineRangeOf(sourceFile, decl);
        out.push({
          symbolType: isFunctionLike ? "function" : "variable",
          name,
          qualifiedName: name,
          signature: isFunctionLike
            ? functionSignature(name, (decl.initializer as ts.ArrowFunction | ts.FunctionExpression).parameters, (decl.initializer as ts.ArrowFunction | ts.FunctionExpression).type, sourceFile)
            : decl.type
              ? truncate(`: ${decl.type.getText(sourceFile)}`)
              : null,
          isExported: exported,
          startLine,
          endLine,
          parentIndex: null,
          heritage: null,
        });
      }
    }
  }

  return out;
}

function stringLiteralText(expr: ts.Expression): string | null {
  return ts.isStringLiteralLike(expr) ? expr.text : null;
}

function extractImports(sourceFile: ts.SourceFile): RawImport[] {
  const out: RawImport[] = [];

  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== null) {
        out.push({
          specifier,
          kind: node.importClause?.isTypeOnly ? "type_only" : "esm",
          isLiteralSpecifier: true,
          line: lineOf(node),
        });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== null) {
        out.push({
          specifier,
          kind: node.isTypeOnly ? "type_only" : "export_from",
          isLiteralSpecifier: true,
          line: lineOf(node),
        });
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        const literal = arg ? stringLiteralText(arg) : null;
        out.push({
          specifier: literal ?? (arg ? truncate(arg.getText(sourceFile)) : ""),
          kind: "dynamic",
          isLiteralSpecifier: literal !== null,
          line: lineOf(node),
        });
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1) {
        const literal = stringLiteralText(node.arguments[0]!);
        if (literal !== null) {
          out.push({ specifier: literal, kind: "require", isLiteralSpecifier: true, line: lineOf(node) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return out;
}

export class TypeScriptLanguageParser implements LanguageParser {
  constructor(readonly language: "typescript" | "javascript") {}

  parse(relativePath: string, content: string): AstExtractionResult {
    const sourceFile = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true, scriptKindFor(relativePath));
    return { symbols: extractSymbols(sourceFile), imports: extractImports(sourceFile) };
  }
}

const typeScriptParser = new TypeScriptLanguageParser("typescript");
const javaScriptParser = new TypeScriptLanguageParser("javascript");

/** Registry a future Python/Go/Java parser plugs into without touching the pipeline (REPOSITORY_PROCESSOR_SERVICE_PLAN.md "Parsing Approach"). */
export const LANGUAGE_PARSERS: ReadonlyMap<string, LanguageParser> = new Map([
  ["typescript", typeScriptParser],
  ["javascript", javaScriptParser],
]);
