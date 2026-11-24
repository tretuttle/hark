import { describe, expect, it } from "vite-plus/test";
import { contrastRatio, copyProblems, parseColor, sizeProblems } from "./popup-audit.ts";

const EM_DASH = String.fromCodePoint(0x2014);
const EN_DASH = String.fromCodePoint(0x2013);

const hex = (h: string) => ({
  r: Number.parseInt(h.slice(1, 3), 16),
  g: Number.parseInt(h.slice(3, 5), 16),
  b: Number.parseInt(h.slice(5, 7), 16),
  a: 1,
});

describe("popup audit rules", () => {
  it("computes contrast as WCAG 2.1 defines it and fails a 3.1:1 pair", () => {
    expect(contrastRatio(hex("#000000"), hex("#FFFFFF"))).toBeCloseTo(21, 2);
    expect(contrastRatio(hex("#777777"), hex("#FFFFFF"))).toBeCloseTo(4.48, 2);
    expect(contrastRatio(hex("#767676"), hex("#FFFFFF"))).toBeCloseTo(4.54, 2);
    expect(contrastRatio(hex("#8A93A3"), hex("#FFFFFF"))).toBeLessThan(4.5);
  });

  it("reads computed colours with and without alpha", () => {
    expect(parseColor("rgb(31, 91, 208)")).toEqual({ r: 31, g: 91, b: 208, a: 1 });
    expect(parseColor("rgba(0, 0, 0, 0)")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("finds dashes and emoji, and passes plain copy", () => {
    expect(copyProblems("Saved. Show in folder")).toEqual([]);
    expect(copyProblems(`Saved ${EM_DASH} done`)).toHaveLength(1);
    expect(copyProblems(`Saved ${EN_DASH} done`)).toHaveLength(1);
    expect(copyProblems("Saved \u{1F600}")).toHaveLength(1);
  });

  it("holds the popup to 400 by 600, counting content that scrolls", () => {
    expect(sizeProblems({ width: 380, height: 520, scrollWidth: 380, scrollHeight: 520 })).toEqual(
      [],
    );
    expect(
      sizeProblems({ width: 420, height: 520, scrollWidth: 420, scrollHeight: 520 }),
    ).toHaveLength(1);
    expect(
      sizeProblems({ width: 380, height: 600, scrollWidth: 380, scrollHeight: 640 }),
    ).toHaveLength(1);
  });
});
