import { describe, expect, it, vi } from 'vitest';
import {
  buildSchema,
  findExistingTitleConflicts,
  importModel,
  mapFieldType,
  prepareGraphForImport,
} from './import-model';
import type { ModelGraph } from './okf-types';

const graph: ModelGraph = {
  storageId: null,
  nodes: [
    { key: 'orders', title: 'Orders', inputSource: 'SQL', description: 'Orders', schema: [{ name: 'id', type: 'STRING', pk: true }], position: { x: 0, y: 0 }, status: 'pending' },
    { key: 'customers', title: 'Customers', inputSource: 'SQL', schema: [{ name: 'id', type: 'INTEGER', pk: true }], position: { x: 0, y: 0 }, status: 'pending' },
  ],
  edges: [{ id: 'edge-1', from: 'orders', to: 'customers', keys: [{ left: 'id', right: 'id' }], bidirectional: false }],
};

function context() {
  let next = 0;
  return {
    projectId: 'project',
    owox: {
      postJson: vi.fn(async () => ({ id: `mart-${++next}` })),
      putJson: vi.fn(async () => ({})),
      models: { getDataMarts: vi.fn(async () => ({ items: [], total: 0, nextOffset: null })) },
    },
  } as any;
}

describe('importModel', () => {
  it('creates actual ODM marts, schemas, and a relationship', async () => {
    const ctx = context();
    const result = await importModel(ctx, { id: 'storage', title: 'BQ', type: 'GOOGLE_BIGQUERY' }, graph);

    expect(result).toMatchObject({ martsCreated: 2, martsFailed: 0, relationshipsCreated: 1, relationshipsFailed: 0 });
    expect(ctx.owox.postJson).toHaveBeenCalledWith('/api/data-marts', { title: 'Orders', storageId: 'storage' });
    expect(ctx.owox.putJson).toHaveBeenCalledWith('/api/data-marts/mart-1/schema', {
      schema: expect.objectContaining({ type: 'bigquery-data-mart-schema' }),
    });
    expect(ctx.owox.postJson).toHaveBeenCalledWith('/api/data-marts/mart-1/relationships', {
      targetDataMartId: 'mart-2',
      targetAlias: 'customers',
      joinConditions: [{ sourceFieldName: 'id', targetFieldName: 'id' }],
    });
  });

  it('detects title conflicts before import', async () => {
    const ctx = context();
    ctx.owox.models.getDataMarts.mockResolvedValue({
      items: [{ id: 'existing', title: ' orders ', status: 'DRAFT', description: null, fieldCount: 1 }],
      total: 1,
      nextOffset: null,
    });
    await expect(findExistingTitleConflicts(ctx, 'storage', graph)).resolves.toEqual(['Orders']);
  });

  it('maps portable OKF types to warehouse-specific ODM schemas', () => {
    expect(mapFieldType('AWS_REDSHIFT', 'STRING')).toBe('VARCHAR');
    expect(mapFieldType('AWS_ATHENA', 'NUMERIC')).toBe('DECIMAL');
    expect(mapFieldType('DATABRICKS', 'INTEGER')).toBe('INT');
    expect(buildSchema('DATABRICKS', [{ name: 'id', type: 'INTEGER', pk: true }])).toMatchObject({
      type: 'databricks-data-mart-schema',
      table: '',
      fields: [{ name: 'id', type: 'INT', isPrimaryKey: true }],
    });
  });

  it('adds a missing join field using the counterpart primary-key type', () => {
    const incomplete: ModelGraph = {
      ...graph,
      nodes: graph.nodes.map(node =>
        node.key === 'orders' ? { ...node, schema: [] } : { ...node, schema: [...node.schema] },
      ),
    };

    const prepared = prepareGraphForImport(incomplete);
    expect(prepared.nodes.find(node => node.key === 'orders')?.schema).toContainEqual({
      name: 'id',
      type: 'INTEGER',
      pk: false,
    });
    expect(incomplete.nodes.find(node => node.key === 'orders')?.schema).toEqual([]);
  });

  it('keeps an invalid nested join visible as an unconfigured relationship', async () => {
    const ctx = context();
    const nested: ModelGraph = {
      ...graph,
      edges: [{ ...graph.edges[0], keys: [{ left: 'customer.id', right: 'id' }] }],
    };

    const result = await importModel(
      ctx,
      { id: 'storage', title: 'BQ', type: 'GOOGLE_BIGQUERY' },
      nested,
    );

    expect(ctx.owox.postJson).toHaveBeenCalledWith('/api/data-marts/mart-1/relationships', {
      targetDataMartId: 'mart-2',
      targetAlias: 'customers',
      joinConditions: [],
    });
    expect(result.relationshipsWithoutKeys).toBe(1);
  });

  it('rejects duplicate titles before any ODM write starts', () => {
    expect(() =>
      prepareGraphForImport({
        ...graph,
        nodes: [graph.nodes[0], { ...graph.nodes[1], title: ' orders ' }],
      }),
    ).toThrow(/duplicate Data Mart title/);
  });
});
