import type { PluginContext } from '@owox/plugin-sdk';
import type { ModelEdge, ModelGraph, ModelNode, SchemaField } from './okf-types';

export interface StorageRef {
  id: string;
  title: string;
  type: string;
}

export interface ImportProgress {
  phase: 'marts' | 'relationships';
  completed: number;
  total: number;
  label: string;
}

export interface ImportResult {
  martsCreated: number;
  martsFailed: number;
  schemasFailed: number;
  relationshipsCreated: number;
  relationshipsFailed: number;
  relationshipsWithoutKeys: number;
  errors: string[];
}

type ImportOptions = {
  onProgress?: (progress: ImportProgress) => void;
};

export async function listStorages(context: PluginContext): Promise<StorageRef[]> {
  const storages = await context.owox.storages.list();
  return storages
    .map(storage => ({ id: storage.id, title: storage.title, type: storage.type }))
    .sort((left, right) => left.title.localeCompare(right.title));
}

/** Return title collisions in one storage. Import blocks on these instead of silently duplicating marts. */
export async function findExistingTitleConflicts(
  context: PluginContext,
  storageId: string,
  graph: ModelGraph,
): Promise<string[]> {
  const existingTitles = new Set<string>();
  let offset: number | null = 0;
  do {
    const page = (await context.owox.models.getDataMarts(storageId, offset)) as unknown as {
      items: Array<{ title: string }>;
      nextOffset: number | null;
    };
    for (const item of page.items) existingTitles.add(normalizeTitle(item.title));
    offset = page.nextOffset;
  } while (offset !== null);

  return graph.nodes
    .map(node => node.title)
    .filter(title => existingTitles.has(normalizeTitle(title)))
    .sort((left, right) => left.localeCompare(right));
}

export async function importModel(
  context: PluginContext,
  storage: StorageRef,
  graph: ModelGraph,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const preparedGraph = prepareGraphForImport(graph);
  const result: ImportResult = {
    martsCreated: 0,
    martsFailed: 0,
    schemasFailed: 0,
    relationshipsCreated: 0,
    relationshipsFailed: 0,
    relationshipsWithoutKeys: 0,
    errors: [],
  };
  const idByKey = new Map<string, string>();

  for (let index = 0; index < preparedGraph.nodes.length; index += 1) {
    const node = preparedGraph.nodes[index];
    options.onProgress?.({
      phase: 'marts',
      completed: index,
      total: preparedGraph.nodes.length,
      label: node.title,
    });
    try {
      const created = await context.owox.postJson<{ id: string }>('/api/data-marts', {
        title: node.title,
        storageId: storage.id,
      });
      idByKey.set(node.key, created.id);
      result.martsCreated += 1;

      if (node.description) {
        try {
          await context.owox.putJson(`/api/data-marts/${encodeURIComponent(created.id)}/description`, {
            description: node.description,
          });
        } catch (error) {
          result.errors.push(`Description for “${node.title}”: ${errorMessage(error)}`);
        }
      }

      if (node.schema.length > 0) {
        try {
          await context.owox.putJson(`/api/data-marts/${encodeURIComponent(created.id)}/schema`, {
            schema: buildSchema(storage.type, node.schema),
          });
        } catch (error) {
          result.schemasFailed += 1;
          result.errors.push(`Schema for “${node.title}”: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      result.martsFailed += 1;
      result.errors.push(`Data Mart “${node.title}”: ${errorMessage(error)}`);
    }
  }

  const relationships = expandRelationshipDirections(preparedGraph.edges).map(edge => ({
    ...edge,
    // ODM accepts an empty array as a visible “Join not configured” relationship,
    // but rejects blank and nested join-field names.
    keys: edge.keys.filter(
      key => isTopLevelJoinField(key.left) && isTopLevelJoinField(key.right),
    ),
  }));
  const titleByKey = new Map(preparedGraph.nodes.map(node => [node.key, node.title]));
  for (let index = 0; index < relationships.length; index += 1) {
    const edge = relationships[index];
    const sourceTitle = titleByKey.get(edge.from) ?? edge.from;
    const targetTitle = titleByKey.get(edge.to) ?? edge.to;
    options.onProgress?.({
      phase: 'relationships',
      completed: index,
      total: relationships.length,
      label: `${sourceTitle} → ${targetTitle}`,
    });
    const sourceId = idByKey.get(edge.from);
    const targetId = idByKey.get(edge.to);
    if (!sourceId || !targetId) {
      result.relationshipsFailed += 1;
      result.errors.push(`Relationship ${sourceTitle} → ${targetTitle}: both Data Marts must exist.`);
      continue;
    }

    try {
      await context.owox.postJson(
        `/api/data-marts/${encodeURIComponent(sourceId)}/relationships`,
        {
          targetDataMartId: targetId,
          targetAlias: relationshipAlias(targetTitle, edge.to),
          joinConditions: edge.keys.map(key => ({
            sourceFieldName: key.left,
            targetFieldName: key.right,
          })),
        },
      );
      result.relationshipsCreated += 1;
      if (edge.keys.length === 0) result.relationshipsWithoutKeys += 1;
    } catch (error) {
      result.relationshipsFailed += 1;
      result.errors.push(`Relationship ${sourceTitle} → ${targetTitle}: ${errorMessage(error)}`);
    }
  }

  options.onProgress?.({
    phase: 'relationships',
    completed: relationships.length,
    total: relationships.length,
    label: 'Done',
  });
  return result;
}

/**
 * Make the imported schemas joinable before they are sent to ODM.
 *
 * Public OKF files may describe a join key that is absent from one schema. ODM
 * validates both field presence and field type when the relationship is created,
 * so infer a missing field from its counterpart and align an FK to the PK type.
 */
export function prepareGraphForImport(graph: ModelGraph): ModelGraph {
  assertUniqueNodes(graph.nodes);
  const prepared: ModelGraph = {
    ...graph,
    nodes: graph.nodes.map(node => ({
      ...node,
      schema: node.schema.map(field => ({ ...field })),
      position: { ...node.position },
    })),
    edges: graph.edges.map(edge => ({
      ...edge,
      keys: edge.keys.map(key => ({ ...key })),
    })),
  };
  const nodeByKey = new Map(prepared.nodes.map(node => [node.key, node]));

  for (const edge of prepared.edges) {
    const leftNode = nodeByKey.get(edge.from);
    const rightNode = nodeByKey.get(edge.to);
    if (!leftNode || !rightNode) continue;

    for (const key of edge.keys) {
      if (!isTopLevelJoinField(key.left) || !isTopLevelJoinField(key.right)) continue;
      let left = leftNode.schema.find(field => field.name === key.left);
      let right = rightNode.schema.find(field => field.name === key.right);

      if (!left) {
        left = { name: key.left, type: right?.type ?? 'STRING', pk: false };
        leftNode.schema.push(left);
      }
      if (!right) {
        right = { name: key.right, type: left.type, pk: false };
        rightNode.schema.push(right);
      }

      if (left.type !== right.type) {
        if (left.pk && !right.pk) right.type = left.type;
        if (right.pk && !left.pk) left.type = right.type;
      }
    }
  }

  return prepared;
}

function assertUniqueNodes(nodes: ModelNode[]): void {
  const keys = new Set<string>();
  const titles = new Set<string>();
  for (const node of nodes) {
    const key = node.key.trim();
    const title = normalizeTitle(node.title);
    if (!key || keys.has(key)) {
      throw new Error(`Bundle contains a missing or duplicate Data Mart key: “${node.key}”.`);
    }
    if (!title || titles.has(title)) {
      throw new Error(`Bundle contains a missing or duplicate Data Mart title: “${node.title}”.`);
    }
    keys.add(key);
    titles.add(title);
  }
}

export function buildSchema(storageType: string, fields: SchemaField[]): Record<string, unknown> {
  const type = schemaDiscriminator(storageType);
  const mappedFields = fields.map(field => ({
    name: field.name,
    type: mapFieldType(storageType, field.type),
    status: 'CONNECTED',
    description: field.description ?? '',
    isPrimaryKey: field.pk,
    ...(field.alias ? { alias: field.alias } : {}),
    ...(isBigQuery(storageType) ? { mode: 'NULLABLE' } : {}),
  }));

  return {
    type,
    ...(storageType === 'DATABRICKS' ? { table: '' } : {}),
    fields: mappedFields,
  };
}

function schemaDiscriminator(storageType: string): string {
  const engine = storageType
    .replace(/^LEGACY_/, '')
    .replace(/^GOOGLE_/, '')
    .replace(/^AWS_/, '')
    .toLowerCase();
  return `${engine}-data-mart-schema`;
}

function isBigQuery(storageType: string): boolean {
  return storageType === 'GOOGLE_BIGQUERY' || storageType === 'LEGACY_GOOGLE_BIGQUERY';
}

/** OKF uses portable types; ODM validates a different enum for every warehouse engine. */
export function mapFieldType(storageType: string, fieldType: string): string {
  const type = fieldType.toUpperCase();
  if (isBigQuery(storageType)) return type;

  const commonTemporal = type === 'DATETIME' ? 'TIMESTAMP' : type;
  switch (storageType) {
    case 'SNOWFLAKE':
      return ({
        BIGNUMERIC: 'NUMERIC',
        JSON: 'VARIANT',
        RECORD: 'VARIANT',
        STRUCT: 'VARIANT',
        INTERVAL: 'STRING',
      } as Record<string, string>)[commonTemporal] ?? commonTemporal;
    case 'AWS_ATHENA':
      return ({
        NUMERIC: 'DECIMAL',
        BIGNUMERIC: 'DECIMAL',
        BYTES: 'VARBINARY',
        GEOGRAPHY: 'STRING',
        RECORD: 'STRUCT',
      } as Record<string, string>)[commonTemporal] ?? commonTemporal;
    case 'AWS_REDSHIFT':
      return ({
        STRING: 'VARCHAR',
        FLOAT: 'DOUBLE PRECISION',
        BIGNUMERIC: 'NUMERIC',
        BYTES: 'BYTEA',
        JSON: 'SUPER',
        RECORD: 'SUPER',
        STRUCT: 'SUPER',
        INTERVAL: 'VARCHAR',
      } as Record<string, string>)[commonTemporal] ?? commonTemporal;
    case 'DATABRICKS':
      return ({
        INTEGER: 'INT',
        NUMERIC: 'DECIMAL',
        BIGNUMERIC: 'DECIMAL',
        BYTES: 'BINARY',
        TIME: 'STRING',
        GEOGRAPHY: 'STRING',
        JSON: 'STRING',
        RECORD: 'STRUCT',
      } as Record<string, string>)[commonTemporal] ?? commonTemporal;
    default:
      return type;
  }
}

function expandRelationshipDirections(edges: ModelEdge[]): ModelEdge[] {
  return edges.flatMap(edge =>
    edge.bidirectional
      ? [
          edge,
          {
            ...edge,
            id: `${edge.id}:reverse`,
            from: edge.to,
            to: edge.from,
            keys: edge.keys.map(key => ({ left: key.right, right: key.left })),
            bidirectional: false,
          },
        ]
      : [edge],
  );
}

function relationshipAlias(title: string, fallback: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safe = /^[0-9]/.test(normalized) ? `t_${normalized}` : normalized;
  return safe || fallback.replace(/[^a-zA-Z0-9_]/g, '_') || 'related_mart';
}

function isTopLevelJoinField(name: string): boolean {
  return name.trim().length > 0 && !name.includes('.');
}

function normalizeTitle(title: string): string {
  return title.trim().toLocaleLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
