import type { HarDocument } from "@hark/har/model";
import { redactHar } from "@hark/har/redact";
import { describe, expect, it } from "vite-plus/test";
import { runFake } from "./fake-ports.ts";
import { ROWS as MARKED } from "./marker-rows.ts";
import { importAltered } from "./alter.ts";

/** The marker rows, and two requests with nothing a level would remove, so a per-entry count can tell them apart. */
const ROWS = [
  ...MARKED,
  {
    id: 40,
    url: "https://plain.example/a",
    recording: { body: { kind: "bytes", data: new TextEncoder().encode("ok") } },
  },
  { id: 41, url: "https://plain.example/b", devtools: {} },
] as const;

// The reference is @hark/har's own whole-document redaction: the export streams entry by entry, but what it
// writes at a level must be what redactHar makes of the same export written with nothing redacted.

type Doc = { log: Record<string, unknown> & { _harExport?: Record<string, unknown> } };

/** The export's own report differs between two runs (file size, level), so it is compared separately. */
function withoutExportReport(doc: Doc): Doc {
  const { report: _report, ...rest } = doc.log._harExport ?? {};
  return { log: { ...doc.log, _harExport: rest } };
}

describe("redaction is har's, applied last", () => {
  for (const level of ["standard", "shareable"] as const) {
    it(`an export at ${level} equals redactHar(${level}) of the same export written with none`, async () => {
      const plain = await runFake({ rows: ROWS, redaction: "none" });
      const redacted = await runFake({ rows: ROWS, redaction: level });
      const expected = redactHar(JSON.parse(plain.text) as HarDocument, { level });
      const got = JSON.parse(redacted.text) as Doc;
      expect(withoutExportReport(got)).toEqual(
        withoutExportReport(expected.document as unknown as Doc),
      );
      expect(redacted.report!.redaction.report).toEqual(expected.report);
      expect(got.log._harExport?.["redaction"]).toEqual(expected.report);
    });
  }

  it("with none, nothing is redacted and the file carries no redaction report", async () => {
    const plain = await runFake({ rows: ROWS, redaction: "none" });
    const doc = JSON.parse(plain.text) as Doc;
    expect(doc.log._harExport?.["redaction"]).toBeUndefined();
    expect(plain.report!.redaction).toEqual({ choice: "none", report: null });
  });

  it("with entries redacted before their comment and _harExport are added, the file differs from redactHar's", async () => {
    const altered = await importAltered<typeof import("../src/run.ts")>("run.ts", {
      id: "redact-entry-early",
      from: "  return JSON.stringify(redaction.entry(entry, ctx.index));",
      to: "  return JSON.stringify({ ...redaction.entry({ ...entry, comment: undefined, _harExport: undefined }, ctx.index), comment: entry.comment, _harExport: entry._harExport });",
    });
    const plain = await runFake({ rows: ROWS, redaction: "none" });
    const redacted = await runFake({
      rows: ROWS,
      redaction: "shareable",
      runExport: altered.runExport,
    });
    const expected = redactHar(JSON.parse(plain.text) as HarDocument, { level: "shareable" });
    expect(withoutExportReport(JSON.parse(redacted.text) as Doc)).not.toEqual(
      withoutExportReport(expected.document as unknown as Doc),
    );
  });
});
