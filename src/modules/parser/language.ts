/**
 * Extension-to-language mapping for `repository_files.language` and
 * `repo.files.indexed`'s `languages` histogram. Deliberately coarse — this
 * only needs to answer "is this TypeScript/JavaScript?" for Stage 6's
 * parser and give the UI an honest label; it isn't a full language
 * detector.
 */
const EXTENSION_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sql": "sql",
  ".sh": "shell",
  ".bash": "shell",
};

export const TYPESCRIPT_JAVASCRIPT_LANGUAGES = new Set(["typescript", "javascript"]);

export function detectLanguage(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  const extension = path.slice(dot).toLowerCase();
  return EXTENSION_LANGUAGE[extension] ?? null;
}
