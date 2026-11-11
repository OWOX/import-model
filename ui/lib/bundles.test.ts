import { describe, expect, it } from 'vitest';
import { bundleGithubUrl, parseBundlesIndex } from './bundles';

// Shaped after OWOX/models bundles/index.md as of 2026-11: industry models first, then a
// "Data sources" section whose bundles live one folder deeper, under sources/.
const INDEX = `---
title: "OKF Bundles"
type: "index"
---

# OKF Bundles

- [E-Commerce](./e-commerce/index.md) — 12 concept(s)
- [SEO](./seo/index.md) — 18 concept(s)

## Data sources

- [Facebook Ads](./sources/facebook-ads/index.md) — 15 concept(s)
- [Stripe](./sources/stripe/index.md) — 14 concept(s)
`;

describe('parseBundlesIndex', () => {
  it('reads industry models and, under "Data sources", nested source models', () => {
    expect(parseBundlesIndex(INDEX)).toEqual([
      { title: 'E-Commerce', folder: 'e-commerce', martCount: 12, kind: 'model' },
      { title: 'SEO', folder: 'seo', martCount: 18, kind: 'model' },
      { title: 'Facebook Ads', folder: 'sources/facebook-ads', martCount: 15, kind: 'source' },
      { title: 'Stripe', folder: 'sources/stripe', martCount: 14, kind: 'source' },
    ]);
  });

  it('goes back to industry models under any later heading', () => {
    const md = `## Data sources\n- [Stripe](./sources/stripe/index.md)\n## More models\n- [SaaS](./saas/index.md)`;
    expect(parseBundlesIndex(md).map(b => [b.folder, b.kind])).toEqual([
      ['sources/stripe', 'source'],
      ['saas', 'model'],
    ]);
  });

  it('skips links that climb out of bundles/ and external links', () => {
    const md = `- [Up](./../secrets/index.md)\n- [Far](https://example.com/x/index.md)\n- [Ok](./ok/index.md)`;
    expect(parseBundlesIndex(md).map(b => b.folder)).toEqual(['ok']);
  });

  it('keeps the count optional', () => {
    expect(parseBundlesIndex('- [Bare](./bare/index.md)')[0].martCount).toBeNull();
  });
});

describe('bundleGithubUrl', () => {
  it('builds a tree URL for a nested source folder', () => {
    expect(bundleGithubUrl('sources/stripe')).toBe('https://github.com/OWOX/models/tree/main/bundles/sources/stripe');
  });
});
