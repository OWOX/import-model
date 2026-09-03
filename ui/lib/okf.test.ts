import { describe, expect, it } from 'vitest';
import { parseBundle } from './okf';

describe('parseBundle', () => {
  it('preserves alias, description, primary key, and joins from the current OWOX/models format', () => {
    const graph = parseBundle({
      'demo/customers.md': `---
title: "Customers"
description: |
  Registered customers and their acquisition source.
type: "OWOX Data Mart"
---
# Schema
| Column | Type | Alias | Description |
|---|---|---|---|
| \`customer_id\` | INTEGER | Customer ID | PK. Unique customer |
`,
      'demo/orders.md': `---
title: "Orders"
type: "OWOX Data Mart"
---
# Schema
| Column | Type | Alias | Description |
|---|---|---|---|
| \`order_id\` | STRING | Order ID | PK. Unique order |
| \`customer_id\` | INTEGER | Customer ID | FK to [Customers](./customers.md) |

## Joins
- [Customers](./customers.md) — \`customer_id = customer_id\`
`,
    });

    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0]).toMatchObject({
      title: 'Customers',
      description: 'Registered customers and their acquisition source.',
      schema: [{
        name: 'customer_id',
        type: 'INTEGER',
        alias: 'Customer ID',
        description: 'Unique customer',
        pk: true,
      }],
    });
    expect(graph.edges).toEqual([
      expect.objectContaining({
        from: 'orders',
        to: 'customers',
        keys: [{ left: 'customer_id', right: 'customer_id' }],
      }),
    ]);
  });
});

describe('parseBundle join descriptions', () => {
  const bundle = (joins: string) => ({
    'demo/account.md': `---
title: "Account"
type: "OWOX Data Mart"
---
# Schema
| Column | Type | Description |
|---|---|---|
| \`account_id\` | STRING | PK. Account |
`,
    'demo/plan.md': `---
title: "Plan"
type: "OWOX Data Mart"
---
# Schema
| Column | Type | Description |
|---|---|---|
| \`plan_id\` | STRING | PK. Plan |
`,
    'demo/subscription.md': `---
title: "Subscription"
type: "OWOX Data Mart"
---
# Schema
| Column | Type | Description |
|---|---|---|
| \`subscription_id\` | STRING | PK. Subscription |
| \`account_id\` | STRING | Account |
| \`plan_id\` | STRING | Plan |
`,
    'demo/invoices.md': `---
title: "Invoices"
type: "OWOX Data Mart"
---
# Schema
| Column | Type | Description |
|---|---|---|
| \`invoice_id\` | STRING | PK. Invoice |
| \`subscription_id\` | STRING | Subscription |

## Joins
${joins}
`,
  });

  it('reads the sentence after the join keys onto the edge', () => {
    const graph = parseBundle(bundle(
      '- [Subscription](./subscription.md) — `subscription_id = subscription_id` [N:1] — The subscription this invoice bills.',
    ));
    expect(graph.edges[0]).toMatchObject({
      from: 'invoices',
      to: 'subscription',
      cardinality: 'N:1',
      description: 'The subscription this invoice bills.',
    });
  });

  it('does not mistake the glue between composite keys for a description', () => {
    const graph = parseBundle(bundle(
      '- [Subscription](./subscription.md) — `subscription_id = subscription_id` AND `account_id = account_id` [N:1]',
    ));
    expect(graph.edges[0].description).toBeUndefined();
    expect(graph.edges[0].keys).toHaveLength(2);
  });

  it('reads a nested bullet as a join node, keyed by its nesting', () => {
    const graph = parseBundle(bundle(
      '- [Subscription](./subscription.md) — `subscription_id = subscription_id`\n' +
      '  - [Subscription Account](./account.md) — The account behind the billed subscription.\n' +
      '  - [Subscription Plan](./plan.md) — The plan the billed subscription is on.',
    ));
    const invoices = graph.nodes.find(node => node.key === 'invoices')!;
    expect(invoices.joinNodes).toEqual([
      {
        path: ['subscription', 'account'],
        targetKey: 'account',
        alias: 'Subscription Account',
        description: 'The account behind the billed subscription.',
      },
      {
        path: ['subscription', 'plan'],
        targetKey: 'plan',
        alias: 'Subscription Plan',
        description: 'The plan the billed subscription is on.',
      },
    ]);
    // a nested bullet is NOT a direct join of this mart
    expect(graph.edges.filter(edge => edge.from === 'invoices')).toHaveLength(1);
  });

  it('extends the path with each further level of indent', () => {
    const graph = parseBundle(bundle(
      '- [Subscription](./subscription.md) — `subscription_id = subscription_id`\n' +
      '  - [Subscription Account](./account.md) — One hop out.\n' +
      '    - [Subscription Account Plan](./plan.md) — Two hops out.',
    ));
    const invoices = graph.nodes.find(node => node.key === 'invoices')!;
    expect(invoices.joinNodes?.map(node => node.path)).toEqual([
      ['subscription', 'account'],
      ['subscription', 'account', 'plan'],
    ]);
  });

  it('keeps a hand-written label for a direct join and drops one that repeats the title', () => {
    const graph = parseBundle(bundle(
      '- [Billed Subscription](./subscription.md) — `subscription_id = subscription_id`\n' +
      '- [Account](./account.md) — `account_id = account_id`',
    ));
    const byTarget = new Map(graph.edges.map(edge => [edge.to, edge]));
    expect(byTarget.get('subscription')?.targetLabel).toBe('Billed Subscription');
    expect(byTarget.get('account')?.targetLabel).toBeUndefined();
  });

  it('keeps both sentences of a bidirectional edge, one per direction', () => {
    const graph = parseBundle({
      'demo/a.md': `---
title: "A"
type: "OWOX Data Mart"
---
# Schema
| Column | Type | Description |
|---|---|---|
| \`id\` | STRING | PK. A |

## Joins
- [B](./b.md) — \`id = id\` — A reaches B.
`,
      'demo/b.md': `---
title: "B"
type: "OWOX Data Mart"
---
# Schema
| Column | Type | Description |
|---|---|---|
| \`id\` | STRING | PK. B |

## Joins
- [A](./a.md) — \`id = id\` — B reaches A.
`,
    });
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({
      bidirectional: true,
      description: 'A reaches B.',
      reverseDescription: 'B reaches A.',
    });
  });
});
