# Import Model for OWOX Data Marts

An OWOX Data Marts plugin that imports public [Open Knowledge Format (OKF)](https://github.com/OWOX/models) bundles as real Data Marts.

The plugin:

1. Loads the verified catalog from `OWOX/models/bundles` or accepts a public GitHub bundle URL.
2. Parses Data Marts, fields, primary keys, and relationships in the browser.
3. Lets an editor choose an existing ODM Storage and previews the objects to create.
4. Creates draft Data Marts, descriptions, warehouse-specific schemas, and relationships through the ODM plugin API.
5. Opens the native ODM Model Canvas, which renders the newly created Data Marts and links from backend state.
6. Adds each Data Mart's calculated fields once it has an input source (see below).

## Calculated fields

ODM accepts a formula only over columns it has read from the warehouse (`CONNECTED`), and a
column becomes connected only after the Data Mart has an input source. Imported Data Marts are
drafts without one, so their calculated fields cannot be saved during the import.

Instead the import stores each Data Mart's formulas in the plugin collection
`pendingCalculatedFields`, bound to that Data Mart. Formulas are converted to ODM's stored form
(`{{ref field="x"}}`, `{{ref path="alias.alias" field="x"}}`) at import time, using the
relationship aliases the bundle declares (`- [Purchases](./purchases.md) as \`purchases_e_commerce\``).

Whenever the plugin opens, its start screen lists the Data Marts whose calculated fields are still
waiting, grouped by the model they were imported from, with the import date and a short note on why
they wait. A published Data Mart with connected columns is **Ready to add** and gets an **Add**
button; the others are **Waiting for publishing** (or name the columns still not connected) and get
**Open Data Mart**. ODM refusals are kept per field with ODM's own reason. The section collapses, and
**Discard all waiting fields** deletes every saved formula when the member no longer wants them.

## Credentials

The plugin has no credential settings and does not request or store a GitHub token, warehouse secret, or ODM API key.

- Public bundle files are fetched from `raw.githubusercontent.com` (with the unauthenticated GitHub Contents API used only when a bundle has no `index.md`).
- ODM calls go through `@owox/plugin-sdk`; the host supplies its existing short-lived plugin context.
- The user still needs normal ODM access to a Storage and permission to create Data Marts.

## Safety and current behavior

- Import is blocked when any Data Mart title from the bundle already exists in the selected Storage.
- Imported Data Marts stay in draft because OKF bundles describe conceptual schemas, not executable SQL definitions.
- Adding calculated fields sends the Data Mart's live schema back unchanged, with the formulas appended.
- The import is not transactional. A failed API request is reported with the affected object; successfully created objects remain in ODM.
- Model Canvas positions are not imported. ODM computes its native layout from the created Data Marts and relationships.
- Only public GitHub bundles are accepted, with a maximum of 100 Markdown files per bundle.

## Develop

```bash
npm install
npm run dev        # Vite dev server against the local SDK mock
npm run typecheck
npm test
npm run build      # writes the remote plugin to dist/
```

Development uses the local SDK mock in `ui/sdk-mock.ts`. Production builds bundle the real `@owox/plugin-sdk`.
The mock keeps ODM's field-status rule. To walk the calculated-fields flow locally, import a bundle,
then run `__importModelMock.connectMarts()` in the browser console to give every Data Mart an input
source and publish it, and press the refresh icon on the start screen.

## Deployment

Pushes to `main` run `.github/workflows/deploy-pages.yml`, which typechecks, tests, builds, and publishes `dist/` to GitHub Pages at:

`https://owox.github.io/import-model/`

The same URL is declared as `delivery.url` in `plugin.json`, which ODM reads when installing the plugin. OWOX Data Marts derives plugin identity from this repository and the version from the latest eligible GitHub Release tag.

## Origin

The import functionality was originally developed inside [`OWOX/okf-export`](https://github.com/OWOX/okf-export) and released there as `v2.0.0`. This repository extracts it into a standalone plugin so that export and import ship and version independently.
