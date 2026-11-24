// Run as `node --expose-gc test/heap-runner.ts <body bytes> <whole body: true|false>`. Collects garbage at every sink write and keeps the largest heap still in
// use, so the number is what the export holds on to, not what the collector has not yet freed.

import { runFake } from "./fake-ports.ts";
import { importAltered } from "./alter.ts";

export interface HeapRun {
  readonly bodyBytes: number;
  readonly retainedGrowthBytes: number;
  readonly fileBytes: number;
  readonly error: string | null;
}

declare const gc: () => void;

async function measureRetainedHeap(bodyBytes: number, wholeBody: boolean): Promise<HeapRun> {
  const run = wholeBody
    ? (
        await importAltered<typeof import("../src/run.ts")>("run.ts", {
          id: "whole-body-in-memory",
          from: "export const BODY_WINDOW_BYTES = BODY_CHUNK_BYTES;",
          to: "export const BODY_WINDOW_BYTES = 4_000_000_000;",
        })
      ).runExport
    : undefined;
  gc();
  const start = process.memoryUsage();
  const baseline = start.heapUsed + start.arrayBuffers;
  let peak = baseline;
  const result = await runFake({
    rows: [
      {
        id: 1,
        url: "https://heap.example/body",
        recording: { body: { kind: "generated", total: bodyBytes, chunk: 1_048_573, seed: 11 } },
      },
    ],
    keepText: false,
    onPoint: () => {
      gc();
      const m = process.memoryUsage();
      peak = Math.max(peak, m.heapUsed + m.arrayBuffers);
    },
    ...(run ? { runExport: run } : {}),
  });
  return {
    bodyBytes,
    retainedGrowthBytes: peak - baseline,
    fileBytes: result.bytes,
    error: result.error === null ? null : String(result.error),
  };
}

const [bytes, whole] = process.argv.slice(2);
console.log(JSON.stringify(await measureRetainedHeap(Number(bytes), whole === "true")));
