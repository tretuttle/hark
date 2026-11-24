import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  CANCEL_BOUND_BYTES,
  convertsWithK6,
  checkAfterCrash,
  checkCancel,
  checkExport,
  checkNextStart,
  checkRow,
  checkTabCases,
  EXPORT_FAULTS,
  withDataRow,
  withoutCreator,
  withSecretInTitle,
  validateHar,
  type TruthServer,
} from "./export-verify.ts";
import type { SequenceTruth, ServedRequest } from "./server.ts";

const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hark-export-check-"));
afterAll(() => NodeFS.rmSync(work, { recursive: true, force: true }));

const sha = (b: Uint8Array) => NodeCrypto.createHash("sha256").update(b).digest("hex");
const HOST = "127.0.0.1:8080";
const SECRET = "SECRETMARKER";

/** What a fixture server sent: a text page, and a gzip body whose decoded bytes differ from the wire bytes. */
const page = Buffer.from("<!doctype html><title>t</title>", "utf8");
const decoded = NodeCrypto.randomBytes(5000);
const wire = NodeZlib.gzipSync(decoded);
const sent: readonly (SequenceTruth & { readonly body: Buffer })[] = [
  {
    seq: 1,
    method: "GET",
    path: "/",
    url: "/?access_token=x",
    status: 200,
    expectedLength: page.length,
    wireBytesSent: page.length,
    wireSha256: sha(page),
    decodedLength: page.length,
    decodedSha256: sha(page),
    aborted: false,
    body: page,
  },
  {
    seq: 2,
    method: "GET",
    path: "/fixtures/gzip",
    url: "/fixtures/gzip",
    status: 200,
    expectedLength: wire.length,
    wireBytesSent: wire.length,
    wireSha256: sha(wire),
    decodedLength: decoded.length,
    decodedSha256: sha(decoded),
    aborted: false,
    body: decoded,
  },
];
const servers: readonly TruthServer[] = [
  {
    host: HOST,
    server: {
      getSequenceTruth: (seq) => sent.find((t) => t.seq === seq),
      getRequestLog: (): readonly ServedRequest[] =>
        sent.map((t) => ({
          seq: t.seq,
          method: t.method,
          path: t.path,
          url: t.url,
          status: t.status,
        })),
    },
  },
];

/** The file a correct export writes, built here from what the server sent. */
const exported = JSON.stringify({
  log: {
    version: "1.2",
    creator: { name: "Hark", version: "0.1.0" },
    pages: [
      {
        startedDateTime: "2026-11-16T00:00:00.000Z",
        id: "page_0",
        title: `http://${HOST}/?access_token=%5BREDACTED%5D`,
        pageTimings: {},
      },
    ],
    entries: sent.map((t) => ({
      pageref: "page_0",
      startedDateTime: "2026-11-16T00:00:00.000Z",
      time: 1,
      request: {
        method: "GET",
        url: `http://${HOST}${t.path}`,
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: [],
        queryString: [],
        headersSize: -1,
        bodySize: 0,
      },
      response: {
        status: 200,
        statusText: "OK",
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: [
          { name: "X-Seq", value: String(t.seq) },
          { name: "Content-Length", value: String(t.wireBytesSent) },
        ],
        content: {
          size: t.body.length,
          mimeType: "application/octet-stream",
          text: t.body.toString("base64"),
          encoding: "base64",
        },
        redirectURL: "",
        headersSize: -1,
        bodySize: t.wireBytesSent,
      },
      cache: {},
      timings: { send: 0, wait: 1, receive: 0 },
    })),
  },
});
const expectation = { servers, hosts: [HOST], previewCount: 2, secret: SECRET };

describe("the export check", () => {
  it("passes an export that holds every logged request with its server's decoded bytes", async () => {
    expect(checkExport(exported, expectation)).toEqual({ entries: 2, exact: 2, problems: [] });
    expect(await validateHar(exported)).toBeNull();
    const file = NodePath.join(work, "ok.har");
    NodeFS.writeFileSync(file, exported);
    expect(convertsWithK6(file, work)).toBe(true);
  });

  it.each(EXPORT_FAULTS)("catches $name", (fault) => {
    const broken = JSON.stringify(fault.alter(JSON.parse(exported)));
    expect(checkExport(broken, expectation).problems).not.toEqual([]);
  });

  it("catches the secret in a page title, a count the popup did not show, and an entry from another server", () => {
    expect(checkExport(withSecretInTitle(exported, SECRET), expectation).problems).not.toEqual([]);
    expect(checkExport(exported, { ...expectation, previewCount: 3 }).problems).toEqual([
      "2 entries, the popup said 3",
    ]);
    expect(checkExport(exported, { ...expectation, hosts: [] }).problems).toHaveLength(2);
  });

  it("sees har-to-k6 reject a data: row and har-validator reject a log without its creator", async () => {
    const file = NodePath.join(work, "data-row.har");
    NodeFS.writeFileSync(file, withDataRow(exported));
    expect(convertsWithK6(file, work)).toBe(false);
    expect(await validateHar(withoutCreator(exported))).not.toBeNull();
  });
});

describe("the tab, cancel, disk-full and crash checks", () => {
  const state = {
    name: "getPopup({ tabId: 0 })",
    expect: "state" as const,
    state: { read: (v: unknown) => v, equals: 1 },
  };
  const refused = { name: "getPopup({ tabId: -1 })", expect: "refused" as const };

  it("wants states for missing tabs and refusals for negative ids", () => {
    expect(
      checkTabCases([
        { case: state, called: { ok: true, value: 1 } },
        { case: refused, called: { ok: false, error: "Invalid" } },
      ]),
    ).toEqual([]);
    expect(checkTabCases([{ case: state, called: { ok: false, error: "boom" } }])).toHaveLength(1);
    expect(checkTabCases([{ case: refused, called: { ok: true, value: {} } }])).toHaveLength(1);
  });

  const journal = '{"started":"/d/x.har.part"}\n{"ended":"/d/x.har.part"}\n';
  it("wants a cancel to stop within one chunk and leave nothing", () => {
    const ok = {
      state: "cancelled",
      audit: { bytesAtCancel: 10, bytesAtStop: 10 + CANCEL_BOUND_BYTES },
      left: [],
      journal,
      openUnnamed: 0,
    };
    expect(checkCancel(ok)).toEqual([]);
    expect(checkCancel({ ...ok, journal: "" })).toEqual([]);
    expect(checkCancel({ ...ok, openUnnamed: 1 })).toHaveLength(1);
    expect(
      checkCancel({ ...ok, audit: { bytesAtCancel: 10, bytesAtStop: 10, keptFile: "x.har" } }),
    ).toHaveLength(1);
    expect(
      checkCancel({ ...ok, audit: { bytesAtCancel: 10, bytesAtStop: 11 + CANCEL_BOUND_BYTES } }),
    ).toHaveLength(1);
    expect(checkCancel({ ...ok, left: ["x.har.part"] })).toHaveLength(1);
    expect(checkCancel({ ...ok, journal: '{"started":"/d/x.har.part"}\n' })).toHaveLength(1);
  });

  it("wants the next start to delete the part a killed export left", () => {
    expect(checkAfterCrash({ steps: ["delete-export-part"], left: [], journaled: true })).toEqual(
      [],
    );
    expect(checkAfterCrash({ steps: [], left: ["killed.har.part"], journaled: true })).toHaveLength(
      2,
    );
    expect(checkAfterCrash({ steps: [], left: [], journaled: false })).toEqual([]);
    expect(checkAfterCrash({ steps: [], left: ["killed.har"], journaled: false })).toHaveLength(1);
  });

  it("wants each cause's named kind or file, numbers only, no path to the page, nothing outside touched", () => {
    const paths = ["/w/profile", "/w/out"];
    const failed = {
      expect: { kind: "write-failed", failure: "access-denied" } as const,
      state: { kind: "write-failed", failure: { kind: "access-denied" } },
      served: '{"job":{"state":{"kind":"write-failed","failure":{"kind":"access-denied"}}}}',
      route: null,
      paths,
      files: [],
      untouched: [{ path: "/w/profile/prefs.js", before: "a", after: "a" }],
      journal: "",
      theirs: ["/w/out/theirs.har.part"],
      timing: null,
      outside: [{ path: "/w/profile/sessionstore.jsonlz4", exportBytes: false }],
      written: null,
      source: null,
    };
    expect(checkRow(failed)).toEqual([]);
    const ran = '{"started":"/w/out/a.har.part","head":"{"}\n{"ended":"/w/out/a.har.part"}\n';
    expect(checkRow({ ...failed, journal: ran })).toEqual([]);
    expect(
      checkRow({
        ...failed,
        journal: `{"started":"/w/out/theirs.har.part","head":"{"}\n${ran}{"started":"/w/out/b.har.part","head":"{"}\n`,
      }),
    ).toEqual([
      "the journal leaves /w/out/theirs.har.part open",
      "the journal leaves /w/out/b.har.part open",
      "the journal names /w/out/theirs.har.part, not the export's",
    ]);
    expect(
      checkRow({
        ...failed,
        state: { kind: "write-failed", failure: { kind: "other", detail: "/w/out/a.har.part" } },
        served: '{"detail":"NotAllowedError /w/out/a.har.part jar:file:///w/profile/x.xpi"}',
        files: ["a.har.part"],
        untouched: [{ path: "/w/profile/prefs.js", before: "a", after: "b" }],
        outside: [
          { path: "/w/profile/sessionstore.jsonlz4", exportBytes: false },
          { path: "/w/profile/a.har", exportBytes: true },
        ],
      }),
    ).toEqual([
      'ended {"kind":"write-failed","failure":{"kind":"other","detail":"/w/out/a.har.part"}}, expected write-failed access-denied',
      "left behind: a.har.part",
      "the failure carries detail",
      "a path reached the page: /w/profile",
      "a path reached the page: /w/out",
      "a file:// URL reached the page",
      "a jar:file: URL reached the page",
      "/w/profile/prefs.js changed",
      "/w/profile/a.har, outside the folder, holds export bytes",
    ]);
    const done = {
      ...failed,
      expect: { kind: "done", fileName: "a (2).har" } as const,
      state: { kind: "done", fileName: "a (2).har" },
      served: "{}",
      files: ["a (2).har"],
      written: {
        bytes: 10,
        sha256: "5d5b09f6dcb2d53a5fffc60c4ac0d55fabdf556069d6631545f42aa6e3500f2e",
        fixtures: [],
      },
    };
    expect(checkRow(done)).toEqual([]);
    // A done export is checked by its bytes: one that cannot be read, one missing a fixture's body, and a copy that is
    // not the unnamed file, such as an empty part, each fail.
    expect(checkRow({ ...done, written: null })).toEqual([
      "the finished file could not be read back",
    ]);
    expect(
      checkRow({ ...done, written: { ...done.written, fixtures: ["HAR is not JSON"] } }),
    ).toEqual(["the finished file: HAR is not JSON"]);
    const copied = { ...done, source: { bytes: 10, sha256: done.written.sha256 } };
    expect(checkRow(copied)).toEqual([]);
    expect(
      checkRow({
        ...copied,
        written: {
          bytes: 0,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          fixtures: [],
        },
      }),
    ).toEqual([
      "the finished file (0 bytes, e3b0c44298fc) is not the unnamed file (10 bytes, 5d5b09f6dcb2)",
    ]);
    expect(checkRow({ ...done, files: ["a (2).har", "a.har.part"] })).toEqual([
      "files: a (2).har, a.har.part",
    ]);
    const named = {
      ...done,
      expect: { ...done.expect, route: "named", because: "fd-link-lost" } as const,
      state: { ...done.state, route: "named" },
      route: { route: "named", because: "fd-link-lost", errno: "fd-link-unavailable" },
    };
    expect(checkRow(named)).toEqual([]);
    expect(
      checkRow({
        ...named,
        state: { ...done.state, route: { route: "named", because: "fd-link-lost" } },
        served: '{"route":"named","because":"fd-link-lost","errno":"fd-link-unavailable"}',
        route: { route: "link" },
      }),
    ).toEqual([
      'route [object Object] on the page and {"route":"link"} kept, expected named',
      "took the named route because undefined, expected fd-link-lost",
      'the page\'s route is {"route":"named","because":"fd-link-lost"}, not a route\'s kind',
      '"because" reached the page',
      '"errno" reached the page',
    ]);
    const unconfirmed = {
      ...failed,
      expect: { kind: "write-failed", failure: "file-replaced", unconfirmed: true } as const,
      state: { kind: "write-failed", failure: { kind: "file-replaced" }, unconfirmed: true },
    };
    expect(checkRow(unconfirmed)).toEqual([]);
    expect(
      checkRow({
        ...unconfirmed,
        state: { kind: "write-failed", failure: { kind: "file-replaced" } },
      }),
    ).toEqual(["unconfirmed undefined, expected true"]);
    const full = { ...failed, expect: { kind: "write-failed", failure: "disk-full" } as const };
    expect(
      checkRow({
        ...full,
        state: { kind: "write-failed", failure: { kind: "disk-full", needBytes: 9, freeBytes: 9 } },
      }),
    ).toHaveLength(1);
  });

  it("wants a held row cancelled or ended within its limit, with nothing left", () => {
    const cancelled = {
      expect: { kind: "cancelled" } as const,
      state: { kind: "cancelled" },
      served: "{}",
      route: null,
      paths: [],
      files: [],
      untouched: [],
      journal: "",
      theirs: [],
      timing: { tookMs: 400, withinMs: 5000 },
      outside: [],
      written: null,
      source: null,
    };
    expect(checkRow(cancelled)).toEqual([]);
    expect(
      checkRow({
        ...cancelled,
        state: { kind: "writing", done: 8, total: 8, bytes: 9 },
        files: ["a.har"],
        timing: { tookMs: 15_020, withinMs: 5000 },
      }),
    ).toEqual([
      "ended 15020 ms after the row let it go, more than 5000",
      'ended {"kind":"writing","done":8,"total":8,"bytes":9}, expected cancelled',
      "left behind: a.har",
    ]);
  });

  it("wants every file there before the row, and every file the row made, as it was after the next start", () => {
    expect(checkNextStart([{ path: "a", before: "file:1", after: "file:1" }])).toEqual([]);
    expect(
      checkNextStart([
        { path: "a", before: "file:1", after: "absent" },
        { path: "b", before: "link:/x", after: "link:/x" },
      ]),
    ).toEqual(["a was file:1, after the next start absent"]);
  });
});
