// The verified gallery is auto-discovered: the OWOX/models repo publishes a
// top-level bundles/index.md that links to each bundle's own index.md. We fetch
// that one file on dialog open and parse the rows — so new OWOX bundles appear
// in the gallery with no app code change. Heavy per-bundle content (mart files,
// graph, image) is fetched lazily on row expand (see TemplateGallery).

export const VERIFIED_BUNDLES_INDEX_URL =
  "https://raw.githubusercontent.com/OWOX/models/main/bundles/index.md";

/** "model" is an industry data model; "source" is what one OWOX connector loads. */
export type BundleKind = "model" | "source";

export interface VerifiedBundle {
  title: string;
  /** Path under bundles/, without slashes at either end: "e-commerce", "sources/stripe". */
  folder: string;
  martCount: number | null;
  kind: BundleKind;
}

/** Parse the top-level bundles/index.md. Each bundle is a markdown list link to
 *  a sub-folder index (`[Title](./folder/index.md) — N concept(s)`); the folder may
 *  be nested (`./sources/stripe/index.md`). Links under a "Data sources" heading
 *  are connector source models, the rest are industry models. External (http)
 *  links and links that climb out of bundles/ are skipped; the count is optional. */
export function parseBundlesIndex(md: string): VerifiedBundle[] {
  const link = /\[([^\]]+)\]\(\s*\.\/([^)\s]+?)\/index\.md\s*\)(?:[^\n]*?(\d+)\s*concept)?/gi;
  const out: VerifiedBundle[] = [];
  let kind: BundleKind = "model";
  for (const line of md.split("\n")) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      kind = /^data sources$/i.test(heading[1]) ? "source" : "model";
      continue;
    }
    link.lastIndex = 0;
    for (let m = link.exec(line); m; m = link.exec(line)) {
      const folder = m[2].trim();
      if (folder.split("/").includes("..")) continue;
      out.push({ title: m[1].trim(), folder, martCount: m[3] ? Number(m[3]) : null, kind });
    }
  }
  return out;
}

/** First `<img src="...">` in a markdown/HTML body (bundle index images are
 *  appended as a raw <img> tag pointing at github.com/user-attachments). */
export function firstImageSrc(md: string): string | null {
  const m = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(md);
  return m ? m[1] : null;
}

/** GitHub tree URL for a verified bundle folder — the deeplink / import target. */
export function bundleGithubUrl(folder: string): string {
  return `https://github.com/OWOX/models/tree/main/bundles/${folder}`;
}

/** Fetch + parse the verified bundle list. Throws on network / non-OK. */
export async function fetchVerifiedBundleList(
  opts: { signal?: AbortSignal } = {},
): Promise<VerifiedBundle[]> {
  const res = await fetch(VERIFIED_BUNDLES_INDEX_URL, { signal: opts.signal });
  if (!res.ok) throw new Error(`Couldn't load the verified gallery (GitHub returned ${res.status}).`);
  return parseBundlesIndex(await res.text());
}
