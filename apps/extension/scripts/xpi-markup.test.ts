import { describe, expect, it } from "vite-plus/test";
import { readMarkup } from "./xpi-markup.ts";

const decoder = new TextDecoder();

const bodiesOf = (html: string) =>
  readMarkup(html, "page").bodies.map(({ where, kind, bytes }) => [
    where,
    kind,
    decoder.decode(bytes),
  ]);

describe("readMarkup", () => {
  it("finds every script and style a page runs, decoded as the browser decodes it", () => {
    const html = [
      "<!DOCTYPE html><html><body>",
      '<script>a()</script><script src="/x.js"></script><style>b{c:d}</style>',
      `<button onclick="e(&quot;f&quot;)" style="g:h">i</button>`,
      `<a href="&#x09;JaVa&Tab;Script&NewLine;:j(%27k%27)">l</a>`,
      `<script src="data:text/javascript;base64,${Buffer.from("m()").toString("base64")}"></script>`,
      `<link rel="stylesheet" href="data:text/css,n%7Bo:p%7D">`,
      `<iframe srcdoc="&lt;script&gt;q()&lt;/script&gt;"></iframe>`,
      "</body></html>",
    ].join("");
    expect(bodiesOf(html).toSorted()).toEqual(
      [
        ["<script>", "script", "a()"],
        ["<style>", "style", "b{c:d}"],
        ["<button onclick>", "script", 'e("f")'],
        ["<button style>", "style-attribute", "g:h"],
        ["<a href> javascript: URL", "script", "j('k')"],
        ["<script src> data: URL", "script", "m()"],
        ["<link href> data: URL", "style", "n{o:p}"],
        ["<iframe srcdoc>", "markup", "<script>q()</script>"],
      ].toSorted(),
    );
  });

  it("ends a script only at a real end tag", () => {
    expect(bodiesOf("<!DOCTYPE html><script>1</script_x>2</script>")).toEqual([
      ["<script>", "script", "1</script_x>2"],
    ]);
  });

  it("reads nothing from a relative URL, a plain link or a data: URL of an unread type", () => {
    expect(
      bodiesOf('<!DOCTYPE html><a href="/javascript:x">a</a><img src="data:image/gif,GIF89a">'),
    ).toEqual([]);
  });

  it("knows a page by its doctype or html tag, and a vector by its svg element", () => {
    expect(readMarkup("<!DOCTYPE html><p>x</p>", "page").hasRoot).toBe(true);
    expect(readMarkup("<html><p>x</p></html>", "page").hasRoot).toBe(true);
    expect(readMarkup("var a=1;", "page").hasRoot).toBe(false);
    expect(readMarkup('<svg viewBox="0 0 1 1"><g/></svg>\n', "vector").hasRoot).toBe(true);
    expect(readMarkup('<g xmlns="http://www.w3.org/2000/svg"/>', "vector").hasRoot).toBe(false);
  });

  it("reads a vector as XML, so text a browser's XML parser rejects cannot be read", () => {
    expect(() => readMarkup("var a=1;", "vector")).toThrow(/^1:8: text data outside of root node/);
    expect(() =>
      readMarkup("<svg><style>@media (width<=14px){a{b:c}}</style></svg>", "vector"),
    ).toThrow(/^1:2\d: /);
    const cdata = readMarkup(
      "<svg><style><![CDATA[@media (width<=14px){a{b:c}}]]></style></svg>",
      "vector",
    );
    expect(cdata.bodies.map(({ kind }) => kind)).toEqual(["vector-style"]);
  });

  it("counts comments and line-break layout inside a vector, not a trailing newline", () => {
    const flat = readMarkup("<svg><rect/><rect/></svg>\n", "vector");
    expect([flat.comments, flat.layoutBreaks]).toEqual([[], 0]);
    const pretty = readMarkup("<svg>\n  <!-- mark -->\n  <rect/>\n</svg>", "vector");
    expect([pretty.comments, pretty.layoutBreaks]).toEqual([[" mark "], 3]);
  });
});
