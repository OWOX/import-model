import { describe, expect, it, vi } from 'vitest';
import {
  buildSchema,
  findExistingTitleConflicts,
  importModel,
  blendedSourcesFor,
  dedupFunction,
  mapFieldType,
  prepareGraphForImport,
  selectSubgraph,
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
    const call = ctx.owox.putJson.mock.calls.find(
      ([path]: [string]) => path === '/api/data-marts/mart-1/blended-fields-config');
    expect(call[1].blendedFieldsConfig.sources).toEqual([
      expect.objectContaining({ path: 'subscription', alias: 'Subscription' }),
      expect.objectContaining({
        path: 'subscription.account',
        alias: 'Subscription Account',
        description: 'The account behind the billed subscription.',
      }),
    ]);
    expect(result.joinsNamed).toBe(3);
  });

  it('configures the joins of a bundle that names nothing, for the dedup alone', async () => {
    // Without a config ODM collapses a joined string with STRING_AGG, so a lookup reads as
    // every value the join ever matched. That is worth a call even when the bundle has no
    // label or sentence to add.
    const ctx = context();
    await importModel(ctx, { id: 'storage', title: 'BQ', type: 'GOOGLE_BIGQUERY' }, graph);
    const call = ctx.owox.putJson.mock.calls.find(
      ([path]: [string]) => path.includes('blended-fields-config'));
    expect(call).toBeDefined();
    const [source] = call![1].blendedFieldsConfig.sources;
    expect(source).toMatchObject({ path: 'customers', alias: 'Customers' });
    expect(source.description).toBeUndefined();
    expect(source.fields.id.aggregateFunction).toBeDefined();
  });

  it('carries a hand-written label for a direct join too', () => {
    const titles = new Map(describedGraph.nodes.map(node => [node.key, node.title]));
    const withLabel: ModelGraph = {
      ...describedGraph,
      edges: describedGraph.edges.map(edge =>
        edge.id === 'e1' ? { ...edge, targetLabel: 'Billed Subscription' } : edge),
    };
    expect(blendedSourcesFor(withLabel.nodes[0], withLabel, titles).map(source => ({
      path: source.path, alias: source.alias, description: source.description,
    }))).toEqual([
      { path: 'subscription', alias: 'Billed Subscription', description: undefined },
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
    expect(result.joinsFailed).toBeGreaterThan(0);
    expect(result.relationshipsCreated).toBe(2);
    expect(result.errors.some(error => error.includes('Join names for “Invoices”'))).toBe(true);
  });
});

describe('importModel join failures are loud', () => {
  it('names the paths that went unnamed', async () => {
    const ctx = context();
    ctx.owox.putJson.mockImplementation(async (path: string) => {
      if (path.includes('blended-fields-config')) throw new Error('nope');
      return {};
    });
    const result = await importModel(ctx, { id: 'storage', title: 'BQ', type: 'GOOGLE_BIGQUERY' }, describedGraph);
    expect(result.errors.some(error => error.includes('subscription.account'))).toBe(true);
  });
});

describe('join dedup', () => {
  const titles = new Map(describedGraph.nodes.map(node => [node.key, node.title]));

  it('collapses a lookup with ANY_VALUE and a fan-out with a real aggregate', () => {
    expect(dedupFunction('N:1', 'STRING')).toBe('ANY_VALUE');
    expect(dedupFunction('1:1', 'NUMERIC')).toBe('ANY_VALUE');
    expect(dedupFunction('N:N', 'NUMERIC')).toBe('SUM');
    expect(dedupFunction('1:N', 'STRING')).toBe('STRING_AGG');
    expect(dedupFunction('1:N', 'DATE')).toBe('MAX');
    // An untagged edge is treated as fanning out: the safe reading, since ODM's own
    // default (STRING_AGG) is what a missing tag produces anyway.
    expect(dedupFunction(undefined, 'STRING')).toBe('STRING_AGG');
  });

  it('writes a dedup for every field of every source it can reach', () => {
    const tagged: ModelGraph = {
      ...describedGraph,
      edges: describedGraph.edges.map(edge => ({ ...edge, cardinality: 'N:1' as const })),
    };
    const sources = blendedSourcesFor(tagged.nodes[0], tagged, titles);
    expect(sources.map(source => source.path)).toEqual(['subscription', 'subscription.account']);
    expect(sources[0].fields).toEqual({
      subscription_id: { aggregateFunction: 'ANY_VALUE', postJoinAggregations: ['COUNT', 'COUNT_DISTINCT'] },
      account_id: { aggregateFunction: 'ANY_VALUE', postJoinAggregations: ['COUNT', 'COUNT_DISTINCT'] },
    });
  });

  it('reads the cardinality of the hop that reaches the source, not of the first one', () => {
    const mixed: ModelGraph = {
      ...describedGraph,
      edges: describedGraph.edges.map(edge =>
        edge.id === 'e1' ? { ...edge, cardinality: 'N:1' as const }
                         : { ...edge, cardinality: 'N:N' as const }),
    };
    const sources = blendedSourcesFor(mixed.nodes[0], mixed, titles);
    const deep = sources.find(source => source.path === 'subscription.account')!;
    expect(deep.fields.account_id.aggregateFunction).toBe('STRING_AGG');
  });

  it('names a deep source the bundle did not name after the path that reaches it', () => {
    const unnamed: ModelGraph = {
      ...describedGraph,
      nodes: describedGraph.nodes.map(node =>
        node.key === 'invoices' ? { ...node, joinNodes: undefined } : node),
    };
    const deep = blendedSourcesFor(unnamed.nodes[0], unnamed, titles)
      .find(source => source.path === 'subscription.account')!;
    expect(deep.alias).toBe('Subscription Account');
  });

  it('never re-enters a Data Mart already on the path', () => {
    const cyclic: ModelGraph = {
      ...describedGraph,
      edges: [
        ...describedGraph.edges.map(edge => ({ ...edge, bidirectional: true })),
      ],
    };
    const paths = blendedSourcesFor(cyclic.nodes[0], cyclic, titles).map(source => source.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.every(path => !path.split('.').some((seg, i, all) => all.indexOf(seg) !== i))).toBe(true);
  });
});

describe('selectSubgraph', () => {
  const threeNodeGraph: ModelGraph = {
    storageId: null,
    nodes: [
      { key: 'invoices', title: 'Invoices', inputSource: 'SQL', schema: [{ name: 'id', type: 'STRING', pk: true }], position: { x: 0, y: 0 }, status: 'pending',
        joinNodes: [{ path: ['subscription', 'account'], targetKey: 'account', alias: 'Subscription Account' }] },
      { key: 'subscription', title: 'Subscription', inputSource: 'SQL', schema: [{ name: 'id', type: 'STRING', pk: true }], position: { x: 0, y: 0 }, status: 'pending' },
      { key: 'account', title: 'Account', inputSource: 'SQL', schema: [{ name: 'id', type: 'STRING', pk: true }], position: { x: 0, y: 0 }, status: 'pending' },
    ],
    edges: [
      { id: 'e1', from: 'invoices', to: 'subscription', keys: [{ left: 'id', right: 'id' }], bidirectional: false },
      { id: 'e2', from: 'subscription', to: 'account', keys: [{ left: 'id', right: 'id' }], bidirectional: false },
    ],
  };

  it('keeps only the selected Data Marts', () => {
    const selected = selectSubgraph(threeNodeGraph, new Set(['invoices', 'account']));
    expect(selected.nodes.map(node => node.key)).toEqual(['invoices', 'account']);
  });

  it('drops every relationship that touches a deselected Data Mart', () => {
    const selected = selectSubgraph(threeNodeGraph, new Set(['invoices', 'account']));
    expect(selected.edges).toEqual([]);
  });

  it('drops join nodes whose path runs through a deselected Data Mart', () => {
    const selected = selectSubgraph(threeNodeGraph, new Set(['invoices', 'account']));
    expect(selected.nodes[0].joinNodes).toEqual([]);
  });

  it('returns the whole graph when everything is selected', () => {
    const selected = selectSubgraph(threeNodeGraph, new Set(['invoices', 'subscription', 'account']));
    expect(selected.nodes).toHaveLength(3);
    expect(selected.edges).toHaveLength(2);
    expect(selected.nodes[0].joinNodes).toHaveLength(1);
  });
});
