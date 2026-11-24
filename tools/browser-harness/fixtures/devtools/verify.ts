import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as HarValidator from "har-validator";
import { convertsWithK6, validateHar } from "../../src/export-verify.ts";
import {
  DEVTOOLS_GROUND_TRUTH,
  DEVTOOLS_STACK_FRAMES,
  sha256,
  smallSlice,
  type DevtoolsFixtureServer,
  type DevtoolsServedRequest,
} from "./server.ts";

export interface DevtoolsHarReport {
  readonly requests: number;
  readonly sources: {
    readonly both: number;
    readonly recordingOnly: number;
    readonly devtoolsOnly: number;
  };
  readonly notNetwork: { readonly [scheme: string]: number };
  readonly bodies: {
    readonly response: {
      readonly filledIn: number;
      readonly missing: { readonly [reason: string]: number };
    };
  };
}

export interface DevtoolsHarDocument {
  readonly log: {
    readonly version: string;
    readonly creator?: { readonly name: string; readonly version: string };
    readonly comment?: string;
    readonly pages?: readonly { readonly id: string; readonly title: string }[];
    readonly _harExport?: { readonly report?: DevtoolsHarReport };
    readonly entries: readonly DevtoolsHarEntry[];
  };
}

export interface DevtoolsHarEntry {
  readonly pageref?: string;
  readonly startedDateTime: string;
  readonly comment?: string;
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers: readonly { readonly name: string; readonly value: string }[];
    readonly postData?: {
      readonly mimeType: string;
      readonly text?: string;
      readonly params?: readonly { readonly name: string; readonly value?: string }[];
    };
  };
  readonly response: {
    readonly status: number;
    readonly headers: readonly { readonly name: string; readonly value: string }[];
    readonly content: {
      readonly size: number;
      readonly mimeType: string;
      readonly text?: string;
      readonly encoding?: string;
      readonly comment?: string;
    };
  };
  readonly timings?: {
    readonly blocked?: number;
    readonly dns?: number;
    readonly connect?: number;
    readonly ssl?: number;
    readonly send?: number;
    readonly wait?: number;
    readonly receive?: number;
  };
  readonly _initiator?: {
    readonly type: string;
    readonly url?: string;
    readonly stack?: {
      readonly callFrames: readonly {
        readonly functionName: string;
        readonly url: string;
        readonly lineNumber: number;
        readonly columnNumber: number;
      }[];
    };
  };
  readonly _harExport?: {
    readonly source?: string;
    readonly bodyState?: string;
    readonly bodyMissing?: string;
    readonly headersMissing?: string;
    readonly timingsMissing?: string;
  };
}

export interface DevtoolsVerifyExpectation {
  readonly server?: Pick<DevtoolsFixtureServer, "getSequenceTruth" | "getRequestLog">;
  readonly expectedLog?: readonly DevtoolsServedRequest[];
  readonly entries?: number;
  readonly entriesMin?: number;
  readonly key?: string;
  readonly otherKey?: string;
  readonly sources?: {
    readonly both?: number;
    readonly recordingOnly?: number;
    readonly devtoolsOnly?: number;
  };
  readonly filledInMin?: number;
  readonly expectTruncatedBig?: boolean;
  readonly allowMissingUrlIncludes?: string;
  readonly allowMissingReasons?: readonly string[];
  readonly stubs?: { readonly minCount: number };
  readonly requireHeadersAndTimings?: boolean;
  readonly checkMetadataFlags?: boolean;
  readonly allowReloadExtraEntries?: boolean;
  readonly stackUrlIncludes?: string;
  readonly expectedFrames?: readonly string[];
  readonly notNetworkDataMin?: number;
  readonly requireK6?: boolean;
  readonly workDir?: string;
  readonly requireDevtoolsSources?: boolean;
  readonly disallowBothFromPrefix?: string;
  readonly expectedSourceTagForUrl?: readonly {
    readonly urlIncludes: string;
    readonly source: string;
  }[];
}

export interface DevtoolsVerifyResult {
  readonly entries: number;
  readonly exactBodies: number;
  readonly emptyHeaders: number;
  readonly emptyTimings: number;
  readonly unflaggedEmptyHeaders: number;
  readonly unflaggedEmptyTimings: number;
  readonly problems: readonly string[];
}

function bodyOfEntry(entry: DevtoolsHarEntry): Buffer | null {
  const { text, encoding } = entry.response.content;
  if (text === undefined) return null;
  return encoding === "base64" ? Buffer.from(text, "base64") : Buffer.from(text, "utf8");
}

function hasZeroTail(bytes: Buffer): boolean {
  if (bytes.length < 1024) return false;
  for (let i = bytes.length - 1024; i < bytes.length; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

function seqOfEntry(entry: DevtoolsHarEntry): number | null {
  const header = entry.response.headers.find((h) => h.name.toLowerCase() === "x-seq");
  if (header === undefined) return null;
  const n = Number(header.value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function verifyDevtoolsHar(
  harText: string,
  expect: DevtoolsVerifyExpectation,
): Promise<DevtoolsVerifyResult> {
  const problems: string[] = [];
  if (harText.length === 0) {
    return {
      entries: 0,
      exactBodies: 0,
      emptyHeaders: 0,
      emptyTimings: 0,
      unflaggedEmptyHeaders: 0,
      unflaggedEmptyTimings: 0,
      problems: ["0-byte HAR file"],
    };
  }
  let doc: DevtoolsHarDocument;
  try {
    doc = JSON.parse(harText) as DevtoolsHarDocument;
  } catch (error) {
    return {
      entries: 0,
      exactBodies: 0,
      emptyHeaders: 0,
      emptyTimings: 0,
      unflaggedEmptyHeaders: 0,
      unflaggedEmptyTimings: 0,
      problems: [`HAR is not valid JSON: ${String(error)}`],
    };
  }

  const invalid = await validateHar(harText);
  if (invalid !== null) problems.push(`har-validator failed: ${invalid}`);
  const entries = doc.log?.entries ?? [];
  const report = doc.log?._harExport?.report;
  if (report === undefined) problems.push("missing log._harExport.report");

  if (expect.entries !== undefined && entries.length !== expect.entries) {
    problems.push(`entries ${String(entries.length)} != expected ${String(expect.entries)}`);
  }
  if (expect.entriesMin !== undefined && entries.length < expect.entriesMin) {
    problems.push(`entries ${String(entries.length)} < minimum ${String(expect.entriesMin)}`);
  }

  if (expect.requireK6 !== false && expect.workDir !== undefined) {
    const tmpFile = NodePath.join(expect.workDir, `verify-${String(Date.now())}.har`);
    NodeFS.writeFileSync(tmpFile, harText, "utf8");
    const k6Ok = convertsWithK6(tmpFile, expect.workDir);
    NodeFS.rmSync(tmpFile, { force: true });
    if (!k6Ok) problems.push("har-to-k6 wrote no script");
  }

  let exactBodies = 0;
  let stubCount = 0;
  let unflaggedEmptyHeaders = 0;
  let unflaggedEmptyTimings = 0;
  let emptyHeadersCount = 0;
  let emptyTimingsCount = 0;
  let bothEmptyHeadersCount = 0;
  let bothEmptyTimingsCount = 0;
  const seenSeqs = new Set<number>();

  const hasValidTiming = (t: DevtoolsHarEntry["timings"]): boolean => {
    if (t === undefined) return false;
    return [t.blocked, t.dns, t.connect, t.ssl, t.send, t.wait, t.receive].some(
      (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
    );
  };

  for (const entry of entries) {
    const reqEmpty = entry.request.headers.length === 0;
    const resEmpty = entry.response.status > 0 && entry.response.headers.length === 0;
    const timingsEmpty = !hasValidTiming(entry.timings);
    if (reqEmpty || resEmpty) {
      emptyHeadersCount += 1;
      if (entry._harExport?.source === "both") bothEmptyHeadersCount += 1;
      if (entry._harExport?.headersMissing === undefined) unflaggedEmptyHeaders += 1;
    }
    if (timingsEmpty) {
      emptyTimingsCount += 1;
      if (entry._harExport?.source === "both") bothEmptyTimingsCount += 1;
      if (entry._harExport?.timingsMissing === undefined) unflaggedEmptyTimings += 1;
    }
    const url = entry.request.url;
    if (url.startsWith("data:")) {
      problems.push(`non-network data: URL written into entries: ${url.slice(0, 60)}`);
      continue;
    }
    if (expect.otherKey !== undefined && url.includes(expect.otherKey)) {
      problems.push(`entry from other tab leaked: ${url}`);
    }
    const parsedUrl = new URL(url);
    const name = parsedUrl.pathname.slice(1);
    const body = bodyOfEntry(entry);
    const seq = seqOfEntry(entry);
    if (seq !== null) {
      if (seenSeqs.has(seq)) problems.push(`duplicate X-Seq ${String(seq)} (${url})`);
      seenSeqs.add(seq);
    }

    const isStub =
      entry._harExport?.bodyState === "discarded" &&
      entry._harExport.bodyMissing === "devtools-discarded";
    if (isStub) stubCount += 1;

    if (name === "big.bin" && expect.expectTruncatedBig === true) {
      if (body !== null) {
        problems.push(`truncated big.bin emitted ${String(body.length)} bytes instead of omitting`);
      } else if (
        entry._harExport?.bodyState !== "size-limit" ||
        entry._harExport.bodyMissing !== "devtools-truncated"
      ) {
        problems.push(`truncated big.bin state wrong: ${JSON.stringify(entry._harExport ?? null)}`);
      }
      continue;
    }

    if (expect.stubs !== undefined && isStub) {
      continue;
    }

    if (
      expect.allowReloadExtraEntries === true &&
      entry._harExport?.source === "recording-only" &&
      (entry.response.status === 0 || entry._harExport?.bodyMissing !== undefined)
    ) {
      continue;
    }

    if (seq !== null && expect.server !== undefined) {
      const truth = expect.server.getSequenceTruth(seq);
      if (truth === undefined) {
        problems.push(`${url}: no server record for X-Seq ${String(seq)}`);
        continue;
      }
      if (body === null && truth.decodedLength > 0) {
        const missingReason = entry._harExport?.bodyMissing;
        const missingAllowed =
          expect.allowMissingReasons !== undefined &&
          missingReason !== undefined &&
          expect.allowMissingReasons.includes(missingReason) &&
          (expect.allowMissingUrlIncludes === undefined ||
            url.includes(expect.allowMissingUrlIncludes));
        if (!missingAllowed) {
          problems.push(
            `${url} #${String(seq)}: body missing (${JSON.stringify(entry._harExport ?? null)})`,
          );
        }
      } else {
        const got = body ?? Buffer.alloc(0);
        if (hasZeroTail(got)) {
          problems.push(`${url} #${String(seq)}: zero-padded tail (len=${String(got.length)})`);
        }
        if (sha256(got) !== truth.decodedSha256 || got.length !== truth.decodedLength) {
          problems.push(
            `${url} #${String(seq)}: body SHA/length mismatch (got=${String(got.length)} want=${String(truth.decodedLength)} size=${String(entry.response.content.size)} hx=${JSON.stringify(entry._harExport ?? null)})`,
          );
        } else if (entry.response.content.size !== truth.decodedLength) {
          problems.push(
            `${url} #${String(seq)}: content.size ${String(entry.response.content.size)} != ${String(truth.decodedLength)}`,
          );
        } else {
          exactBodies += 1;
        }
      }
    } else if (name in DEVTOOLS_GROUND_TRUTH) {
      const gt = DEVTOOLS_GROUND_TRUTH[name as keyof typeof DEVTOOLS_GROUND_TRUTH];
      if (body === null || sha256(body) !== gt.sha256 || body.length !== gt.size) {
        problems.push(`${name} body mismatch`);
      } else {
        exactBodies += 1;
      }
    } else if (name.startsWith("s/")) {
      const idx = Number(name.slice(2));
      const want = smallSlice(idx);
      if (body === null || !body.equals(want)) problems.push(`${name} small body wrong`);
      else exactBodies += 1;
    }

    if (name === "echo" && expect.stubs === undefined) {
      if (
        entry.request.postData?.text === undefined ||
        !entry.request.postData.text.includes('"hello"')
      ) {
        problems.push(`/echo missing JSON postData.text`);
      }
    }
    if (
      name === "form" &&
      expect.stubs === undefined &&
      entry._harExport?.source !== "recording-only"
    ) {
      if (expect.allowReloadExtraEntries === true) {
        const postText = entry.request.postData?.text ?? "";
        if (!postText.includes("a=1") || !postText.includes("b=two")) {
          problems.push(`/form missing body text: ${JSON.stringify(postText)}`);
        }
      } else {
        const params = entry.request.postData?.params ?? [];
        if (
          !params.some((p) => p.name === "a" && p.value === "1") ||
          !params.some((p) => p.name === "b" && p.value === "two")
        ) {
          problems.push(`/form missing parsed form params: ${JSON.stringify(params)}`);
        }
      }
    }
  }

  if (expect.expectedLog !== undefined) {
    for (const served of expect.expectedLog) {
      if (!seenSeqs.has(served.seq)) {
        problems.push(
          `missing served request ${served.method} ${served.url} #${String(served.seq)}`,
        );
      }
    }
  }

  if (expect.key !== undefined && !entries.some((e) => e.request.url.includes(expect.key!))) {
    problems.push(`no entry with key ${expect.key}`);
  }

  if (report !== undefined && expect.sources !== undefined) {
    if (expect.sources.both !== undefined && report.sources.both !== expect.sources.both) {
      problems.push(
        `sources.both ${String(report.sources.both)} != ${String(expect.sources.both)}`,
      );
    }
    if (
      expect.sources.recordingOnly !== undefined &&
      report.sources.recordingOnly !== expect.sources.recordingOnly
    ) {
      problems.push(
        `sources.recordingOnly ${String(report.sources.recordingOnly)} != ${String(expect.sources.recordingOnly)}`,
      );
    }
    if (
      expect.sources.devtoolsOnly !== undefined &&
      report.sources.devtoolsOnly !== expect.sources.devtoolsOnly
    ) {
      problems.push(
        `sources.devtoolsOnly ${String(report.sources.devtoolsOnly)} != ${String(expect.sources.devtoolsOnly)}`,
      );
    }
  }

  if (expect.requireDevtoolsSources === true && report !== undefined) {
    if (report.sources.both + report.sources.devtoolsOnly === 0) {
      problems.push("expected DevTools source items, got 0 both and 0 devtoolsOnly");
    }
  }

  if (expect.filledInMin !== undefined && report !== undefined) {
    if (report.bodies.response.filledIn < expect.filledInMin) {
      problems.push(
        `filledIn ${String(report.bodies.response.filledIn)} < ${String(expect.filledInMin)}`,
      );
    }
  }

  if (expect.stubs !== undefined && stubCount < expect.stubs.minCount) {
    problems.push(`stubs ${String(stubCount)} < ${String(expect.stubs.minCount)}`);
  }

  if (expect.requireHeadersAndTimings === true) {
    const missingHeaders =
      expect.allowReloadExtraEntries === true ? bothEmptyHeadersCount : emptyHeadersCount;
    const missingTimings =
      expect.allowReloadExtraEntries === true ? bothEmptyTimingsCount : emptyTimingsCount;
    if (missingHeaders > 0) {
      problems.push(`entries with empty headers: ${String(missingHeaders)} (expected 0)`);
    }
    if (missingTimings > 0) {
      problems.push(`entries with empty timings: ${String(missingTimings)} (expected 0)`);
    }
  }
  if (expect.checkMetadataFlags === true || expect.requireHeadersAndTimings === true) {
    if (unflaggedEmptyHeaders > 0) {
      problems.push(`unflagged entries with empty headers: ${String(unflaggedEmptyHeaders)}`);
    }
    if (unflaggedEmptyTimings > 0) {
      problems.push(`unflagged entries with empty timings: ${String(unflaggedEmptyTimings)}`);
    }
  }

  if (expect.stackUrlIncludes !== undefined) {
    const wantedFrames = expect.expectedFrames ?? DEVTOOLS_STACK_FRAMES;
    const match = entries.find((e) => e.request.url.includes(expect.stackUrlIncludes!));
    if (match === undefined) {
      problems.push(`no entry matching ${expect.stackUrlIncludes} for stack check`);
    } else {
      const names = (match._initiator?.stack?.callFrames ?? []).map((f) => f.functionName);
      for (const frame of wantedFrames) {
        if (!names.includes(frame)) {
          problems.push(`stack missing frame ${frame} (got ${JSON.stringify(names)})`);
        }
      }
    }
  }

  if (expect.notNetworkDataMin !== undefined && report !== undefined) {
    const count = report.notNetwork["data:"] ?? 0;
    if (count < expect.notNetworkDataMin) {
      problems.push(`notNetwork["data:"] ${String(count)} < ${String(expect.notNetworkDataMin)}`);
    }
    if (!(doc.log.comment ?? "").includes("non-network row")) {
      problems.push(`log.comment does not mention non-network row: ${String(doc.log.comment)}`);
    }
  }

  if (expect.expectedSourceTagForUrl !== undefined) {
    for (const rule of expect.expectedSourceTagForUrl) {
      const matching = entries.filter((e) => e.request.url.includes(rule.urlIncludes));
      if (matching.length === 0) {
        problems.push(`no entry matching ${rule.urlIncludes}`);
      }
      for (const m of matching) {
        if (m._harExport?.source !== rule.source) {
          problems.push(
            `${m.request.url} source ${String(m._harExport?.source)} != ${rule.source}`,
          );
        }
      }
    }
  }

  if (expect.disallowBothFromPrefix !== undefined) {
    for (const e of entries) {
      if (
        e.request.url.includes(expect.disallowBothFromPrefix) &&
        e._harExport?.source === "both"
      ) {
        problems.push(`older run request ${e.request.url} paired across restart`);
      }
    }
  }

  return {
    entries: entries.length,
    exactBodies,
    emptyHeaders: emptyHeadersCount,
    emptyTimings: emptyTimingsCount,
    unflaggedEmptyHeaders,
    unflaggedEmptyTimings,
    problems,
  };
}

/** Whether har-validator accepts the file, called directly rather than through `validateHar`. */
export async function harValidatorOk(harText: string): Promise<boolean> {
  try {
    await HarValidator.har(JSON.parse(harText));
    return true;
  } catch {
    return false;
  }
}

export const DEVTOOLS_FAULTS = {
  dropEntry: (harText: string): string => {
    const doc = JSON.parse(harText) as DevtoolsHarDocument;
    return JSON.stringify({ log: { ...doc.log, entries: doc.log.entries.slice(1) } });
  },
  emptyFile: (): string => "",
  zeroDevtoolsSources: (harText: string): string => {
    const doc = JSON.parse(harText) as DevtoolsHarDocument;
    const report = doc.log._harExport?.report;
    if (report === undefined) return harText;
    return JSON.stringify({
      log: {
        ...doc.log,
        _harExport: {
          ...doc.log._harExport,
          report: {
            ...report,
            sources: { both: 0, recordingOnly: report.requests, devtoolsOnly: 0 },
          },
        },
      },
    });
  },
  zeroPaddedBig: (harText: string): string => {
    const doc = JSON.parse(harText) as DevtoolsHarDocument;
    const entries = doc.log.entries.map((e) => {
      if (!e.request.url.includes("/big.bin")) return e;
      const buf = Buffer.alloc(50_000_000, 0);
      return {
        ...e,
        response: {
          ...e.response,
          content: { ...e.response.content, text: buf.toString("base64"), encoding: "base64" },
        },
      };
    });
    return JSON.stringify({ log: { ...doc.log, entries } });
  },
  unfilledBig: (harText: string): string => {
    const doc = JSON.parse(harText) as DevtoolsHarDocument;
    const report = doc.log._harExport?.report;
    if (report === undefined) return harText;
    return JSON.stringify({
      log: {
        ...doc.log,
        _harExport: {
          ...doc.log._harExport,
          report: {
            ...report,
            bodies: { ...report.bodies, response: { ...report.bodies.response, filledIn: 0 } },
          },
        },
      },
    });
  },
  dropStackFrame: (harText: string, urlIncludes: string): string => {
    const doc = JSON.parse(harText) as DevtoolsHarDocument;
    const entries = doc.log.entries.map((e) => {
      if (!e.request.url.includes(urlIncludes) || e._initiator?.stack === undefined) return e;
      return {
        ...e,
        _initiator: {
          ...e._initiator,
          stack: { callFrames: e._initiator.stack.callFrames.slice(1) },
        },
      };
    });
    return JSON.stringify({ log: { ...doc.log, entries } });
  },
  addDataEntry: (harText: string): string => {
    const doc = JSON.parse(harText) as DevtoolsHarDocument;
    const first = doc.log.entries[0];
    if (first === undefined) return harText;
    const bad = { ...first, request: { ...first.request, url: "data:image/png;base64,AA==" } };
    return JSON.stringify({ log: { ...doc.log, entries: [...doc.log.entries, bad] } });
  },
  dropNotNetworkCount: (harText: string): string => {
    const doc = JSON.parse(harText) as DevtoolsHarDocument;
    const report = doc.log._harExport?.report;
    if (report === undefined) return harText;
    return JSON.stringify({
      log: {
        ...doc.log,
        _harExport: {
          ...doc.log._harExport,
          report: { ...report, notNetwork: {} },
        },
      },
    });
  },
  pairAcrossRuns: (harText: string, urlIncludes: string): string => {
    const doc = JSON.parse(harText) as DevtoolsHarDocument;
    const entries = doc.log.entries.map((e) =>
      e.request.url.includes(urlIncludes)
        ? { ...e, _harExport: { ...e._harExport, source: "both" } }
        : e,
    );
    return JSON.stringify({ log: { ...doc.log, entries } });
  },
  wrongSourceCounts: (harText: string): string => {
    const doc = JSON.parse(harText) as DevtoolsHarDocument;
    const report = doc.log._harExport?.report;
    if (report === undefined) return harText;
    return JSON.stringify({
      log: {
        ...doc.log,
        _harExport: {
          ...doc.log._harExport,
          report: {
            ...report,
            sources: {
              ...report.sources,
              both: report.sources.both + 1,
            },
          },
        },
      },
    });
  },
  stripHeadersAndTimings: (harText: string): string => {
    const doc = JSON.parse(harText) as DevtoolsHarDocument;
    const entries = doc.log.entries.map((e) => ({
      ...e,
      request: { ...e.request, headers: [] },
      response: { ...e.response, headers: [] },
      timings: { send: -1, wait: -1, receive: -1 },
    }));
    return JSON.stringify({ log: { ...doc.log, entries } });
  },
  stripMetadataFlags: (harText: string): string => {
    const doc = JSON.parse(harText) as DevtoolsHarDocument;
    const entries = doc.log.entries.map((e) => {
      if (e._harExport === undefined) return e;
      const { headersMissing: _hm, timingsMissing: _tm, ...restHx } = e._harExport;
      return { ...e, _harExport: restHx };
    });
    return JSON.stringify({ log: { ...doc.log, entries } });
  },
} as const;
