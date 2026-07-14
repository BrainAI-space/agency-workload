import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("responsive accessibility contract", () => {
  it("keeps visible focus, 44px targets, mobile navigation, and reduced-motion handling", async () => {
    const css = await readFile(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("min-height: 44px");
    expect(css).toContain(".mobile-nav");
    expect(css).toContain(".mobile-brief");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).not.toMatch(/background:\s*linear-gradient/);
  });

  it("contains no unsafe raw HTML rendering", async () => {
    const files = [
      "./app.tsx",
      "./pages/auth-pages.tsx",
      "./pages/admin-pages.tsx",
      "./pages/planner-pages.tsx",
    ];
    const source = (
      await Promise.all(files.map((file) => readFile(resolve(process.cwd(), "src", file), "utf8")))
    ).join("\n");
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toContain("localStorage.setItem");
  });
});
