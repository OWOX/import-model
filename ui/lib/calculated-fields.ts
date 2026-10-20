// Calculated fields: from a bundle's `## Calculated fields` to ODM, in two steps.
//
// ODM accepts a formula only when every column it reads is CONNECTED, and a column becomes
// CONNECTED only when ODM has read it from the warehouse — which needs an input source. This
// import creates drafts without one (bundles carry no definitions), so a formula saved at import
// time is refused with "`order_id` no longer exists in the Data Mart". Instead each Data Mart's
// formulas wait in the plugin's own collection, bound to that Data Mart, and are added once the
// member has given it an input source and ODM has connected its columns.
//
// The formulas are converted to ODM's stored form at IMPORT time, while the join graph with the
// aliases this import gave each relationship is in hand. Later, only the Data Mart is read back.

import type { PluginContext } from '@owox/plugin-sdk';
import type { CalculatedField, ModelGraph, ModelNode } from './okf-types';
import { isBigQuery, mapFieldType, stepsFrom } from './import-model';

/** Declared in plugin.json, bound to `data-mart`: one document per Data Mart, id = its ODM id. */
export const PENDING_COLLECTION = 'pendingCalculatedFields';

export interface PendingField {
  name: string;
  /** Portable OKF type; mapped onto the storage's own enum when the field is added. */
  type: string;
  alias?: string;
  description?: string;
  /** ODM's stored form: warehouse SQL with `{{ref}}` tags. */
  formula: string;
  /** The Data Mart's own columns the formula reads; all must be CONNECTED before it is sent. */
  requires: string[];
  /** Why ODM refused it on the last attempt, when it did. */
  lastError?: string;
}

export interface PendingDocument {
  version: 1;
  martTitle: string;
  bundleName: string;
  fields: PendingField[];
}

// ─── Formula conversion ────────────────────────────────────────────────────────

// Words that look like identifiers but are SQL syntax or type names, never fields.
const NOT_FIELDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'NULL', 'TRUE', 'FALSE',
  'AS', 'IS', 'IN', 'LIKE', 'BETWEEN', 'DISTINCT', 'INTERVAL', 'IF', 'OVER', 'PARTITION', 'BY', 'ORDER',
  'ASC', 'DESC', 'LIMIT', 'SAFE', 'DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR', 'HOUR', 'MINUTE', 'SECOND',
  'STRING', 'INT64', 'INTEGER', 'INT', 'FLOAT64', 'FLOAT', 'NUMERIC', 'BIGNUMERIC', 'DECIMAL', 'BOOL', 'BOOLEAN',
  'DATE', 'DATETIME', 'TIME', 'TIMESTAMP', 'BYTES', 'JSON', 'VARCHAR', 'ROWS', 'RANGE', 'UNBOUNDED',
  'PRECEDING', 'FOLLOWING', 'CURRENT', 'ROW', 'WITHIN', 'GROUP', 'FILTER', 'NULLS', 'FIRST', 'LAST',
  'IGNORE', 'RESPECT', 'DAYOFWEEK', 'DAYOFYEAR', 'ISOWEEK', 'ISOYEAR', 'MILLISECOND', 'MICROSECOND',
  'STRUCT', 'ARRAY',
]);

/** String literals, quoted identifiers and comments blanked to spaces, offsets kept: their
 *  contents must never read as references. */
function codeOnly(sql: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/--[^\n]*/g, blank)
    .replace(/'(?:[^'\\]|\\.)*'/g, blank)
    .replace(/"(?:[^"\\]|\\.)*"/g, blank)
    .replace(/`[^`]*`/g, blank);
}

/** Where a formula's joined reference can go: the hops out of one Data Mart, under the aliases
 *  their relationships are created with, never re-entering a Data Mart already on the path. */
interface JoinTree {
  /** Resolve `["purchases_e_commerce", "products_e_commerce"]` to the aliases ODM holds and the
   *  Data Mart at the end, or null when the bundle's path leads nowhere in this import. */
  resolve(segments: string[]): { path: string; target: ModelNode } | null;
}

function joinTreeFor(node: ModelNode, graph: ModelGraph): JoinTree {
  const titleByKey = new Map(graph.nodes.map(entry => [entry.key, entry.title]));
  const nodeByKey = new Map(graph.nodes.map(entry => [entry.key, entry]));
  return {
    resolve(segments) {
      let current = node.key;
      const visited = new Set([node.key]);
      const aliases: string[] = [];
      for (const segment of segments) {
        const steps = stepsFrom(current, graph, titleByKey).filter(step => !visited.has(step.to));
        // The alias as written. Failing that, the alias a bundle generator wrote without declaring
        // it on the intermediate hop — `products_e_commerce` for a relationship this import calls
        // `products` — accepted only when exactly one hop could be meant.
        let step = steps.find(candidate => candidate.alias === segment);
        if (!step) {
          const loose = steps.filter(candidate => segment.startsWith(`${candidate.alias}_`));
          if (loose.length === 1) step = loose[0];
        }
        if (!step) return null;
        aliases.push(step.alias);
        visited.add(step.to);
        current = step.to;
      }
      const target = nodeByKey.get(current);
      return target ? { path: aliases.join('.'), target } : null;
    },
  };
}

/**
 * A bundle formula in ODM's stored form, plus the Data Mart's own columns it reads.
 *
 * ODM validates references only as `{{ref field="x"}}` and `{{ref path="a.b" field="x"}}` tags; a
 * bare identifier it does not recognise as a field at all. Anything that does not resolve stays as
 * written, so ODM names it when the field is added rather than this import guessing.
 */
export function toStoredFormula(
  field: CalculatedField,
  node: ModelNode,
  graph: ModelGraph,
): { formula: string; requires: string[] } {
  const columns = new Set(node.schema.map(column => column.name));
  const calculated = new Set((node.calculatedFields ?? []).map(entry => entry.name));
  const tree = joinTreeFor(node, graph);
  const code = codeOnly(field.formula);
  const requires = new Set<string>();
  const edits: Array<{ start: number; end: number; text: string }> = [];

  for (const match of code.matchAll(/(?<![\w.])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?![\w.])/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (/^\s*\(/.test(code.slice(end))) continue;                  // a function call
    const segments = match[1].split('.');

    if (segments.length === 1) {
      const name = segments[0];
      if (name === field.name) continue;
      if (NOT_FIELDS.has(name.toUpperCase())) {
        // A keyword is a column only where a column can stand: not a type (AS DATE), a date part
        // (YEAR FROM d) or an INTERVAL unit.
        const before = code.slice(0, start);
        const typeOrUnit = /\bAS\s+$/i.test(before) || /^\s*FROM\b/i.test(code.slice(end))
          || /(?:\d|\bINTERVAL)\s+$/i.test(before) || /\bINTERVAL\s+\S+\s+$/i.test(before);
        if (typeOrUnit) continue;
      }
      if (columns.has(name)) requires.add(name);
      else if (!calculated.has(name)) continue;
      edits.push({ start, end, text: `{{ref field="${name}"}}` });
      continue;
    }

    // A dotted name is the Data Mart's own nested column when it has one by that name; otherwise
    // every segment but the last is a join path and the last is the joined field.
    if (columns.has(match[1])) {
      requires.add(match[1]);
      edits.push({ start, end, text: `{{ref field="${match[1]}"}}` });
      continue;
    }
    const resolved = tree.resolve(segments.slice(0, -1));
    const joinedField = segments[segments.length - 1];
    if (!resolved || !resolved.target.schema.some(column => column.name === joinedField)) continue;
    edits.push({ start, end, text: `{{ref path="${resolved.path}" field="${joinedField}"}}` });
  }

  let formula = field.formula;
  for (const edit of edits.reverse()) formula = formula.slice(0, edit.start) + edit.text + formula.slice(edit.end);
  return { formula, requires: [...requires] };
}

/** What waits for one Data Mart, or null when its bundle file declares no calculated fields. */
export function pendingDocumentFor(node: ModelNode, graph: ModelGraph, bundleName: string): PendingDocument | null {
  const fields = node.calculatedFields ?? [];
  if (fields.length === 0) return null;
  return {
    version: 1,
    martTitle: node.title,
    bundleName,
    fields: fields.map(field => {
      const { formula, requires } = toStoredFormula(field, node, graph);
      return {
        name: field.name,
        type: field.type,
        ...(field.alias ? { alias: field.alias } : {}),
        ...(field.description ? { description: field.description } : {}),
        formula,
        requires,
      };
    }),
  };
}

export function countCalculatedFields(graph: ModelGraph | null): number {
  return graph?.nodes.reduce((total, node) => total + (node.calculatedFields?.length ?? 0), 0) ?? 0;
}

// ─── Queue at import ───────────────────────────────────────────────────────────

export interface QueueResult {
  /** Calculated fields now waiting for their Data Mart's input source. */
  queued: number;
  failed: number;
  errors: string[];
}

/** Park every created Data Mart's calculated fields in the collection, bound to that Data Mart. */
export async function queueCalculatedFields(
  context: PluginContext,
  graph: ModelGraph,
  martIds: Record<string, string>,
  bundleName: string,
): Promise<QueueResult> {
  const result: QueueResult = { queued: 0, failed: 0, errors: [] };
  const collection = context.collections<PendingDocument>(PENDING_COLLECTION);
  for (const node of graph.nodes) {
    const martId = martIds[node.key];
    const doc = pendingDocumentFor(node, graph, bundleName);
    if (!martId || !doc) continue;
    try {
      await collection.put(martId, doc, { parentId: martId });
      result.queued += doc.fields.length;
    } catch (error) {
      result.failed += doc.fields.length;
      result.errors.push(`Calculated fields for “${node.title}”: ${errorMessage(error)}`);
    }
  }
  return result;
}

// ─── Waiting list ──────────────────────────────────────────────────────────────

interface LiveSchemaField {
  name: string;
  type?: string;
  status?: string;
  calculated?: unknown;
  fields?: LiveSchemaField[];
  [key: string]: unknown;
}

interface LiveDataMart {
  id: string;
  title: string;
  /** `DRAFT` or `PUBLISHED`. */
  status?: string;
  definitionType?: string | null;
  storage?: { type: string };
  schema?: { type: string; fields: LiveSchemaField[]; [key: string]: unknown };
}

export type PendingState =
  /** Published, and every column the formulas read is CONNECTED: the fields can be added now. */
  | { kind: 'ready' }
  /** Still a draft. Publishing needs an input source, and a joined reference resolves only
   *  against published Data Marts, so this is the step a member is told to take. */
  | { kind: 'needs-publish' }
  /** Published, but these columns are not CONNECTED — the schema was not re-read from the
   *  warehouse yet, or the warehouse object has no column by that name. */
  | { kind: 'needs-columns'; missing: string[] }
  | { kind: 'error'; message: string };

export interface PendingMart {
  martId: string;
  doc: PendingDocument;
  state: PendingState;
  /** When the import parked these fields: the reader may come back weeks later. */
  importedAt?: string;
}

/** Every Data Mart with calculated fields still waiting, and whether each can take them now. */
export async function listPendingMarts(context: PluginContext): Promise<PendingMart[]> {
  const collection = context.collections<PendingDocument>(PENDING_COLLECTION);
  const docs: Array<{ id: string; document: PendingDocument; createdAt?: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await collection.list({ limit: 100, ...(cursor ? { cursor } : {}) });
    docs.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  return Promise.all(
    docs
      .filter(doc => doc.document?.fields?.length)
      .map(async ({ id, document, createdAt }) => {
        const importedAt = createdAt ? { importedAt: createdAt } : {};
        try {
          const mart = await readMart(context, id);
          return { martId: id, doc: { ...document, martTitle: mart.title }, state: stateOf(mart, document), ...importedAt };
        } catch (error) {
          return { martId: id, doc: document, state: { kind: 'error', message: errorMessage(error) } as PendingState, ...importedAt };
        }
      }),
  );
}

function readMart(context: PluginContext, martId: string): Promise<LiveDataMart> {
  return context.owox.getJson<LiveDataMart>(`/api/data-marts/${encodeURIComponent(martId)}`);
}

/** Every column a formula may read, by its dotted name, with whether ODM has connected it. */
function connectedColumns(fields: readonly LiveSchemaField[], prefix = ''): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const field of fields) {
    if (field.calculated) continue;
    const name = prefix ? `${prefix}.${field.name}` : field.name;
    out.set(name, field.status !== 'DISCONNECTED');
    if (Array.isArray(field.fields)) for (const [k, v] of connectedColumns(field.fields, name)) out.set(k, v);
  }
  return out;
}

export function stateOf(mart: LiveDataMart, doc: PendingDocument): PendingState {
  if (mart.status !== 'PUBLISHED') return { kind: 'needs-publish' };
  const columns = connectedColumns(mart.schema?.fields ?? []);
  const missing = [...new Set(doc.fields.flatMap(field => field.requires))].filter(name => !columns.get(name));
  return missing.length ? { kind: 'needs-columns', missing } : { kind: 'ready' };
}

// ─── Add to ODM ────────────────────────────────────────────────────────────────

export interface ApplyResult {
  added: number;
  /** Fields ODM refused, each with its reason; they stay waiting. */
  refused: Array<{ name: string; error: string }>;
}

/**
 * Add a Data Mart's waiting calculated fields to its live schema.
 *
 * The live schema is sent back as ODM returned it — whatever columns the warehouse gave it — with
 * the calculated fields appended; nothing the member changed since the import is overwritten.
 * ODM dry-runs every formula on the save and one refusal fails the whole request, so a refused
 * batch is retried one field at a time, in bundle order (a field may read the one before it):
 * every field ODM accepts is kept, and each refusal is recorded with ODM's own reason.
 */
export async function applyPendingFields(context: PluginContext, martId: string, doc: PendingDocument): Promise<ApplyResult> {
  const mart = await readMart(context, martId);
  const schema = mart.schema;
  const storageType = mart.storage?.type;
  if (!schema || !storageType) throw new Error(`“${mart.title}” has no schema to add calculated fields to yet.`);

  const present = new Set(schema.fields.map(field => field.name));
  const toAdd = doc.fields.filter(field => !present.has(field.name));
  const put = (fields: LiveSchemaField[]) =>
    context.owox.putJson(`/api/data-marts/${encodeURIComponent(martId)}/schema`, {
      schema: { ...schema, fields },
    });
  const body = (field: PendingField): LiveSchemaField => ({
    name: field.name,
    type: mapFieldType(storageType, field.type),
    status: 'CONNECTED',
    description: field.description ?? '',
    isPrimaryKey: false,
    ...(field.alias ? { alias: field.alias } : {}),
    ...(isBigQuery(storageType) ? { mode: 'NULLABLE' } : {}),
    calculated: { formula: field.formula },
  });

  const result: ApplyResult = { added: doc.fields.length - toAdd.length, refused: [] };
  let accepted = [...schema.fields];
  try {
    if (toAdd.length) await put([...accepted, ...toAdd.map(body)]);
    result.added += toAdd.length;
  } catch {
    for (const field of toAdd) {
      try {
        await put([...accepted, body(field)]);
        accepted = [...accepted, body(field)];
        result.added += 1;
      } catch (error) {
        result.refused.push({ name: field.name, error: refusalMessage(error) });
      }
    }
  }

  const collection = context.collections<PendingDocument>(PENDING_COLLECTION);
  if (result.refused.length === 0) {
    await collection.delete(martId);
  } else {
    const reasons = new Map(result.refused.map(entry => [entry.name, entry.error]));
    await collection.put(
      martId,
      {
        ...doc,
        martTitle: mart.title,
        fields: doc.fields
          .filter(field => reasons.has(field.name))
          .map(field => ({ ...field, lastError: reasons.get(field.name) })),
      },
      { parentId: martId },
    );
  }
  return result;
}

/** Stop waiting: the member decided not to add these fields. */
export async function dismissPendingFields(context: PluginContext, martId: string): Promise<void> {
  await context.collections<PendingDocument>(PENDING_COLLECTION).delete(martId);
}

/** Drop every waiting field at once, leaving nothing of the import behind in the collection.
 *  Returns the Data Marts it could not clear, each with the reason. */
export async function discardAllPending(context: PluginContext, martIds: string[]): Promise<string[]> {
  const collection = context.collections<PendingDocument>(PENDING_COLLECTION);
  const failed: string[] = [];
  for (const martId of martIds) {
    try {
      await collection.delete(martId);
    } catch (error) {
      failed.push(`${martId}: ${errorMessage(error)}`);
    }
  }
  return failed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * ODM's reason for refusing a formula. The transport's own message is the envelope ("Calculated
 * field validation failed"); the per-field sentences ride in the error's `details`, which is
 * what the member needs to fix anything — "`order_id` no longer exists in the Data Mart".
 */
export function refusalMessage(error: unknown): string {
  const details = (error as { payload?: { details?: unknown } })?.payload?.details;
  const found: string[] = [];
  const collect = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 3) return;
    const errors = (value as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      for (const entry of errors) {
        const message = (entry as { message?: unknown })?.message;
        if (typeof message === 'string') found.push(message);
      }
    }
    for (const nested of Object.values(value)) if (nested !== errors) collect(nested, depth + 1);
  };
  collect(details, 0);
  return found.length ? [...new Set(found)].join(' ') : errorMessage(error);
}
