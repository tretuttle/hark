import * as NodeCrypto from "node:crypto";
import type { AnsweredExchange } from "@hark/recording/exchange";
import { ID_ENDLESS_CHUNK } from "./extended-fixtures.ts";
import { responseHeader, type ExpectedBody } from "./recording-verify.ts";
import type { FixtureServer, SequenceTruth } from "./server.ts";

/**
 * What a stored body must hash to, from the server's own record of what it sent: the X-Seq of the response, or for a
 * merged 304 the 200 it revalidated (the bytes come from that response). A body cut at the cap must be the stream's
 * first bytes. null when the server has no complete record.
 */
export const expectedFromServer =
  (server: Pick<FixtureServer, "getSequenceTruth" | "getAllSequenceTruth">) =>
  (exchange: AnsweredExchange): ExpectedBody | null => {
    const seq = Number(responseHeader(exchange, "x-seq"));
    const truth = Number.isInteger(seq) ? server.getSequenceTruth(seq) : undefined;
    if (truth === undefined) return null;
    if (exchange.body.kind === "stored" && exchange.body.check === "first-part") {
      return truth.path === "/id/endless" ? endlessPrefix(exchange.body.at.length) : null;
    }
    const source = truth.status === 304 ? revalidated(server.getAllSequenceTruth(), truth) : truth;
    return source === undefined || source.aborted
      ? null
      : { sha256: source.wireSha256, length: source.wireBytesSent };
  };

const revalidated = (
  all: ReadonlyMap<number, SequenceTruth>,
  notModified: SequenceTruth,
): SequenceTruth | undefined =>
  [...all.values()]
    .filter((t) => t.path === notModified.path && t.status === 200 && t.seq < notModified.seq)
    .toSorted((a, b) => b.seq - a.seq)[0];

export const endlessPrefix = (length: number): ExpectedBody => {
  const whole = Math.ceil(length / ID_ENDLESS_CHUNK.length);
  const bytes = Buffer.concat(Array.from({ length: whole }, () => ID_ENDLESS_CHUNK)).subarray(
    0,
    length,
  );
  return { sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"), length };
};

/** For a body the page itself received and the server has no record of, such as a service worker's own response. */
export const expectedFromText = (text: string): ExpectedBody => {
  const bytes = Buffer.from(text, "utf8");
  return {
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    length: bytes.length,
  };
};
