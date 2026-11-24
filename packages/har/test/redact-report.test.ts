import { describe, expect, it } from "vite-plus/test";

import firefoxHar from "./fixtures/firefox.json" with { type: "json" };
import specHar from "./fixtures/spec.json" with { type: "json" };
import { buildMarkerDocument, markerPresent } from "./marker-document.ts";
import {
  REDACTION_LEVELS,
  type HarDocument,
  type HarLogRedactionExtension,
  type HarPlaceCoverage,
  type PlaceExamStatus,
} from "../src/model.ts";
import { parseHar } from "../src/parse.ts";
import {
  HAR_MODEL_FIELD_TABLE,
  HAR_PLACE_TABLE,
  PLACE_SEPARATOR,
  redactHar,
  redactHarEntry,
  redactUrl,
  type RedactHarOptions,
} from "../src/redact.ts";

const CLAUSE_STATUS: Readonly<Record<string, PlaceExamStatus>> = {
  Removes: "removed",
  "Keeps by allowlist": "kept-by-allowlist",
  "Keeps without examining": "kept-not-examined",
};

interface Claim {
  readonly status: PlaceExamStatus;
  readonly label: string;
  readonly fields: readonly string[];
}

function claimsIn(guarantee: string): readonly Claim[] {
  const claims: Claim[] = [];
  for (const match of guarantee.matchAll(
    /(Removes|Keeps by allowlist|Keeps without examining): (.+?\))\.(?= |$)/gu,
  )) {
    const status = CLAUSE_STATUS[match[1]!]!;
    for (const item of match[2]!.split(PLACE_SEPARATOR)) {
      const open = item.lastIndexOf(" (");
      claims.push({
        status,
        label: item.slice(0, open),
        fields: item.slice(open + 2, -1).split(", "),
      });
    }
  }
  return claims;
}

function placeFor(report: HarLogRedactionExtension, claim: Claim): HarPlaceCoverage | undefined {
  return report.places.find(
    (place) => place.label === claim.label && place.fields.join() === claim.fields.join(),
  );
}

function entry(extra: Record<string, unknown> = {}, request: Record<string, unknown> = {}) {
  return {
    startedDateTime: "2026-11-16T09:00:00.000Z",
    time: 1,
    request: {
      method: "GET",
      url: "https://a.example/",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: -1,
      ...request,
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      content: { size: 0, mimeType: "text/plain" },
      redirectURL: "",
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
    ...extra,
  };
}

function documentOf(entries: readonly unknown[], log: Record<string, unknown> = {}): HarDocument {
  return {
    log: { version: "1.2", creator: { name: "c", version: "1" }, entries, ...log },
  } as unknown as HarDocument;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// The redaction adds its report at log._harExport.redaction and nothing else when nothing is removed.
function withoutReport(document: HarDocument, input: HarDocument): string {
  const copy = clone(document) as { log: Record<string, unknown> };
  const extension = { ...(copy.log._harExport as Record<string, unknown>) };
  delete extension.redaction;
  if (Object.keys(extension).length === 0 && input.log._harExport === undefined) {
    delete copy.log._harExport;
  } else {
    copy.log._harExport = extension;
  }
  return JSON.stringify(copy);
}

const CONFIGS: ReadonlyArray<readonly [string, RedactHarOptions]> = [
  ["standard, default rules", { level: "standard" }],
  ["shareable, default rules", { level: "shareable" }],
  ["standard, no rules", { level: "standard", rules: [] }],
  [
    "standard, one header rule",
    { level: "standard", rules: [{ id: "header:x-debug", target: "header", names: ["X-Debug"] }] },
  ],
  ["shareable, no rules", { level: "shareable", rules: [] }],
];

const CREDENTIAL_HEADERS = [
  "Cookie",
  "Set-Cookie",
  "Authorization",
  "Proxy-Authorization",
  "X-API-Key",
  "API-Key",
  "X-API-Token",
  "X-Auth-Token",
  "X-Amz-Security-Token",
  "X-CSRF-Token",
  "X-XSRF-Token",
  "CSRF-Token",
  "DPoP",
  "Signature",
];

const NON_CREDENTIAL_HEADERS = [
  "Digest",
  "Content-Digest",
  "Repr-Digest",
  "Signature-Input",
  "X-Request-Id",
];

describe("redaction report wording", () => {
  it("names each place exactly once, in the clause of the status the rules in force give it", () => {
    const { document } = buildMarkerDocument();
    for (const [name, options] of CONFIGS) {
      const { report } = redactHar(document, options);
      const claims = claimsIn(report.guarantee);
      expect(claims.length, name).toBe(report.places.length);
      for (const claim of claims) {
        const place = placeFor(report, claim);
        expect(place, `${name}: "${claim.label}" is not a place in the tables`).toBeDefined();
        expect(place?.status, `${name}: ${place?.place}`).toBe(claim.status);
      }
      expect(new Set(claims.map((claim) => placeFor(report, claim)?.place)).size, name).toBe(
        report.places.length,
      );
      const kept = report.places.filter((place) => place.status !== "removed");
      expect(report.remainingRisk, name).toBe(
        `Any secret in a kept place remains: ${kept.map((place) => place.label).join(PLACE_SEPARATOR)}.`,
      );
    }
  });

  it("lists under Removes only places whose markers are gone, and under Keeps only places whose markers stay", () => {
    const { document, markers } = buildMarkerDocument();
    for (const level of REDACTION_LEVELS) {
      const { document: redacted, report } = redactHar(document, { level });
      const claimed = new Map(
        claimsIn(report.guarantee).map((claim) => [placeFor(report, claim)?.place, claim.status]),
      );
      for (const marker of markers) {
        const status = claimed.get(marker.place);
        expect(status, `${level}: ${marker.place} is in no clause`).toBeDefined();
        expect(markerPresent(redacted, marker), `${level}: ${marker.field} (${marker.place})`).toBe(
          status !== "removed",
        );
      }
    }
  });

  it("states what each place can still hold from the place's status", () => {
    const { document } = buildMarkerDocument();
    for (const [name, options] of CONFIGS) {
      for (const place of redactHar(document, options).report.places) {
        const where = `${name}: ${place.place}`;
        if (place.status === "removed") {
          expect(place.detail, where).toBe("removed");
          expect(place.canStillHold, where).toBe(
            `Nothing. Every value in ${place.label} is removed.`,
          );
        } else if (place.status === "kept-by-allowlist") {
          expect(place.detail, where).toBe("kept by allowlist");
          expect(place.canStillHold, where).toContain(
            `Any secret written into ${place.label} remains`,
          );
        } else {
          expect(place.detail, where).toBe("not examined: may contain secrets");
          expect(place.canStillHold, where).toContain(`Any secret in ${place.label} remains`);
        }
      }
    }
  });

  it("carries no marker value or name and lists removals only by model field path", () => {
    const { document, markers } = buildMarkerDocument();
    const modelFields = new Set<string>(Object.keys(HAR_MODEL_FIELD_TABLE));
    for (const level of REDACTION_LEVELS) {
      const { document: redacted, report } = redactHar(document, { level });
      const reportText = JSON.stringify(report);
      const redactedFields = redacted.log.entries.flatMap(
        (item) => item._harExport?.redactedFields ?? [],
      );
      for (const marker of markers) {
        expect(reportText, `${level}: report holds ${marker.field}`).not.toContain(marker.marker);
        expect(redactedFields.join("\n"), `${level}: ${marker.field}`).not.toContain(marker.marker);
      }
      for (const field of [...redactedFields, ...report.records.map((record) => record.field)]) {
        expect(modelFields.has(field), `${level}: ${field}`).toBe(true);
      }
      for (const record of report.records) {
        const places: readonly string[] = HAR_MODEL_FIELD_TABLE[record.field].places;
        expect(places, `${record.field} recorded under ${record.place}`).toContain(record.place);
      }
    }
  });

  it("removes every header the standard guarantee names and keeps body hashes and other headers", () => {
    const headers = [...CREDENTIAL_HEADERS, ...NON_CREDENTIAL_HEADERS].map((name, index) => ({
      name,
      value: `header-value-${String(index)}`,
    }));
    const { document, report } = redactHar(documentOf([entry({}, { headers })]));
    const kept = new Map(
      document.log.entries[0]!.request.headers.map((header) => [header.name, header.value]),
    );
    CREDENTIAL_HEADERS.forEach((name) => expect(kept.get(name), name).toBe("[REDACTED]"));
    NON_CREDENTIAL_HEADERS.forEach((name) =>
      expect(kept.get(name), name).toBe(
        `header-value-${String(headers.findIndex((h) => h.name === name))}`,
      ),
    );
    const secretHeaders = claimsIn(report.guarantee).find(
      (claim) => placeFor(report, claim)?.place === "header-value-secret",
    );
    expect(secretHeaders?.status).toBe("removed");
    const named = secretHeaders?.label.split(" named ")[1]?.split(", ") ?? [];
    expect([...named].sort()).toEqual(CREDENTIAL_HEADERS.map((name) => name.toLowerCase()).sort());
  });

  it("stops naming a header as removed when the caller's rules do not remove it", () => {
    const headers = [
      { name: "Authorization", value: "Bearer kept-token" },
      { name: "X-Debug", value: "debug-token" },
    ];
    const { document, report } = redactHar(documentOf([entry({}, { headers })]), {
      rules: [{ id: "header:x-debug", target: "header", names: ["X-Debug"] }],
    });
    const values = document.log.entries[0]!.request.headers.map((header) => header.value);
    expect(values).toEqual(["Bearer kept-token", "[REDACTED]"]);
    const removedClause = claimsIn(report.guarantee).filter((claim) => claim.status === "removed");
    expect(removedClause.map((claim) => claim.label).join(" ")).not.toContain("authorization");
    expect(removedClause.map((claim) => claim.label)).toContain(
      "values of request and response headers named x-debug",
    );
  });
});

describe("number and boolean fields", () => {
  const NUMBER_FIELDS = [
    "log.pages[].pageTimings.onContentLoad",
    "log.pages[].pageTimings.onLoad",
    "entry.time",
    "request.headersSize",
    "request.bodySize",
    "request.cookies[].httpOnly",
    "request.cookies[].secure",
    "response.status",
    "response.headersSize",
    "response.bodySize",
    "response.cookies[].httpOnly",
    "response.cookies[].secure",
    "response.content.size",
    "response.content.compression",
    "cache.beforeRequest.hitCount",
    "cache.afterRequest.hitCount",
    "timings.blocked",
    "timings.dns",
    "timings.connect",
    "timings.send",
    "timings.wait",
    "timings.receive",
    "timings.ssl",
    "timings._blocked_queueing",
    "timings._blocked_proxy",
    "timings._workerStart",
    "timings._workerReady",
    "timings._workerFetchStart",
    "timings._workerRespondWithSettled",
    "response._transferSize",
    "entry._harExport.bodyIncomplete",
    "entry._harExport.lossyText",
    "entry._harExport.inProgress",
    "entry._initiator.lineNumber",
    "entry._initiator.columnNumber",
    "entry._initiator.stack.callFrames[].lineNumber",
    "entry._initiator.stack.callFrames[].columnNumber",
    "entry._webSocketMessages[].time",
    "entry._webSocketMessages[].opcode",
  ];
  const text = (field: string) => `TEXT_IN_${field.replace(/[^a-z]/giu, "_")}`;
  const cookie = (side: string) => ({
    name: "c",
    value: "v",
    httpOnly: text(`${side}.cookies[].httpOnly`),
    secure: text(`${side}.cookies[].secure`),
  });
  const wrongTypeEntry = {
    startedDateTime: "2026-11-16T09:00:00.000Z",
    time: text("entry.time"),
    request: {
      method: "GET",
      url: "https://a.example/",
      httpVersion: "HTTP/1.1",
      cookies: [cookie("request")],
      headers: [],
      queryString: [],
      headersSize: text("request.headersSize"),
      bodySize: text("request.bodySize"),
    },
    response: {
      status: text("response.status"),
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      cookies: [cookie("response")],
      headers: [],
      content: {
        size: text("response.content.size"),
        compression: text("response.content.compression"),
        mimeType: "text/plain",
      },
      redirectURL: "",
      headersSize: text("response.headersSize"),
      bodySize: text("response.bodySize"),
      _transferSize: text("response._transferSize"),
    },
    _harExport: {
      bodyIncomplete: text("entry._harExport.bodyIncomplete"),
      lossyText: text("entry._harExport.lossyText"),
      inProgress: text("entry._harExport.inProgress"),
    },
    _initiator: {
      type: "script",
      lineNumber: text("entry._initiator.lineNumber"),
      columnNumber: text("entry._initiator.columnNumber"),
      stack: {
        callFrames: [
          {
            functionName: "f",
            scriptId: "1",
            url: "https://a.example/a.js",
            lineNumber: text("entry._initiator.stack.callFrames[].lineNumber"),
            columnNumber: text("entry._initiator.stack.callFrames[].columnNumber"),
          },
        ],
      },
    },
    _webSocketMessages: [
      {
        type: "send",
        time: text("entry._webSocketMessages[].time"),
        opcode: text("entry._webSocketMessages[].opcode"),
        data: "d",
      },
    ],
    cache: {
      beforeRequest: { hitCount: text("cache.beforeRequest.hitCount") },
      afterRequest: { hitCount: text("cache.afterRequest.hitCount") },
    },
    timings: Object.fromEntries(
      [
        "blocked",
        "dns",
        "connect",
        "send",
        "wait",
        "receive",
        "ssl",
        "_blocked_queueing",
        "_blocked_proxy",
        "_workerStart",
        "_workerReady",
        "_workerFetchStart",
        "_workerRespondWithSettled",
      ].map((key) => [key, text(`timings.${key}`)]),
    ),
  };
  const page = {
    id: "p",
    title: "t",
    startedDateTime: "2026-11-16T09:00:00.000Z",
    pageTimings: {
      onContentLoad: text("log.pages[].pageTimings.onContentLoad"),
      onLoad: text("log.pages[].pageTimings.onLoad"),
    },
  };

  it("gives every number and boolean field of the model a row of that kind", () => {
    const numberRows = Object.values(HAR_MODEL_FIELD_TABLE)
      .filter((row) => row.kinds.includes("number") || row.kinds.includes("boolean"))
      .filter((row) => !row.kinds.includes("string"))
      .map((row) => row.field);
    expect([...numberRows].sort()).toEqual([...NUMBER_FIELDS].sort());
  });

  it("removes a value of the wrong type from every number and boolean field at both levels and records each", () => {
    for (const level of REDACTION_LEVELS) {
      const input = documentOf([clone(wrongTypeEntry)], { pages: [clone(page)] });
      const { document, report } = redactHar(input, { level });
      const output = JSON.stringify(document.log.entries) + JSON.stringify(document.log.pages);
      for (const field of NUMBER_FIELDS) {
        expect(output, `${level}: ${field}`).not.toContain(text(field));
      }
      // A whole place that held a wrong value goes whole, and that removal is recorded too.
      const wholePlaces = [
        "cache.afterRequest",
        "cache.beforeRequest",
        "entry._initiator",
        "entry._webSocketMessages",
      ];
      const wrongType = report.records.filter((record) => record.place === "wrong-type");
      expect(wrongType.map((record) => record.field).sort(), level).toEqual(
        [...NUMBER_FIELDS, ...wholePlaces].sort(),
      );
      expect(report.places.find((place) => place.place === "wrong-type")?.count).toBe(
        NUMBER_FIELDS.length + wholePlaces.length,
      );
      for (const field of wholePlaces) {
        expect(JSON.stringify(document.log.entries[0]), field).not.toContain(
          `"${field.split(".").at(-1)!}"`,
        );
      }
      const timings = document.log.entries[0]!.timings;
      expect([timings.send, timings.wait, timings.receive, timings.ssl]).toEqual([
        0,
        0,
        0,
        undefined,
      ]);
      expect(parseHar(document).problems.filter((problem) => problem.severity !== "note")).toEqual(
        [],
      );

      const single = redactHarEntry(clone(wrongTypeEntry) as never, { level }, 0);
      for (const field of NUMBER_FIELDS.filter((name) => !name.startsWith("log."))) {
        expect(JSON.stringify(single.entry), `${level} entry: ${field}`).not.toContain(text(field));
      }
    }
  });
});

describe("counting and recording by place", () => {
  it("counts and records a custom field whose value holds no string", () => {
    const input = documentOf([entry({ _serverPort: 443, _flags: { on: true }, _none: null })]);
    const standard = redactHar(input, { level: "standard" });
    expect(standard.document.log.entries[0]).toMatchObject({ _serverPort: 443, _none: null });
    expect(
      standard.report.places.find((place) => place.place === "other-custom-field")?.count,
    ).toBe(3);

    const shareable = redactHar(input, { level: "shareable" });
    const redacted = shareable.document.log.entries[0]!;
    expect(
      Object.keys(redacted).filter((key) => key.startsWith("_") && key !== "_harExport"),
    ).toEqual([]);
    expect(shareable.report.records).toContainEqual({
      entryIndex: 0,
      place: "other-custom-field",
      field: "entry.<custom>",
      ruleId: "shareable:other-custom-field",
      count: 3,
    });
    expect(redacted._harExport?.redactedFields).toContain("entry.<custom>");
  });

  it("lists every removal of an entry both in the records and in that entry's redactedFields, and says so", () => {
    const { document } = buildMarkerDocument();
    for (const level of REDACTION_LEVELS) {
      const { document: redacted, report } = redactHar(document, { level });
      expect(report.guarantee).toContain(
        "Each removal is listed by field path in log._harExport.redaction.records and in _harExport.redactedFields on its entry.",
      );
      redacted.log.entries.forEach((item, index) => {
        const recorded = new Set(
          report.records
            .filter((record) => record.entryIndex === index)
            .map((record) => record.field),
        );
        expect(
          [...(item._harExport?.redactedFields ?? [])].sort(),
          `${level} entry ${String(index)}`,
        ).toEqual([...recorded].sort());
      });
    }
  });
});

describe("values of the wrong type", () => {
  it("drops array items of the wrong type and records each", () => {
    const headers = [{ name: "Accept", value: "a" }, 5, "Authorization: Bearer hidden"];
    for (const level of REDACTION_LEVELS) {
      const { document, report } = redactHar(
        documentOf([entry({}, { headers: headers as unknown as never[] })]),
        { level },
      );
      expect(document.log.entries[0]!.request.headers).toHaveLength(1);
      expect(JSON.stringify(document)).not.toContain("hidden");
      expect(report.records).toContainEqual({
        entryIndex: 0,
        place: "wrong-type",
        field: "request.headers",
        ruleId: `${level}:wrong-type`,
        count: 2,
      });
    }
  });
});

describe("values inside whole-object places, declared custom fields and nulls", () => {
  it("records every field it removes inside initiators, WebSocket messages, cookies and declared custom fields", () => {
    const { document } = buildMarkerDocument();
    const fields = new Set<string>(
      redactHar(document, { level: "shareable" }).report.records.map((record) => record.field),
    );
    for (const field of [
      "entry._initiator.<custom>",
      "entry._initiator.stack.callFrames[].url",
      "entry._webSocketMessages[].<custom>",
      "entry._webSocketMessages[].data",
      "response._transferSize",
      "timings._workerStart",
      "request.cookies[].httpOnly",
      "request.cookies[].secure",
    ]) {
      expect(fields.has(field), field).toBe(true);
    }
  });

  it("counts the call frames of a parent stack in the initiator place", () => {
    const frame = (url: string) => ({
      functionName: "f",
      scriptId: "1",
      url,
      lineNumber: 1,
      columnNumber: 1,
    });
    const initiator = {
      type: "script",
      stack: {
        callFrames: [frame("https://a.example/one.js")],
        parent: { callFrames: [frame("https://a.example/two.js")] },
      },
    };
    const { report } = redactHar(documentOf([entry({ _initiator: initiator })]), {
      level: "shareable",
    });
    const urls = report.records.find(
      (record) => record.field === "entry._initiator.stack.callFrames[].url",
    );
    expect(urls?.count).toBe(2);
  });

  it("treats null as a value of the wrong type in a field that cannot be null", () => {
    for (const level of REDACTION_LEVELS) {
      const { document, report } = redactHar(
        documentOf([entry({ time: null, _initiator: null })]),
        { level },
      );
      expect(document.log.entries[0]!.time).toBe(0);
      expect("_initiator" in document.log.entries[0]!).toBe(false);
      const wrong = report.records
        .filter((record) => record.place === "wrong-type")
        .map((record) => record.field)
        .sort();
      expect(wrong, level).toEqual(["entry._initiator", "entry.time"]);
    }
  });

  it("gives a removed required number the row's removal value", () => {
    const placeTable = {
      ...HAR_PLACE_TABLE,
      measurement: { ...HAR_PLACE_TABLE.measurement, standard: "removed" as const },
    };
    const { document } = redactHar(documentOf([entry({ time: 12 })]), { placeTable });
    const redacted = document.log.entries[0]!;
    expect([redacted.time, redacted.timings.send, redacted.request.headersSize]).toEqual([
      0, 0, -1,
    ]);
  });

  it("counts null and empty values as present and records their removal", () => {
    const input = documentOf([
      {
        ...entry(
          {},
          {
            cookies: [{ name: "sid", value: "v", expires: null }],
            postData: { mimeType: "text/plain", params: [], text: null },
          },
        ),
      },
    ]);
    const standard = redactHar(input, { level: "standard" });
    expect(standard.document.log.entries[0]!.request.cookies[0]!.expires).toBeNull();
    expect(standard.report.places.find((place) => place.place === "cookie-metadata")?.count).toBe(
      2,
    );
    const shareable = redactHar(input, { level: "shareable" });
    const fields = shareable.report.records.map((record) => record.field);
    for (const field of [
      "request.cookies[].expires",
      "request.postData.text",
      "response.redirectURL",
    ]) {
      expect(fields, field).toContain(field);
    }
    expect(shareable.document.log.entries[0]!._harExport?.redactedFields).toContain(
      "request.cookies[].expires",
    );
  });
});

describe("URL authorities", () => {
  it("reads the host of every scheme with an authority, so a table that removes hosts removes it", () => {
    const placeTable = {
      ...HAR_PLACE_TABLE,
      "request-url-host": { ...HAR_PLACE_TABLE["request-url-host"], shareable: "removed" as const },
    };
    const urls = ["https://a.example/p", "wss://b.example:8443/socket", "ftp://c.example/f"];
    const { document } = redactHar(documentOf(urls.map((url) => entry({}, { url }))), {
      level: "shareable",
      placeTable,
    });
    expect(document.log.entries.map((item) => item.request.url)).toEqual([
      "https://redacted.invalid/p",
      "wss://redacted.invalid/socket",
      "ftp://redacted.invalid/f",
    ]);
  });

  it("counts each kept userinfo once, at the start of a URL or inside a wrapper", () => {
    for (const url of ["https://u:p@a.example/", "blob:https://u:p@a.example/x"]) {
      const { report } = redactHar(documentOf([entry({}, { url })]), { rules: [] });
      const place = report.places.find((item) => item.place === "request-url-userinfo");
      expect(place?.status, url).toBe("kept-not-examined");
      expect(place?.count, url).toBe(1);
    }
  });
});

describe("empty values and URLs with no host", () => {
  it("counts and records an empty title, empty param fields, and null or empty bodies in their own places", () => {
    const input = documentOf(
      [
        entry(
          {
            response: {
              status: 200,
              statusText: "OK",
              httpVersion: "HTTP/1.1",
              cookies: [],
              headers: [],
              content: { size: 0, mimeType: "application/json", text: "" },
              redirectURL: "",
              headersSize: -1,
              bodySize: -1,
            },
          },
          {
            postData: {
              mimeType: "application/json",
              params: [{ name: "p", value: "v", fileName: "", contentType: "" }],
              text: null,
            },
          },
        ),
      ],
      {
        pages: [
          { id: "p", title: "", startedDateTime: "2026-11-16T09:00:00.000Z", pageTimings: {} },
        ],
      },
    );
    const count = (report: HarLogRedactionExtension, place: string) =>
      report.places.find((item) => item.place === place)?.count;
    const standard = redactHar(input, { level: "standard" }).report;
    expect(count(standard, "page-title")).toBe(1);
    expect(count(standard, "body-param")).toBe(4);
    expect(count(standard, "request-body-other")).toBe(1);
    expect(count(standard, "body-json")).toBe(0);
    expect(count(standard, "response-body-other")).toBe(1);
    expect(count(standard, "response-body-json")).toBe(0);
    const recorded = redactHar(input, { level: "shareable" }).report.records.map(
      (record) => `${record.place} ${record.field}`,
    );
    for (const expected of [
      "page-title log.pages[].title",
      "body-param request.postData.params[].fileName",
      "body-param request.postData.params[].contentType",
      "request-body-other request.postData.text",
      "response-body-other response.content.text",
    ]) {
      expect(recorded, expected).toContain(expected);
    }
  });

  it("counts the scheme as the host place and the rest as path or opaque content", () => {
    const counts = (url: string) => {
      const { report } = redactHar(documentOf([entry({}, { url })]), { level: "standard" });
      return ["request-url-host", "request-url-path", "request-url-opaque"].map(
        (place) => report.places.find((item) => item.place === place)?.count,
      );
    };
    expect(counts("file:///var/log/app.log")).toEqual([1, 1, 0]);
    expect(counts("data:text/plain,hello")).toEqual([1, 0, 1]);
    expect(counts("about:blank")).toEqual([1, 0, 1]);
    expect(counts("https://a.example")).toEqual([1, 0, 0]);
  });

  it("reduces a URL with no host to its scheme and a placeholder under shareable", () => {
    const { document, report } = redactHar(
      documentOf([entry({}, { url: "mailto:someone@mail.example?subject=hi" })]),
      { level: "shareable" },
    );
    expect(document.log.entries[0]!.request.url).toBe("mailto:redacted");
    expect(report.records.map((record) => record.place)).toContain("request-url-opaque");
  });
});

describe("rules that select by name", () => {
  it("says a header rule with matchAll selects every name, and removes every header value", () => {
    const headers = [
      { name: "X-One", value: "one" },
      { name: "Accept", value: "two" },
    ];
    const { document, report } = redactHar(documentOf([entry({}, { headers })]), {
      rules: [{ id: "header:all", target: "header", names: [], matchAll: true }],
    });
    expect(document.log.entries[0]!.request.headers.map((header) => header.value)).toEqual([
      "[REDACTED]",
      "[REDACTED]",
    ]);
    expect(report.places.find((place) => place.place === "header-value-secret")?.label).toBe(
      "values of request and response headers with any name",
    );
  });

  it("describes a cookie rule as selecting every cookie value, and names the rule where it matched", () => {
    const cookies = [
      { name: "sid", value: "s" },
      { name: "other", value: "o" },
    ];
    const { document, report } = redactHar(documentOf([entry({}, { cookies })]), {
      rules: [{ id: "cookie:only-sid", target: "cookie", names: ["sid"] }],
    });
    expect(document.log.entries[0]!.request.cookies.map((cookie) => cookie.value)).toEqual([
      "[REDACTED]",
      "[REDACTED]",
    ]);
    const cookiePlace = report.places.find((place) => place.place === "cookie");
    expect(cookiePlace?.label).toBe("cookie values");
    expect(cookiePlace?.status).toBe("removed");
    // The value the rule names is recorded under the rule; the rest under the level's cookie place.
    expect(report.records.map((record) => `${record.ruleId} ${String(record.count)}`)).toEqual([
      "cookie:only-sid 1",
      "standard:cookie 1",
    ]);
  });
});

describe("standard leaves what it keeps as it was", () => {
  it("returns a document with nothing to remove byte for byte, raw or parsed, and says so", () => {
    for (const [name, fixture] of [
      ["firefox", firefoxHar],
      ["spec", specHar],
    ] as const) {
      const raw = clone(fixture as unknown as HarDocument);
      const parsed = parseHar(clone(raw));
      expect(parsed.ok).toBe(true);
      for (const input of [raw, parsed.ok ? parsed.document : raw]) {
        const { document, report } = redactHar(clone(input), { level: "standard" });
        expect(report.totalRemoved, name).toBe(0);
        expect(withoutReport(document, input), name).toBe(JSON.stringify(input));
        expect(report.guarantee).toContain(
          "Every kept value and the order of keys stay as they were.",
        );
      }
    }
  });

  it("changes only the removed values: comments, empty encodings and key order stay", () => {
    const input = documentOf([
      entry(
        {
          response: {
            content: { encoding: "", size: 0, mimeType: "text/plain" },
            status: 200,
            statusText: "OK",
            httpVersion: "HTTP/1.1",
            cookies: [],
            headers: [],
            redirectURL: "",
            headersSize: -1,
            bodySize: -1,
          },
        },
        {
          url: "https://a.example/?token=x",
          cookies: [{ comment: "set by login", name: "sid", value: "v" }],
          headers: [{ name: "Authorization", value: "Bearer x", comment: "captured by devtools" }],
          queryString: [{ name: "token", value: "x", comment: "from link" }],
          postData: {
            mimeType: "application/x-www-form-urlencoded",
            text: "password=x",
            params: [{ name: "password", value: "x", comment: "typed" }],
          },
        },
      ),
    ]);
    const { document } = redactHar(clone(input), { level: "standard" });

    const expected = clone(input) as unknown as {
      log: { entries: Array<Record<string, any>> };
    };
    const request = expected.log.entries[0]!.request;
    request.url = "https://a.example/?token=%5BREDACTED%5D";
    request.cookies[0].value = "[REDACTED]";
    request.headers[0].value = "[REDACTED]";
    request.queryString[0].value = "[REDACTED]";
    request.postData.params[0].value = "[REDACTED]";
    const redactedFields = document.log.entries[0]!._harExport?.redactedFields ?? [];
    expect([...redactedFields].sort()).toEqual([
      "request.cookies[].value",
      "request.headers[].value",
      "request.postData.params[].value",
      "request.queryString[].value",
      "request.url",
    ]);
    expected.log.entries[0]!._harExport = { redactedFields };
    expect(withoutReport(document, input)).toBe(JSON.stringify(expected));
  });
});

describe("redaction entry points", () => {
  it("counts removals outside entries in the document totals", () => {
    const { report } = redactHar(documentOf([], { comment: "log note" }), { level: "shareable" });
    expect(report.records).toEqual([
      {
        entryIndex: -1,
        place: "comment",
        field: "log.comment",
        ruleId: "shareable:comment",
        count: 1,
      },
    ]);
    expect(report.totalRemoved).toBe(1);
  });

  it("redacts one entry with the caller's rules and entry index", () => {
    const one = entry(
      {},
      {
        headers: [{ name: "Authorization", value: "Bearer kept" }],
        cookies: [{ name: "sid", value: "s" }],
      },
    ) as unknown as HarDocument["log"]["entries"][number];
    const result = redactHarEntry(
      one,
      { rules: [{ id: "cookie:all", target: "cookie", names: [], matchAll: true }] },
      7,
    );
    expect(result.entry.request.headers[0]!.value).toBe("Bearer kept");
    expect(result.places.find((place) => place.place === "header-value-secret")?.status).toBe(
      "kept-not-examined",
    );
    expect(result.records.map((record) => record.entryIndex)).toEqual([7]);
    expect(result.entry.request.cookies[0]!.value).toBe("[REDACTED]");
  });

  it("reports a URL as touched when a rule removed a value, even if the text did not change", () => {
    const already = redactUrl("https://a.example/?token=%5BREDACTED%5D");
    expect(already.url).toBe("https://a.example/?token=%5BREDACTED%5D");
    expect(already.records).toHaveLength(1);
    expect(already.touched).toBe(true);
    expect(redactUrl("https://a.example/?page=2").touched).toBe(false);
  });

  it("replaces redaction records an earlier run left in the file", () => {
    const earlier = entry({
      _harExport: { source: "both", redactedFields: ["header:Authorization"] },
    });
    const { document, report } = redactHar(
      documentOf([earlier], { _harExport: { redaction: { applied: true, totalRemoved: 9 } } }),
    );
    expect(document.log.entries[0]!._harExport).toEqual({
      source: "both",
      redactedFields: ["entry._harExport.redactedFields"],
    });
    expect(report.records.map((record) => record.field).sort()).toEqual([
      "entry._harExport.redactedFields",
      "log._harExport.redaction",
    ]);
    expect(document.log._harExport?.redaction).toBe(report);
  });

  it("rejects a level it does not know instead of falling back to standard", () => {
    expect(() =>
      redactHar(documentOf([]), { level: "Shareable" as unknown as "shareable" }),
    ).toThrow(RangeError);
  });

  it("removes a listed header whose name carries stray spaces or a trailing colon", () => {
    const headers = [" Authorization", "Cookie ", "Authorization:"].map((name) => ({
      name,
      value: "secret-value",
    }));
    const { document } = redactHar(documentOf([entry({}, { headers })]));
    expect(document.log.entries[0]!.request.headers.map((header) => header.value)).toEqual([
      "[REDACTED]",
      "[REDACTED]",
      "[REDACTED]",
    ]);
  });
});
