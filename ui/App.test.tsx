import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import * as sdk from './sdk-mock';
import { resetPluginContextForTests } from './lib/plugin-runtime';

const TOP_INDEX = `---
title: "OKF Bundles"
type: "index"
---
- [E-Commerce](./e-commerce/index.md) — 2 concept(s)
`;

const BUNDLE_INDEX = `---
title: "E-Commerce"
type: "index"
---
| Data Mart | Fields |
|---|---|
| [Customers](./customers.md) | 2 |
| [Orders](./orders.md) | 2 |
`;

const CUSTOMERS = `---
title: "Customers"
description: "Registered customers"
type: "OWOX Data Mart"
---
# Schema
| Column | Type | Alias | Description |
|---|---|---|---|
| \`customer_id\` | INTEGER | Customer ID | PK. Unique customer |
| \`country\` | STRING | Country | Country name |
`;

const ORDERS = `---
title: "Orders"
description: "Placed orders"
type: "OWOX Data Mart"
---
# Schema
| Column | Type | Alias | Description |
|---|---|---|---|
| \`order_id\` | STRING | Order ID | PK. Unique order |
| \`customer_id\` | INTEGER | Customer ID | FK to [Customers](./customers.md) |

## Joins
- [Customers](./customers.md) — \`customer_id = customer_id\`
`;

function installFetchMock() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/bundles/index.md')) return new Response(TOP_INDEX, { status: 200 });
    if (url.endsWith('/bundles/e-commerce/index.md')) return new Response(BUNDLE_INDEX, { status: 200 });
    if (url.endsWith('/bundles/e-commerce/customers.md')) return new Response(CUSTOMERS, { status: 200 });
    if (url.endsWith('/bundles/e-commerce/orders.md')) return new Response(ORDERS, { status: 200 });
    return new Response('not found', { status: 404 });
  }));
}

describe('Import Model flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sdk.__resetForTests();
    resetPluginContextForTests();
    installFetchMock();
  });

  it('loads OWOX/models, previews the bundle, and creates marts, schemas, and relationships', async () => {
    render(<App />);

    const card = await screen.findByRole('button', { name: /E-Commerce/ });
    fireEvent.click(card);
    await screen.findByTestId('preview-screen');

    expect(screen.getByText('2', { selector: '.text-2xl' })).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('storage-select'), { target: { value: 'storage-bigquery' } });
    await waitFor(() => expect(screen.getByTestId('import-button')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('import-button'));

    await screen.findByTestId('complete-screen');
    const calls = sdk.__mock.requests;
    expect(calls.filter(call => call.method === 'POST' && call.path === '/api/data-marts')).toHaveLength(2);
    expect(calls.filter(call => call.method === 'PUT' && call.path.endsWith('/schema'))).toHaveLength(2);
    expect(calls.filter(call => call.method === 'POST' && call.path.endsWith('/relationships'))).toHaveLength(1);
  });

  it('opens the native ODM Model Canvas after a successful import', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /E-Commerce/ }));
    await screen.findByTestId('preview-screen');
    fireEvent.change(screen.getByTestId('storage-select'), { target: { value: 'storage-bigquery' } });
    await waitFor(() => expect(screen.getByTestId('import-button')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('import-button'));
    fireEvent.click(await screen.findByTestId('open-canvas'));

    await waitFor(() => expect(sdk.__mock.navigations).toContain('/ui/demo-project/data-marts/models'));
  });

  it('blocks an import that would duplicate a Data Mart title', async () => {
    vi.spyOn(sdk.__mock.owox.models, 'getDataMarts').mockResolvedValue({
      items: [{ id: 'existing-orders', title: 'Orders' }],
      total: 1,
      nextOffset: null,
    } as never);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /E-Commerce/ }));
    await screen.findByTestId('preview-screen');
    fireEvent.change(screen.getByTestId('storage-select'), { target: { value: 'storage-bigquery' } });

    expect(await screen.findByText(/Import blocked to prevent duplicates/)).toBeInTheDocument();
    expect(screen.getByTestId('import-button')).toBeDisabled();
  });

  it('fails closed when existing Data Marts cannot be checked', async () => {
    vi.spyOn(sdk.__mock.owox.models, 'getDataMarts').mockRejectedValue(new Error('Forbidden'));

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /E-Commerce/ }));
    await screen.findByTestId('preview-screen');
    fireEvent.change(screen.getByTestId('storage-select'), { target: { value: 'storage-bigquery' } });

    expect(await screen.findByText(/Could not check existing Data Marts: Forbidden/)).toBeInTheDocument();
    expect(screen.getByTestId('import-button')).toBeDisabled();
  });
});
