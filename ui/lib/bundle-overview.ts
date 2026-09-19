// What a bundle's index.md says about the model as a whole, as opposed to what its
// mart files say about individual tables: the paragraph explaining what the model is
// for, the questions it was built to answer, and a rendered picture of the graph.
//
// The file is already part of the fetched bundle (github.ts keeps it under "index.md"),
// so the Review screen reads it from the same map instead of a second round trip.

import { firstImageSrc } from "./bundles";
import { parseFrontmatter } from "./frontmatter";

export interface BundleOverview {
  /** Frontmatter `description`, rewrapped into paragraphs. */
  description?: string;
  /** Bullets under the `Example Questions` heading, in bundle order. */
  exampleQuestions: string[];
  /** First image in the body, when it is an https URL we can render. */
  imageUrl?: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const EXAMPLE_QUESTIONS_RE = /^example\s+questions?$/i;
const BULLET_RE = /^[-*]\s+(.+)$/;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/;

/**
 * Read the overview out of a bundle index. Returns null when the file is missing or
 * carries none of the three parts — every part is optional on its own, so a bundle
 * with only a description still renders.
 *
 * `baseUrl` is the bundle folder as a raw URL with a trailing slash (see
 * `rawDirBase`). Bundles that keep their diagram in the repo link it relatively
 * (`![](../res/screens/retail-chain.svg)`), so without a base there is nothing to
 * resolve against and only absolute images render.
 */
export function parseBundleOverview(
  indexMd: string | null | undefined,
  baseUrl?: string,
): BundleOverview | null {
  if (!indexMd) return null;
  const { data, body } = parseFrontmatter(indexMd);
  const description = toParagraphs(typeof data.description === "string" ? data.description : "");
  const exampleQuestions = parseExampleQuestions(body);
  const imageUrl = firstImage(body, baseUrl);

  if (!description && exampleQuestions.length === 0 && !imageUrl) return null;
  const overview: BundleOverview = { exampleQuestions };
  if (description) overview.description = description;
  if (imageUrl) overview.imageUrl = imageUrl;
  return overview;
}

/**
 * Bullets under `# Example Questions`, ending at the next heading of the same or a
 * shallower level (`# Explore this model` in the generated bundles). A line that is not
 * a bullet continues the previous one, so a question wrapped across source lines stays
 * one question.
 */
function parseExampleQuestions(body: string): string[] {
  const questions: string[] = [];
  let inside = false;
  let level = 0;
  for (const line of body.split("\n")) {
    const heading = HEADING_RE.exec(line.trim());
    if (heading) {
      if (inside && heading[1].length <= level) break;
      if (!inside && EXAMPLE_QUESTIONS_RE.test(heading[2].trim())) {
        inside = true;
        level = heading[1].length;
      }
      continue;
    }
    if (!inside) continue;
    const text = line.trim();
    if (!text) continue;
    const bullet = BULLET_RE.exec(text);
    if (bullet) {
      questions.push(stripInlineMarkup(bullet[1]));
      continue;
    }
    if (questions.length > 0) {
      questions[questions.length - 1] = `${questions[questions.length - 1]} ${stripInlineMarkup(text)}`.trim();
    }
  }
  return questions.filter(Boolean);
}

/**
 * Markup we do not render, removed. Backticks survive: the caller turns them into code
 * spans, which is how a question names a field without it reading as prose.
 */
function stripInlineMarkup(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A YAML block scalar keeps the source's hard wrapping, which would render as ragged
 * lines. Blank lines separate paragraphs; every other newline is just wrapping.
 */
function toParagraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map(paragraph =>
      paragraph
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean)
    .join("\n\n");
}

/** First `<img src>` or `![](…)` in the body, as an https URL. A relative path is
 *  resolved against the bundle folder, which is where GitHub's own rendering resolves
 *  it too; anything that does not end up https is dropped, because the page cannot
 *  load it from its opaque origin. */
function firstImage(body: string, baseUrl?: string): string | undefined {
  const candidate = (firstImageSrc(body) ?? MARKDOWN_IMAGE_RE.exec(body)?.[1])?.trim();
  if (!candidate) return undefined;
  if (/^https:\/\//i.test(candidate)) return candidate;
  if (!baseUrl || /^[a-z][a-z0-9+.-]*:/i.test(candidate)) return undefined;
  let resolved: URL;
  try {
    resolved = new URL(candidate, baseUrl);
  } catch {
    return undefined;
  }
  return resolved.protocol === "https:" ? resolved.href : undefined;
}
