import { describe, expect, it } from "vite-plus/test";
import { decodeAsciiBase64, encodeAsciiBase64 } from "./ascii-base64.ts";
import { buildHar } from "../src/build.ts";
import { toHarUrl, toIsoDateTime, toMimeType } from "../src/model.ts";
import { parseHar } from "../src/parse.ts";
import { redactHar } from "../src/redact.ts";

const makePost = (mimeType: string, text: string, extraPostData: Record<string, unknown> = {}) =>
  buildHar({
    creator: { name: "Test", version: "1" },
    entries: [
      {
        startedDateTime: toIsoDateTime("2026-11-24T00:00:00.000Z")!,
        request: {
          method: "POST",
          url: toHarUrl("https://api.example/submit")!,
          postData: {
            mimeType: toMimeType(mimeType) ?? mimeType,
            params: [],
            text,
            ...extraPostData,
          },
        },
        response: { status: 200 },
      },
    ],
  });

describe("standard request.postData.text redaction", () => {
  it("redacts form-urlencoded secret fields, populates params, and preserves non-secret params", () => {
    const doc = makePost(
      "application/x-www-form-urlencoded; charset=utf-8",
      "password=hunter2&user=bob&clientSecret=cs_123",
    );
    const { document, report } = redactHar(doc, { level: "standard" });
    const postData = document.log.entries[0]!.request.postData!;
    const serialized = JSON.stringify(document);

    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("cs_123");
    expect(postData.text).toBe("password=%5BREDACTED%5D&user=bob&clientSecret=%5BREDACTED%5D");
    expect(postData.params).toEqual([
      { name: "password", value: "[REDACTED]" },
      { name: "user", value: "bob" },
      { name: "clientSecret", value: "[REDACTED]" },
    ]);
    expect(report.totalRemoved).toBe(2);
    expect(report.entriesAffected).toBe(1);
    expect(report.rules).toEqual(["body:secrets"]);
    expect(report.notInspected).not.toContain("body-form");
    expect(parseHar(document).ok).toBe(true);
  });

  it("redacts JSON bodies recursively at any depth for application/json and +json", () => {
    const doc = makePost(
      "application/problem+json",
      JSON.stringify({
        client_secret: "s3cr3t",
        nested: { access_token: "t0k", list: [{ PASSWORD: "deep_pw" }, { label: "keep" }] },
        ok: true,
      }),
    );
    const { document, report } = redactHar(doc, { level: "standard" });
    const postData = document.log.entries[0]!.request.postData!;
    const serialized = JSON.stringify(document);

    expect(serialized).not.toContain("s3cr3t");
    expect(serialized).not.toContain("t0k");
    expect(serialized).not.toContain("deep_pw");
    expect(JSON.parse(postData.text!)).toEqual({
      client_secret: "[REDACTED]",
      nested: { access_token: "[REDACTED]", list: [{ PASSWORD: "[REDACTED]" }, { label: "keep" }] },
      ok: true,
    });
    expect(report.totalRemoved).toBe(3);
    expect(report.notInspected).not.toContain("body-json");
  });

  it("handles invalid or truncated JSON gracefully and marks body-json in notExamined and notInspected", () => {
    const doc = makePost("application/json", '{"password":"partial_secret"');
    const { document, report } = redactHar(doc, { level: "standard" });
    expect(document.log.entries[0]!.request.postData!.text).toBe('{"password":"partial_secret"');
    expect(report.notInspected).toContain("body-json");
    expect(report.notExamined.map((p) => p.place)).toContain("body-json");
    expect(report.places.find((p) => p.place === "body-json")?.status).toBe("kept-not-examined");
  });

  it("redacts multipart/form-data parts matching SECRET_PARAMETER_NAMES while preserving boundaries and non-secret parts", () => {
    const body = [
      "--bound42",
      'Content-Disposition: form-data; name="PASSWORD"',
      "",
      "mp_secret",
      "--bound42",
      'Content-Disposition: form-data; name="note"',
      "Content-Type: text/plain",
      "",
      "hello",
      "--bound42",
      'Content-Disposition: form-data; name="upload"; filename="password.txt"',
      "Content-Type: application/octet-stream",
      "",
      "file-bytes",
      "--bound42--",
      "",
    ].join("\r\n");

    const doc = makePost('multipart/form-data; boundary="bound42"', body);
    const { document, report } = redactHar(doc, { level: "standard" });
    const redactedText = document.log.entries[0]!.request.postData!.text!;

    expect(redactedText).not.toContain("mp_secret");
    expect(redactedText).toContain(
      '--bound42\r\nContent-Disposition: form-data; name="PASSWORD"\r\n\r\n[REDACTED]\r\n--bound42',
    );
    expect(redactedText).toContain("hello");
    expect(redactedText).toContain("file-bytes");
    expect(redactedText.endsWith("--bound42--\r\n")).toBe(true);
    expect(report.totalRemoved).toBe(1);
    expect(report.notInspected).not.toContain("body-multipart");
  });

  it("redacts base64-encoded multipart bodies while preserving binary parts", () => {
    const raw =
      '--b1\r\nContent-Disposition: form-data; name="secret"\r\n\r\ntop_sec\r\n--b1\r\nContent-Disposition: form-data; name="bin"; filename="a.bin"\r\n\r\nBIN\r\n--b1--';
    const doc = makePost("multipart/form-data; boundary=b1", encodeAsciiBase64(raw), {
      encoding: "base64",
    });
    const { document } = redactHar(doc, { level: "standard" });
    const out = decodeAsciiBase64(document.log.entries[0]!.request.postData!.text!);
    expect(out).not.toContain("top_sec");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("BIN");
  });

  it("keeps request-body-other unexamined without corrupting custom payloads", () => {
    const doc = makePost("application/octet-stream", "custom-binary-payload");
    const { document, report } = redactHar(doc, { level: "standard" });
    expect(document.log.entries[0]!.request.postData!.text).toBe("custom-binary-payload");
    expect(report.notInspected).toContain("request-body-other");
    expect(report.places.find((p) => p.place === "request-body-other")?.count).toBe(1);
  });
});
