import { describe, expect, it } from "vitest";
import { ExpandableContentLayout } from "../extensions/shared/rendering/expandable-content-layout.ts";

const theme = {
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
};

const presentation = {
  header: "header",
  metadata: ["always visible"],
  expandedMetadata: ["expanded detail"],
  body: {
    text: "word ".repeat(40),
    collapsedRows: 3,
  },
};

describe("ExpandableContentLayout", () => {
  it("lays out compact metadata and collapsed body content", () => {
    const layout = new ExpandableContentLayout(theme);
    layout.update(presentation, false);

    const rendered = layout.render(20).join("\n");

    expect(rendered).toContain("header");
    expect(rendered).toContain("always visible");
    expect(rendered).not.toContain("expanded detail");
    expect(rendered).toContain("more lines");
    expect(rendered).not.toContain("...");
  });

  it("includes hidden metadata in collapsed line counts", () => {
    const layout = new ExpandableContentLayout(theme);
    layout.update(
      {
        header: "header",
        metadata: ["model"],
        expandedMetadata: ["session", "cwd"],
        body: {
          text: "goal row one\ngoal row two",
          collapsedRows: 1,
          spacingBefore: 0,
        },
      },
      false,
    );

    expect(layout.render(80).join("\n")).toContain("3 more lines, 5 total");
  });

  it("adds expanded metadata and the complete body", () => {
    const layout = new ExpandableContentLayout(theme);
    layout.update(presentation, true);

    const rendered = layout.render(20).join("\n");

    expect(rendered).toContain("expanded detail");
    expect(rendered.split("\n").length).toBeGreaterThan(6);
    expect(rendered).not.toContain("more lines");
  });

  it("can be reused with a replacement presentation", () => {
    const layout = new ExpandableContentLayout(theme);
    layout.update(presentation, false);
    layout.update({ header: "replacement" }, false);

    expect(layout.render(20).join("\n")).toContain("replacement");
    expect(layout.render(20).join("\n")).not.toContain("always visible");
  });
});
