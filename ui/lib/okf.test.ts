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
