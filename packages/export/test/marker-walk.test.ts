import type { HarLogRedactionExtension, HarRedactionPlace, RedactionLevel } from "@hark/har/model";
import { HAR_MODEL_FIELD_TABLE } from "@hark/har/redact";
import { describe, expect, it } from "vite-plus/test";
import { runFake, type FakeEnv } from "./fake-ports.ts";
import { ROWS, markers } from "./marker-rows.ts";

// The har package's marker walk, run over this package's output: a unique marker in every string the two sources
// can hand the export, each tagged with the redaction place it is placed in. After an export at a level, every
// marker still in the file must sit in a place the file's own har report says that level keeps.

type Field = string;
const TABLE = HAR_MODEL_FIELD_TABLE as Readonly<
  Record<
    string,
    {
      readonly places: readonly HarRedactionPlace[];
      readonly kinds: readonly string[];
      readonly children?: string | undefined;
    }
  >
>;

/** A JSON path in the file as the har model's field name, the way HAR_MODEL_FIELD_TABLE names it. */
function fieldOf(path: readonly (string | number)[]): Field {
  let current = "log";
  for (const step of path.slice(1)) {
    const row = TABLE[current];
    if (typeof step === "number") {
      current =
        row?.children !== undefined && row.kinds.includes("array") ? row.children : `${current}[]`;
      continue;
    }
    const next = `${current}.${step}`;
    const nextRow = TABLE[next];
    if (nextRow === undefined) return `${current}.<custom>`;
    current =
      nextRow.children !== undefined && !nextRow.kinds.includes("array") ? nextRow.children : next;
  }
  return current;
}

interface Occurrence {
  readonly marker: string;
  readonly field: Field;
}

function occurrences(document: unknown): Occurrence[] {
  const found: Occurrence[] = [];
  const visit = (
    value: unknown,
    path: (string | number)[],
    parent: Record<string, unknown> | null,
  ): void => {
    if (typeof value === "string") {
      let text = value;
      if (path.at(-1) === "text" && parent?.["encoding"] === "base64") {
        text = Buffer.from(value, "base64").toString("latin1");
      }
      for (const match of text.matchAll(/MKR\d{3}X/gu))
        found.push({ marker: match[0], field: fieldOf(path) });
      return;
    }
    if (Array.isArray(value)) value.forEach((item, i) => visit(item, [...path, i], null));
    else if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value))
        visit(child, [...path, key], value as Record<string, unknown>);
    }
  };
  visit(document, ["log"], null);
  return found;
}

/** Where a URL's parts land when a builder derives another field from the URL. */
const DERIVED_PLACE: Readonly<Partial<Record<HarRedactionPlace, HarRedactionPlace>>> = {
  "request-url-query": "query-string",
  "request-url-query-secret": "query-string-secret",
};

const PAGE_TITLE_PLACES: ReadonlySet<HarRedactionPlace> = new Set([
  "request-url-userinfo",
  "request-url-query-secret",
]);

/** The place an occurrence is in: the marker's own place when the field has it, else the one the field's table row gives. */
function placeOf(
  occurrence: Occurrence,
  report: HarLogRedactionExtension,
): HarRedactionPlace | null {
  const ownPlace = markers.find((p) => p.marker === occurrence.marker)!.place;
  // Every marker is a string in a string field, so the field's wrong-type place never applies to it.
  const places: readonly HarRedactionPlace[] = (TABLE[occurrence.field]?.places ?? []).filter(
    (p) => p !== "wrong-type",
  );
  if (places.includes(ownPlace)) return ownPlace;
  const derived = DERIVED_PLACE[ownPlace];
  if (derived !== undefined && places.includes(derived)) return derived;
  if (occurrence.field === "log.pages[].title") {
    return PAGE_TITLE_PLACES.has(ownPlace) ? ownPlace : "page-title";
  }
  const statuses = new Set(places.map((p) => report.places.find((c) => c.place === p)?.status));
  return places.length > 0 && statuses.size === 1 ? places[0]! : null;
}

function violations(text: string, report: HarLogRedactionExtension): string[] {
  const document = JSON.parse(text) as { log: unknown };
  const out: string[] = [];
  for (const occurrence of occurrences(document.log)) {
    const place = placeOf(occurrence, report);
    const status =
      place === null ? undefined : report.places.find((c) => c.place === place)?.status;
    if (status === undefined || status === "removed") {
      const origin = markers.find((p) => p.marker === occurrence.marker)!.place;
      out.push(
        `${occurrence.marker} from ${origin} in ${occurrence.field} (${String(place)}: ${String(status)})`,
      );
    }
  }
  return out;
}

const PATHS: readonly { readonly name: string; readonly env: Partial<FakeEnv> }[] = [
  { name: "complete", env: {} },
  { name: "recording list throws", env: { listThrows: "recording" } },
  { name: "devtools list throws", env: { listThrows: "devtools" } },
  { name: "bodies left out", env: { bodies: "omit" } },
];

describe("marker walk over the export's output", () => {
  it("the sources' markers reach the file when nothing is redacted, in every place they were placed", async () => {
    const result = await runFake({ rows: ROWS, redaction: "none" });
    expect(result.error).toBeNull();
    const present = new Set(
      occurrences((JSON.parse(result.text) as { log: unknown }).log).map((o) => o.marker),
    );
    const placesSeen = new Set(markers.filter((p) => present.has(p.marker)).map((p) => p.place));
    expect([...new Set(markers.map((p) => p.place))].filter((p) => !placesSeen.has(p))).toEqual([]);
  });

  for (const level of ["standard", "shareable"] as const satisfies readonly RedactionLevel[]) {
    for (const path of PATHS) {
      it(`${level}, ${path.name}: every marker left is in a place the har report keeps`, async () => {
        const result = await runFake({ rows: ROWS, redaction: level, ...path.env });
        expect(result.error).toBeNull();
        expect(violations(result.text, result.report!.redaction.report!)).toEqual([]);
      });
    }

    it(`${level}, cancelled at every await point: what was written is a prefix of the checked file`, async () => {
      const complete = await runFake({ rows: ROWS, redaction: level });
      for (let at = 1; at <= complete.points; at += 1) {
        const signal = { aborted: false };
        const cancelled = await runFake({
          rows: ROWS,
          redaction: level,
          signal,
          onPoint: (n) => {
            if (n === at) signal.aborted = true;
          },
        });
        if (cancelled.error === null) continue;
        expect((cancelled.error as Error).name, `point ${String(at)}`).toBe("AbortError");
        expect(complete.text.startsWith(cancelled.text), `point ${String(at)}`).toBe(true);
      }
    });
  }

  it("an unredacted file checked against the standard report flags its credential markers", async () => {
    const result = await runFake({ rows: ROWS, redaction: "none" });
    const standard = (await runFake({ rows: ROWS, redaction: "standard" })).report!.redaction
      .report!;
    const found = violations(result.text, standard);
    expect(found.some((v) => v.includes("header-value-secret"))).toBe(true);
    expect(found.some((v) => v.includes("request-url-query-secret"))).toBe(true);
    expect(found.some((v) => v.includes("cookie"))).toBe(true);
  });
});
