import { beforeEach, describe, expect, it } from 'vitest';
import * as sdk from '../sdk-mock';
import {
  applyPendingFields,
  discardAllPending,
  listPendingMarts,
  pendingDocumentFor,
  queueCalculatedFields,
  refusalMessage,
  stateOf,
  toStoredFormula,
} from './calculated-fields';
import { importModel, prepareGraphForImport } from './import-model';
import { parseBundle } from './okf';
import type { ModelGraph } from './okf-types';

// Shaped after OWOX/models bundles/e-commerce: Orders reaches Products through Purchases, and the
// generator declared the alias of the first hop only (`as \`purchases_e_commerce\``) while the
// formula also names the second (`products_e_commerce`).
const BUNDLE = {
  'shop/orders.md': `---
title: "Orders"
type: "OWOX Data Mart"
---

# Schema

| Column | Type | Alias | Description |
|--------|------|-------|-------------|
| \`order_id\` | STRING | Order ID | PK. Unique order |
| \`status\` | STRING | Status | Fulfilment state |
| \`order_date\` | DATE | Order Date | When the order completed |

## Calculated fields

### \`orders_total\` · INTEGER · Metric

- **Alias:** Orders

Distinct orders in the selected rows, every status.

\`\`\`sql
COUNT(DISTINCT order_id)
\`\`\`

### \`completed_orders\` · INTEGER · Metric

- **Alias:** Completed Orders

\`\`\`sql
COUNTIF(status = 'Completed')
\`\`\`

### \`completion_rate\` · FLOAT · Metric

Share of orders that completed.

Read as a fraction.

\`\`\`sql
SAFE_DIVIDE(completed_orders, COUNT(DISTINCT order_id))
\`\`\`

### \`distinct_products_in_order\` · INTEGER · Metric

\`\`\`sql
COUNT(DISTINCT purchases_e_commerce.products_e_commerce.product_id)
\`\`\`

# Example Questions

- How many orders complete?

## Joins

- [Purchases](./purchases.md) as \`purchases_e_commerce\` — \`order_id = order_id\` [1:N] — The lines this order is made of.
`,
  'shop/purchases.md': `---
title: "Purchases"
type: "OWOX Data Mart"
---

# Schema

| Column | Type | Alias | Description |
|--------|------|-------|-------------|
| \`line_id\` | STRING | Line ID | PK. Unique line |
| \`order_id\` | STRING | Order ID | FK to [Orders](./orders.md) |
| \`product_id\` | STRING | Product ID | FK to [Products](./products.md) |

## Joins

- [Orders](./orders.md) — \`order_id = order_id\` [N:1] — The order this line belongs to.
- [Products](./products.md) — \`product_id = product_id\` [N:1] — The product sold on this line.
`,
  'shop/products.md': `---
title: "Products"
type: "OWOX Data Mart"
---

# Schema

| Column | Type | Alias | Description |
|--------|------|-------|-------------|
| \`product_id\` | STRING | Product ID | PK. Unique product |
| \`date\` | DATE | Date | Listing date |

## Calculated fields

### \`listing_year\` · INTEGER · Column

\`\`\`sql
EXTRACT(YEAR FROM date) -- year of 'date'
\`\`\`
`,
};

function graph(): ModelGraph {
  return prepareGraphForImport(parseBundle(BUNDLE));
}

const node = (g: ModelGraph, key: string) => g.nodes.find(entry => entry.key === key)!;

describe('parsing calculated fields', () => {
  it('reads name, type, alias, description and formula, and ends the section at the next heading', () => {
    const orders = node(graph(), 'orders');
    expect(orders.schema.map(field => field.name)).toEqual(['order_id', 'status', 'order_date']);
    expect(orders.calculatedFields).toEqual([
      {
        name: 'orders_total',
        type: 'INTEGER',
        alias: 'Orders',
        description: 'Distinct orders in the selected rows, every status.',
        formula: 'COUNT(DISTINCT order_id)',
      },
      { name: 'completed_orders', type: 'INTEGER', alias: 'Completed Orders', formula: "COUNTIF(status = 'Completed')" },
      {
        name: 'completion_rate',
        type: 'FLOAT',
        description: 'Share of orders that completed.\n\nRead as a fraction.',
        formula: 'SAFE_DIVIDE(completed_orders, COUNT(DISTINCT order_id))',
      },
      {
        name: 'distinct_products_in_order',
        type: 'INTEGER',
        formula: 'COUNT(DISTINCT purchases_e_commerce.products_e_commerce.product_id)',
      },
    ]);
    expect(node(graph(), 'purchases').calculatedFields).toBeUndefined();
  });

  it('keeps the alias a join line declares with `as`, for the direction that declared it', () => {
    const edge = graph().edges.find(entry => entry.from === 'orders' && entry.to === 'purchases')!;
    expect(edge).toMatchObject({ alias: 'purchases_e_commerce', bidirectional: true, description: 'The lines this order is made of.' });
    expect(edge.reverseAlias).toBeUndefined();
  });
});

describe('toStoredFormula', () => {
  it('tags own columns and own calculated fields, and lists the columns it needs connected', () => {
    const g = graph();
    const orders = node(g, 'orders');
    const [total, completed, rate] = orders.calculatedFields!;
    expect(toStoredFormula(total, orders, g)).toEqual({
      formula: 'COUNT(DISTINCT {{ref field="order_id"}})',
      requires: ['order_id'],
    });
    expect(toStoredFormula(completed, orders, g)).toEqual({
      formula: `COUNTIF({{ref field="status"}} = 'Completed')`,
      requires: ['status'],
    });
    expect(toStoredFormula(rate, orders, g)).toEqual({
      formula: 'SAFE_DIVIDE({{ref field="completed_orders"}}, COUNT(DISTINCT {{ref field="order_id"}}))',
      requires: ['order_id'],
    });
  });

  it('resolves a two-hop joined reference to the aliases the relationships are created with', () => {
    const g = graph();
    const orders = node(g, 'orders');
    // `products_e_commerce` was never declared on Purchases → Products, which this import names
    // `products`; the path must use the alias ODM will actually hold.
    expect(toStoredFormula(orders.calculatedFields![3], orders, g)).toEqual({
      formula: 'COUNT(DISTINCT {{ref path="purchases_e_commerce.products" field="product_id"}})',
      requires: [],
    });
  });

  it('leaves SQL keywords, date parts, string literals and comments alone', () => {
    const g = graph();
    const products = node(g, 'products');
    expect(toStoredFormula(products.calculatedFields![0], products, g).formula).toBe(
      `EXTRACT(YEAR FROM {{ref field="date"}}) -- year of 'date'`,
    );
  });

  it('leaves a reference it cannot resolve as written, for ODM to name', () => {
    const g = graph();
    const orders = node(g, 'orders');
    const field = { name: 'x', type: 'INTEGER', formula: 'SUM(nowhere.amount) + SUM(unknown_column)' };
    expect(toStoredFormula(field, orders, g)).toEqual({ formula: 'SUM(nowhere.amount) + SUM(unknown_column)', requires: [] });
  });
});

describe('the pending flow against the mock ODM', () => {
  beforeEach(() => sdk.__resetForTests());

  async function importShop() {
    const context = await sdk.connect();
    const g = graph();
    const imported = await importModel(context as never, { id: 'storage-bigquery', title: 'BQ', type: 'GOOGLE_BIGQUERY' }, g);
    const queued = await queueCalculatedFields(context as never, g, imported.martIds, 'Shop');
    return { context, imported, queued };
  }

  it('creates the relationship under the bundle alias, so the formula paths exist in ODM', async () => {
    await importShop();
    const relationships = sdk.__mock.requests.filter(request => request.path.endsWith('/relationships'));
    expect(relationships.map(request => (request.body as { targetAlias: string }).targetAlias)).toEqual([
      'purchases_e_commerce',
      'orders',
      'products',
    ]);
  });

  it('queues each Data Mart’s formulas in the collection, bound to that Data Mart', async () => {
    const { imported, queued } = await importShop();
    expect(queued).toEqual({ queued: 5, failed: 0, errors: [] });
    const store = sdk.__mock.documents.get('pendingCalculatedFields')!;
    expect([...store.keys()].sort()).toEqual([imported.martIds.orders, imported.martIds.products].sort());
    expect(store.get(imported.martIds.orders)!.parentId).toBe(imported.martIds.orders);
  });

  it('says a draft waits for publishing, then adds every field once it is published and connected', async () => {
    const { context, imported } = await importShop();
    const ordersId = imported.martIds.orders;

    let pending = await listPendingMarts(context as never);
    const waiting = pending.find(entry => entry.martId === ordersId)!;
    expect(waiting.state).toEqual({ kind: 'needs-publish' });
    expect(waiting.importedAt).toEqual(expect.any(String));
    expect(waiting.doc.bundleName).toBe('Shop');

    sdk.__mock.connectMarts();
    pending = await listPendingMarts(context as never);
    const orders = pending.find(entry => entry.martId === ordersId)!;
    expect(orders.state).toEqual({ kind: 'ready' });

    const result = await applyPendingFields(context as never, ordersId, orders.doc);
    expect(result).toEqual({ added: 4, refused: [] });
    const saved = sdk.__mock.marts.get(ordersId)!.schema!.fields;
    expect(saved.map(field => field.name)).toEqual([
      'order_id', 'status', 'order_date', 'orders_total', 'completed_orders', 'completion_rate', 'distinct_products_in_order',
    ]);
    expect(saved.find(field => field.name === 'orders_total')).toMatchObject({
      type: 'INTEGER',
      alias: 'Orders',
      description: 'Distinct orders in the selected rows, every status.',
      isPrimaryKey: false,
      mode: 'NULLABLE',
      calculated: { formula: 'COUNT(DISTINCT {{ref field="order_id"}})' },
    });
    expect(sdk.__mock.documents.get('pendingCalculatedFields')!.has(ordersId)).toBe(false);
  });

  it('keeps what ODM accepts and leaves each refused field waiting with ODM’s reason', async () => {
    const { context, imported } = await importShop();
    const ordersId = imported.martIds.orders;
    sdk.__mock.connectMarts();
    // The warehouse object turned out not to carry `status`.
    const mart = sdk.__mock.marts.get(ordersId)!;
    mart.schema!.fields.find(field => field.name === 'status')!.status = 'DISCONNECTED';

    const doc = (await listPendingMarts(context as never)).find(entry => entry.martId === ordersId)!.doc;
    const result = await applyPendingFields(context as never, ordersId, doc);

    expect(result.added).toBe(2);
    expect(result.refused).toEqual([
      { name: 'completed_orders', error: '`status` no longer exists in the Data Mart.' },
      { name: 'completion_rate', error: expect.any(String) },
    ]);
    const waiting = sdk.__mock.documents.get('pendingCalculatedFields')!.get(ordersId)!.document as { fields: Array<{ name: string; lastError?: string }> };
    expect(waiting.fields.map(field => field.name)).toEqual(['completed_orders', 'completion_rate']);
    expect(waiting.fields[0].lastError).toBe('`status` no longer exists in the Data Mart.');
  });
});

describe('stateOf', () => {
  const doc = pendingDocumentFor(node(graph(), 'orders'), graph(), 'Shop')!;

  it('names the columns that still have to connect', () => {
    expect(
      stateOf(
        {
          id: 'm',
          title: 'Orders',
          status: 'PUBLISHED',
          definitionType: 'TABLE',
          schema: { type: 'bigquery-data-mart-schema', fields: [
            { name: 'order_id', status: 'CONNECTED' },
            { name: 'status', status: 'DISCONNECTED' },
          ] },
        },
        doc,
      ),
    ).toEqual({ kind: 'needs-columns', missing: ['status'] });
  });
});

describe('discardAllPending', () => {
  beforeEach(() => sdk.__resetForTests());

  it('deletes every waiting document and leaves the Data Marts alone', async () => {
    const context = await sdk.connect();
    const g = graph();
    const imported = await importModel(context as never, { id: 'storage-bigquery', title: 'BQ', type: 'GOOGLE_BIGQUERY' }, g);
    await queueCalculatedFields(context as never, g, imported.martIds, 'Shop');

    const failed = await discardAllPending(context as never, Object.values(imported.martIds));

    expect(failed).toEqual([]);
    expect(sdk.__mock.documents.get('pendingCalculatedFields')!.size).toBe(0);
    expect(sdk.__mock.marts.size).toBe(3);
  });
});

describe('refusalMessage', () => {
  it('prefers ODM’s per-field sentences over the transport envelope', () => {
    const error = Object.assign(new Error('Calculated field validation failed'), {
      payload: { details: { errors: [{ message: 'A' }, { message: 'B' }] } },
    });
    expect(refusalMessage(error)).toBe('A B');
    expect(refusalMessage(new Error('Network down'))).toBe('Network down');
  });
});
