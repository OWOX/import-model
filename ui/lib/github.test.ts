import { describe, expect, it } from 'vitest';
import { extractMdLinks } from './github';

describe('extractMdLinks', () => {
  it("leaves out the industry models a source model's description points at", () => {
    // From OWOX/models bundles/sources/stripe/index.md: the description names the marts that
    // Stripe joins in other bundles. Fetching them would import E-Commerce Customers and SaaS
    // Account as if they were part of Stripe.
    const index = `---
description: |
  In the business model Customers join [Customers](../e-commerce/customers.md) and
  [Account](../saas/account.md) on the ids and emails you store.
---
| [Charges](./charges.md) | 33 |
| [Customers](./customers.md) | 17 |`;
    expect(extractMdLinks(index)).toEqual(['charges.md', 'customers.md']);
  });

  it('keeps sub-folder links, drops root-absolute ones and the index itself', () => {
    const index = `[A](./references/metrics/a.md) [B](/etc/b.md) [I](./index.md) [C](c.md#schema)`;
    expect(extractMdLinks(index)).toEqual(['references/metrics/a.md', 'c.md']);
  });
});
