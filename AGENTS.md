# AGENTS.md

Instructions for coding agents working in this repository.

## What this repository is

`Import Model` — an OWOX Data Marts plugin that imports public OKF bundles as draft Data Marts. It is a React + TypeScript + Vite single-page app served from GitHub Pages and loaded by the ODM host inside a sandboxed iframe.

The authoritative platform reference is the [OWOX plugin authoring guide](https://docs.owox.com/docs/plugins/authoring-guide/). Read it before changing the plugin manifest, the runtime contract, the build output, or the release process.

## Layout

| Path | Purpose |
| --- | --- |
| `plugin.json` | Plugin manifest. `delivery.url` must match the GitHub Pages URL. |
| `ui/App.tsx` | Import wizard: catalog → parse → storage → preview → import. |
| `ui/main.tsx`, `ui/index.html` | SPA entry point. |
| `ui/lib/plugin-runtime.ts` | Single `connect()` call from `@owox/plugin-sdk`, memoized. |
| `ui/lib/okf.ts`, `frontmatter.ts`, `okf-types.ts` | OKF bundle → `ModelGraph` parsing. No I/O. |
| `ui/lib/github.ts`, `bundles.ts` | Fetch public bundles from GitHub. Unauthenticated only. |
| `ui/lib/import-model.ts` | Creates Data Marts, schemas, and relationships via `ctx.owox`. |
| `ui/lib/field-type.ts` | Maps OKF field types to warehouse types. |
| `ui/sdk-mock.ts` | Local SDK stand-in, aliased over `@owox/plugin-sdk` in `vite dev` only. |
| `.github/workflows/deploy-pages.yml` | Typecheck, test, build, deploy to Pages on push to `main`. |

## Runtime constraints

The plugin runs in a protected iframe with an opaque origin. Do not introduce:

- `localStorage`, `sessionStorage`, cookies, IndexedDB, or service workers — none are available.
- cross-origin requests to hosts that do not return `Access-Control-Allow-Origin: *`.
- any credential, token, API key, or `.env` file. ODM access comes from the host via `ctx` only.

Requests through `ctx.owox` time out after 30 seconds, with at most 32 concurrent.

Styles are not inherited from the host. Keep CSS in `ui/tailwind.css` (compiled to `ui/styles.css` by `npm run build:css`) and honor `ctx.theme` for dark mode.

## Working rules

- Write commit messages, PR titles, PR descriptions, and code comments in English.
- Never commit `.DS_Store`, `node_modules/`, `dist/`, or anything matching `.env*`.
- Add or update tests alongside behavior changes. `ui/lib/*.test.ts` cover parsing and import; `ui/App.test.tsx` covers the wizard.
- Before proposing a change as done, run all four: `npm run typecheck`, `npm test`, `npm run build`, and confirm `dist/index.html` exists.
- Keep `ui/lib/*` free of React imports. Parsing and import logic stay independently testable.

## Build and release

```bash
npm ci
npm run typecheck
npm test
npm run build          # dist/, with vite base '/import-model/'
```

Releasing:

1. Merge to `main`. The Pages workflow deploys automatically.
2. Verify `https://owox.github.io/import-model/` loads without sign-in.
3. Create a published, non-prerelease GitHub Release tagged `MAJOR.MINOR.PATCH` (optional leading `v`). ODM reads the plugin version from that tag.

Changing `vite.config.ts`'s `base` or `build.outDir` breaks the deployed asset paths. If you change either, update `plugin.json` and this file together.
