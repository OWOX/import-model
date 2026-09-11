import { describe, expect, it } from "vitest";
import { parseBundleOverview } from "./bundle-overview";

const SAAS_INDEX = `---
title: "SaaS"
description: |
  A B2B subscription software business modeled end to end — from the marketing that brings
  accounts in, through trials, subscriptions and seat expansion, to the product usage,
  support experience and billing that decide whether they stay.
tags: ["owox", "index"]
type: "index"
---

<!-- OWOX:GENERATED:START -->

**Authors:** [Vlad Flaks](https://github.com/vladflaks)

| Data Mart | Fields |
|-----------|--------|
| [Account](./account.md) | 12 |

# Example Questions

- What is net revenue retention, and how much of it is expansion?
- Do \`accounts\` with deeper \`product usage\` expand more and churn less?

# Explore this model

**[▶ Explore on canvas](https://model.owox.com/?okf=x)**

<!-- OWOX:GENERATED:END -->

<img width="2547" height="1324" alt="saas" src="https://github.com/user-attachments/assets/8156374b.png" />
`;

describe("parseBundleOverview", () => {
  it("reads the description, the example questions, and the diagram", () => {
    const overview = parseBundleOverview(SAAS_INDEX);

    expect(overview?.description).toBe(
      "A B2B subscription software business modeled end to end — from the marketing that brings " +
        "accounts in, through trials, subscriptions and seat expansion, to the product usage, " +
        "support experience and billing that decide whether they stay.",
    );
    expect(overview?.exampleQuestions).toEqual([
      "What is net revenue retention, and how much of it is expansion?",
      "Do `accounts` with deeper `product usage` expand more and churn less?",
    ]);
    expect(overview?.imageUrl).toBe("https://github.com/user-attachments/assets/8156374b.png");
  });

  it("stops the question list at the next heading of the same level", () => {
    const overview = parseBundleOverview(SAAS_INDEX);
    expect(overview?.exampleQuestions.some(q => q.includes("Explore"))).toBe(false);
  });

  it("keeps blank-line paragraph breaks and drops source wrapping", () => {
    const overview = parseBundleOverview(`---
description: |
  First paragraph, wrapped
  across two source lines.

  Second paragraph.
---
`);
    expect(overview?.description).toBe("First paragraph, wrapped across two source lines.\n\nSecond paragraph.");
  });

  it("returns what it has when parts are missing", () => {
    const descriptionOnly = parseBundleOverview(`---
description: "Just a description."
---
# Data Marts
`);
    expect(descriptionOnly).toEqual({ description: "Just a description.", exampleQuestions: [] });

    const questionsOnly = parseBundleOverview(`---
title: "No description"
---
## Example Question
- Only one question here?
`);
    expect(questionsOnly).toEqual({ exampleQuestions: ["Only one question here?"] });
  });

  it("joins a question wrapped across source lines", () => {
    const overview = parseBundleOverview(`---
title: "Wrapped"
---
# Example Questions

- Which channels pay back their cost fastest once you account
  for the revenue those accounts retain?
`);
    expect(overview?.exampleQuestions).toEqual([
      "Which channels pay back their cost fastest once you account for the revenue those accounts retain?",
    ]);
  });

  it("renders link text without the link, and keeps backticks for code spans", () => {
    const overview = parseBundleOverview(`---
title: "Links"
---
# Example Questions
- How do [sessions](./sessions.md) convert, and which **\`products\`** win?
`);
    expect(overview?.exampleQuestions).toEqual([
      "How do sessions convert, and which `products` win?",
    ]);
  });

  it("ignores an image that is not https", () => {
    const overview = parseBundleOverview(`---
description: "Has a relative image."
---
![diagram](./diagram.png)
`);
    expect(overview?.imageUrl).toBeUndefined();
  });

  it("accepts a markdown image when there is no img tag", () => {
    const overview = parseBundleOverview(`---
title: "Markdown image"
---
![diagram](https://example.com/diagram.png)
`);
    expect(overview?.imageUrl).toBe("https://example.com/diagram.png");
  });

  it("returns null when there is nothing to show", () => {
    expect(parseBundleOverview(undefined)).toBeNull();
    expect(parseBundleOverview("")).toBeNull();
    expect(parseBundleOverview(`---\ntitle: "Empty"\n---\n# Data Marts\n| A | B |\n`)).toBeNull();
  });
});
