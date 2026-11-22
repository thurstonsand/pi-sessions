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
    const layout = new ExpandableContentLayout(theme, () => "ctrl+o");
    layout.update(presentation, false);

    const rendered = layout.render(20).join("\n");

    expect(rendered).toContain("header");
    expect(rendered).toContain("always visible");
    expect(rendered).not.toContain("expanded detail");
    expect(rendered).toContain("more lines");
    expect(rendered).not.toContain("...");
  });

  it("includes hidden metadata in collapsed line counts", () => {
    const layout = new ExpandableContentLayout(theme, () => "ctrl+o");
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
    const layout = new ExpandableContentLayout(theme, () => "ctrl+o");
    layout.update(presentation, true);

    const rendered = layout.render(20).join("\n");

    expect(rendered).toContain("expanded detail");
    expect(rendered.split("\n").length).toBeGreaterThan(6);
    expect(rendered).not.toContain("more lines");
  });

  it("re-renders a reused layout when its content, expansion, width, or theme changes", () => {
    let mark = "~";
    const switchableTheme = { ...theme, fg: (_token: string, text: string) => `${mark}${text}` };
    const layout = new ExpandableContentLayout(switchableTheme, () => "ctrl+o");
    const body = (text: string) => ({ header: "header", body: { text, collapsedRows: 1 } });
    const visible = (width: number) => layout.render(width).map((line) => line.trimEnd());
    const long = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";

    layout.update(body("alpha beta gamma"), false);
    expect(visible(80)).toEqual(["header", "", "alpha beta gamma"]);
    expect(visible(80)).toEqual(["header", "", "alpha beta gamma"]);

    layout.update(body(long), false);
    expect(visible(80)).toEqual(["header", "", long]);

    expect(visible(50)).toEqual([
      "header",
      "",
      "alpha beta gamma delta epsilon zeta eta theta iota",
      "~(1 more line, 2 total, ~ctrl+o~ to expand)",
    ]);

    layout.update(body(long), true);
    expect(visible(50)).toEqual([
      "header",
      "",
      "alpha beta gamma delta epsilon zeta eta theta iota",
      "kappa lambda mu",
    ]);

    layout.update(body(long), false);
    expect(visible(50)).toContain("~(1 more line, 2 total, ~ctrl+o~ to expand)");
    mark = "#";
    layout.invalidate();
    expect(visible(50)).toContain("#(1 more line, 2 total, #ctrl+o# to expand)");
  });

  it("can be reused with a replacement presentation", () => {
    const layout = new ExpandableContentLayout(theme, () => "ctrl+o");
    layout.update(presentation, false);
    layout.update({ header: "replacement" }, false);

    expect(layout.render(20).join("\n")).toContain("replacement");
    expect(layout.render(20).join("\n")).not.toContain("always visible");
  });
});
