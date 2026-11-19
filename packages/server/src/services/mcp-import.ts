import type { ColumnId, Priority, MCPTool } from '../types.js';

/**
 * Generic external-task import helpers.
 *
 * Nothing here knows about a specific MCP server or task schema. Tools are
 * ranked from discovery metadata, records are located heuristically inside a
 * tool result, and fields are read through common aliases.
 */

export interface NormalizedExternalTask {
  externalKey: string;
  title: string;
  description: string;
  status?: string;
  priority?: string;
  columnId: ColumnId;
  boardPriority: Priority;
}

export interface TaskRecordSource {
  /** Where the record array was found (e.g. `content[0].text.tasks`). */
  location: string;
  records: Record<string, unknown>[];
}

const ID_KEYS = [
  'id', 'key', 'externalKey', 'externalId', 'external_id', 'identifier',
  'slug', 'uuid', 'number', 'numberKey', 'taskId', 'task_id', 'nodeId',
  'node_id', 'code', 'shortId', 'shortID', 'short_id',
];

const TITLE_KEYS = [
  'title', 'name', 'summary', 'subject', 'label', 'heading', 'displayName',
  'display_name',
];

const DESCRIPTION_KEYS = [
  'description', 'body', 'content', 'details', 'text', 'notes', 'summary',
];

const STATUS_KEYS = ['status', 'state', 'column', 'columnId', 'column_id', 'phase', 'stage'];
const PRIORITY_KEYS = ['priority', 'severity', 'importance', 'urgency', 'rank'];

const CONTAINER_KEYS = [
  'tasks', 'items', 'issues', 'records', 'results', 'data', 'nodes', 'children',
  'work_items', 'workItems', 'stories', 'tickets', 'entries', 'list', 'rows',
];

const LISTING_NAME_PATTERN = /(list|search|query|find|browse|fetch|index|recall)/i;
const LISTING_DESCRIPTION_PATTERN = /(list|search|query|find|browse|retrieve|return|show|get)\b/i;
const TASK_TERM_PATTERN = /(task|issue|ticket|story|backlog|work.?item|todo|project|plan|requirement|node)/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rank discovered tools by how plausible they are as task-listing tools.
 * Ordering only drives the UI default; every discovered tool stays selectable.
 */
export function rankListingTools(tools: MCPTool[]): MCPTool[] {
  const score = (tool: MCPTool): number => {
    let value = 0;
    if (LISTING_NAME_PATTERN.test(tool.name)) value += 3;
    if (LISTING_DESCRIPTION_PATTERN.test(tool.description ?? '')) value += 1;
    if (TASK_TERM_PATTERN.test(tool.name)) value += 2;
    if (TASK_TERM_PATTERN.test(tool.description ?? '')) value += 1;
    return value;
  };
  return [...tools]
    .map((tool, index) => ({ tool, index, value: score(tool) }))
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .map((entry) => entry.tool);
}

/** True when a tool looks like it can enumerate tasks/records. */
export function isListingTool(tool: MCPTool): boolean {
  const haystack = `${tool.name} ${tool.description ?? ''}`;
  return LISTING_NAME_PATTERN.test(tool.name) && TASK_TERM_PATTERN.test(haystack);
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function looksLikeRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  return readString(value, ID_KEYS) !== undefined || readString(value, TITLE_KEYS) !== undefined;
}

function recordsFromArray(value: unknown[]): Record<string, unknown>[] {
  const objects = value.filter(isPlainObject);
  if (objects.length === 0) return [];
  const withIdentity = objects.filter(looksLikeRecord);
  return withIdentity.length > 0 ? withIdentity : objects;
}

/**
 * Walk a parsed tool result looking for the first array of record-like objects.
 * Handles common envelopes (`{tasks: [...]}`, `{data: {items: [...]}}`, direct arrays).
 */
function collectRecords(
  node: unknown,
  location: string,
  depth = 0,
): TaskRecordSource | undefined {
  if (depth > 4) return undefined;

  if (Array.isArray(node)) {
    const records = recordsFromArray(node);
    if (records.length > 0) return { location, records };
    return undefined;
  }

  if (!isPlainObject(node)) return undefined;

  // Prefer well-known container keys, then any array-valued property.
  for (const key of CONTAINER_KEYS) {
    if (!(key in node)) continue;
    const found = collectRecords(node[key], `${location}.${key}`, depth + 1);
    if (found) return found;
  }
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      const records = recordsFromArray(value);
      if (records.length > 0) return { location: `${location}.${key}`, records };
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (isPlainObject(value)) {
      const found = collectRecords(value, `${location}.${key}`, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Locate task records inside a raw MCP tool result. Supports
 * `structuredContent` and JSON text content; non-JSON text yields nothing.
 */
export function extractTaskRecords(result: unknown): TaskRecordSource | undefined {
  if (!isPlainObject(result)) return undefined;

  if (result.structuredContent !== undefined) {
    const found = collectRecords(result.structuredContent, 'structuredContent');
    if (found) return found;
  }

  const content = Array.isArray(result.content) ? result.content : [];
  for (let i = 0; i < content.length; i += 1) {
    const item = content[i];
    if (!isPlainObject(item) || item.type !== 'text' || typeof item.text !== 'string') continue;
    const parsed = tryParseJson(item.text);
    if (parsed === undefined) continue;
    const found = collectRecords(parsed, `content[${i}].text`);
    if (found) return found;
  }

  // Deliberately no fallback scan of the raw result object: `content` is an
  // array of transport envelopes, not task records. Plain-text results (status
  // pages, prose) must surface as a limitation instead of fabricated tasks.
  return undefined;
}

/** Concatenate text content from a tool result for error/limitation messages. */
export function resultText(result: unknown): string {
  if (!isPlainObject(result)) return '';
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((item) => (isPlainObject(item) && typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/**
 * Map an external status label to a Kanban column. Unknown or missing statuses
 * fall back to `backlog` so an import never starts execution implicitly.
 */
export function mapExternalStatus(status?: string): ColumnId {
  const value = (status ?? '').toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (!value) return 'backlog';
  if (/(done|closed|complete|completed|resolved|merged|finished|released|shipped)/.test(value)) return 'done';
  if (/(review|verify|verification|qa|testing|approval|awaiting|in review)/.test(value)) return 'review';
  if (/(progress|doing|active|started|working|development|dev|running|blocked|hold|paused)/.test(value)) return 'in-progress';
  return 'backlog';
}

/** Map an external priority label to a board priority. */
export function mapExternalPriority(priority?: string): Priority {
  const value = (priority ?? '').toLowerCase().trim();
  if (!value) return 'medium';
  if (/(critical|urgent|blocker|highest|p0|p1|sev ?0|sev ?1)/.test(value)) return 'critical';
  if (/(high|major|p2|sev ?2)/.test(value)) return 'high';
  if (/(low|minor|trivial|p4|sev ?4)/.test(value)) return 'low';
  return 'medium';
}

/** Normalize a raw record into the preview shape, or `undefined` if unusable. */
export function normalizeExternalTask(record: Record<string, unknown>): NormalizedExternalTask | undefined {
  const externalKey = readString(record, ID_KEYS);
  const title = readString(record, TITLE_KEYS);
  if (!externalKey || !title) return undefined;

  const description = readString(record, DESCRIPTION_KEYS) ?? '';
  const status = readString(record, STATUS_KEYS);
  const priority = readString(record, PRIORITY_KEYS);

  return {
    externalKey,
    title,
    description,
    status,
    priority,
    columnId: mapExternalStatus(status),
    boardPriority: mapExternalPriority(priority),
  };
}

/** Derive a stable external source label from an MCP server name. */
export function externalSourceForServer(serverName: string): string {
  const slug = serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `mcp:${slug || 'server'}`;
}
