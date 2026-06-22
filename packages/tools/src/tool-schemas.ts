import { z } from 'zod';

/**
 * Runtime arg schemas for ToolServer.executeTool. Per consensus a8911b95:f1,
 * the dispatch surface previously trusted callers to pass well-shaped args
 * and used `as` casts inline, which silently accepted malformed payloads
 * (missing required fields, wrong types, oversized strings). Validation
 * happens once at the entry point so handlers can rely on the parsed shape.
 *
 * Path strings are length-capped (4096) to bound argument memory and rule
 * out absurd inputs without re-implementing path-traversal here — boundary
 * checks live in enforceWriteScope/file_read guards which run after parsing.
 */
const PathString = z.string().min(1).max(4096);
const ContentString = z.string().max(2_000_000); // 2MB cap on file_write payloads

export const TOOL_SCHEMAS = {
  file_read: z.object({
    path: PathString,
    startLine: z.number().int().nonnegative().optional(),
    endLine: z.number().int().nonnegative().optional(),
  }).strict(),

  file_write: z.object({
    path: PathString,
    content: ContentString,
  }).strict(),

  file_delete: z.object({
    path: PathString,
  }).strict(),

  file_search: z.object({
    pattern: z.string().min(1).max(1024),
  }).strict(),

  file_grep: z.object({
    pattern: z.string().min(1).max(1024),
    path: PathString.optional(),
  }).strict(),

  file_tree: z.object({
    path: PathString.optional(),
    depth: z.number().int().min(1).max(10).optional(),
  }).strict(),

  shell_exec: z.object({
    command: z.string().min(1).max(8192),
    args: z.array(z.string().max(4096)).max(256).optional(),
    timeout: z.number().int().positive().max(600_000).optional(),
  }).strict(),

  git_status: z.object({}).strict(),

  git_diff: z.object({
    staged: z.boolean().optional(),
    paths: z.array(PathString).max(256).optional(),
  }).strict(),

  git_log: z.object({
    count: z.number().int().positive().max(1000).optional(),
  }).strict(),

  git_commit: z.object({
    message: z.string().min(1).max(8192),
    files: z.array(PathString).max(256).optional(),
  }).strict(),

  git_branch: z.object({
    name: z.string().min(1).max(256).optional(),
  }).strict(),

  suggest_skill: z.object({
    skill_name: z.string().min(1).max(256),
    reason: z.string().min(1).max(4096),
    task_context: z.string().min(1).max(8192),
  }).strict(),

  verify_write: z.object({
    test_file: PathString.optional(),
  }).strict(),

  run_tests: z.object({
    fileGlob: z.string().min(1).max(1024),
  }).strict(),

  run_typecheck: z.object({}).strict(),

  memory_query: z.object({
    query: z.string().min(1).max(1024),
    // gemini occasionally passes max_results as a string; handler coerces but
    // we still cap it here so a 1MB string can't reach the parser.
    max_results: z.union([z.number().int().positive().max(100), z.string().max(8)]).optional(),
  }).strict(),

  self_identity: z.object({}).strict(),
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

export function isKnownTool(name: string): name is ToolName {
  return name in TOOL_SCHEMAS;
}

/**
 * Validate args for a known tool. Throws a descriptive error on failure that
 * lists which fields were wrong, so agents can self-correct without poking at
 * the source. Returns the parsed (typed, narrowed) args on success.
 */
export function validateToolArgs(name: ToolName, args: unknown): Record<string, unknown> {
  const schema = TOOL_SCHEMAS[name];
  const result = schema.safeParse(args ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid args for tool "${name}": ${issues}`);
  }
  return result.data as Record<string, unknown>;
}
