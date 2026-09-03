import { describe, expect, it, vi } from 'vitest';
import {
  buildSchema,
  findExistingTitleConflicts,
  importModel,
  joinSourcesFor,
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

const describedGraph: ModelGraph = {
  storageId: null,
  nodes: [
    {
      key: 'invoices', title: 'Invoices', inputSource: 'SQL',
      schema: [{ name: 'invoice_id', type: 'STRING', pk: true }, { name: 'subscription_id', type: 'STRING', pk: false }],
      joinNodes: [{
        path: ['subscription', 'account'],
        targetKey: 'account',
        alias: 'Subscription Account',
        description: 'The account behind the billed subscription.',
      }],
      position: { x: 0, y: 0 }, status: 'pending',
    },
    {
      key: 'subscription', title: 'Subscription', inputSource: 'SQL',
      schema: [{ name: 'subscription_id', type: 'STRING', pk: true }, { name: 'account_id', type: 'STRING', pk: false }],
      position: { x: 0, y: 0 }, status: 'pending',
    },
    {
      key: 'account', title: 'Account', inputSource: 'SQL',
      schema: [{ name: 'account_id', type: 'STRING', pk: true }],
      position: { x: 0, y: 0 }, status: 'pending',
    },
  ],
  edges: [
    {
      id: 'e1', from: 'invoices', to: 'subscription', bidirectional: false,
      keys: [{ left: 'subscription_id', right: 'subscription_id' }],
      description: 'The subscription this invoice bills.',
    },
    {
      id: 'e2', from: 'subscription', to: 'account', bidirectional: false,
      keys: [{ left: 'account_id', right: 'account_id' }],
    },
  ],
};

describe('importModel join metadata', () => {
  it('sends the edge description ODM hands to an assistant', async () => {
    const ctx = context();
    await importModel(ctx, { id: 'storage', title: 'BQ', type: 'GOOGLE_BIGQUERY' }, describedGraph);
    expect(ctx.owox.postJson).toHaveBeenCalledWith('/api/data-marts/mart-1/relationships', {
      targetDataMartId: 'mart-2',
      targetAlias: 'subscription',
      joinConditions: [{ sourceFieldName: 'subscription_id', targetFieldName: 'subscription_id' }],
      description: 'The subscription this invoice bills.',
    });
  });

  it('names a join node so the flat column picker can tell two Accounts apart', async () => {
    const ctx = context();
    const result = await importModel(ctx, { id: 'storage', title: 'BQ', type: 'GOOGLE_BIGQUERY' }, describedGraph);
    expect(ctx.owox.putJson).toHaveBeenCalledWith('/api/data-marts/mart-1/blended-fields-config', {
      blendedFieldsConfig: {
        sources: [{
          path: 'subscription.account',
          alias: 'Subscription Account',
          description: 'The account behind the billed subscription.',
        }],
      },
    });
    expect(result.joinsNamed).toBe(1);
  });

  it('leaves the blended config alone when the bundle names nothing', async () => {
    const ctx = context();
    await importModel(ctx, { id: 'storage', title: 'BQ', type: 'GOOGLE_BIGQUERY' }, graph);
    const calls = ctx.owox.putJson.mock.calls.map((call: unknown[]) => call[0]);
    expect(calls.some((path: string) => path.includes('blended-fields-config'))).toBe(false);
  });

  it('carries a hand-written label for a direct join too', () => {
    const titles = new Map(describedGraph.nodes.map(node => [node.key, node.title]));
    const withLabel: ModelGraph = {
      ...describedGraph,
      edges: describedGraph.edges.map(edge =>
        edge.id === 'e1' ? { ...edge, targetLabel: 'Billed Subscription' } : edge),
    };
    expect(joinSourcesFor(withLabel.nodes[0], withLabel, titles)).toEqual([
      { path: 'subscription', alias: 'Billed Subscription' },
      {
        path: 'subscription.account',
        alias: 'Subscription Account',
        description: 'The account behind the billed subscription.',
      },
    ]);
  });

  it('reports a failed naming call without failing the import', async () => {
    const ctx = context();
    ctx.owox.putJson.mockImplementation(async (path: string) => {
      if (path.includes('blended-fields-config')) throw new Error('nope');
      return {};
    });
    const result = await importModel(ctx, { id: 'storage', title: 'BQ', type: 'GOOGLE_BIGQUERY' }, describedGraph);
    expect(result.joinsFailed).toBe(1);
    expect(result.relationshipsCreated).toBe(2);
    expect(result.errors.some(error => error.includes('Join names for “Invoices”'))).toBe(true);
  });
});
