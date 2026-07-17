import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { CollapsibleText } from "../extensions/shared/rendering/collapsible-text.ts";

const theme = {
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
};

function createText(): CollapsibleText {
  return new CollapsibleText({
    collapsedRows: 3,
    theme,
    keybindings: { getKeys: () => ["alt+e"] },
  });
}

describe("CollapsibleText", () => {
  it("limits collapsed content and adds a native-style hint line", () => {
    const text = createText();
    text.setText("word ".repeat(40));

    const rows = text.render(20);

    expect(rows.length).toBeGreaterThan(3);
    expect(rows.slice(0, 3).every((row) => visibleWidth(row) === 20)).toBe(true);
    const hint = rows
      .slice(3)
      .map((row) => row.trim())
      .join(" ");
    expect(hint).toContain("alt+e to expand)");
    expect(hint).not.toContain("...");
  });

  it("recomputes wrapping and remaining-line counts from the current width", () => {
    const text = createText();
    text.setText("word ".repeat(12));

    expect(text.render(40)).toHaveLength(2);
    const narrowRows = text.render(12);
    const hint = narrowRows
      .slice(3)
      .map((row) => row.trim())
      .join(" ");
    expect(hint).toContain("more lines");
    expect(hint).toContain("alt+e to");
  });

  it("renders all wrapped rows without a hint when expanded", () => {
    const text = createText();
    text.setText("word ".repeat(40));
    text.setExpanded(true);

    const rows = text.render(20);
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.join(" ")).not.toContain("to expand)");
  });
});
