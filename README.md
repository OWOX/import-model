# Import Model for OWOX Data Marts

An OWOX Data Marts plugin that imports public [Open Knowledge Format (OKF)](https://github.com/OWOX/models) bundles as real Data Marts.

The plugin:

1. Loads the verified catalog from `OWOX/models/bundles` or accepts a public GitHub bundle URL.
2. Parses Data Marts, fields, primary keys, and relationships in the browser.
3. Lets an editor choose an existing ODM Storage and previews the objects to create.
4. Creates draft Data Marts, descriptions, warehouse-specific schemas, and relationships through the ODM plugin API.
5. Opens the native ODM Model Canvas, which renders the newly created Data Marts and links from backend state.

## Credentials

The plugin has no credential settings and does not request or store a GitHub token, warehouse secret, or ODM API key.

- Public bundle files are fetched from `raw.githubusercontent.com` (with the unauthenticated GitHub Contents API used only when a bundle has no `index.md`).
- ODM calls go through `@owox/plugin-sdk`; the host supplies its existing short-lived plugin context.
- The user still needs normal ODM access to a Storage and permission to create Data Marts.

## Safety and current behavior

- Import is blocked when any Data Mart title from the bundle already exists in the selected Storage.
- Imported Data Marts stay in draft because OKF bundles describe conceptual schemas, not executable SQL definitions.
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

## Deployment

Pushes to `main` run `.github/workflows/deploy-pages.yml`, which typechecks, tests, builds, and publishes `dist/` to GitHub Pages at:

`https://owox.github.io/import-model/`

The same URL is declared as `delivery.url` in `plugin.json`, which ODM reads when installing the plugin. OWOX Data Marts derives plugin identity from this repository and the version from the latest eligible GitHub Release tag.

## Origin

The import functionality was originally developed inside [`OWOX/okf-export`](https://github.com/OWOX/okf-export) and released there as `v2.0.0`. This repository extracts it into a standalone plugin so that export and import ship and version independently.
