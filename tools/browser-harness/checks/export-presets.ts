import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import {
  convertsWithK6,
  checkExport,
  EXPORT_FAULTS,
  withDataRow,
  withoutCreator,
  withSecretInTitle,
  validateHar,
  type TruthServer,
} from "../src/export-verify.ts";
import {
  ended,
  newestPageTab,
  openExtensionPage,
  startExport,
  value,
  waitForJob,
} from "../src/export-session.ts";
import { recordingWorkspace } from "../src/recording-session.ts";
import { startFixtureServer } from "../src/server.ts";

const NAME = "export-presets";
const SECRET = "SECRETNAVTOKEN7f3a";

/** The popup's rows for tab A on site A, written out here rather than read from the product. */
const presets = (tabId: number, site: string) =>
  [
    {
      id: "this-tab-everything",
      selection: { scope: "tab", tabId, range: { kind: "since-tab-opened" }, include: "all" },
      sites: ["a"],
    },
    {
      id: "this-tab-recent",
      selection: { scope: "tab", tabId, range: { kind: "last", minutes: 15 }, include: "all" },
      sites: ["a"],
    },
    {
      id: "this-site",
      selection: { scope: "site", site, range: { kind: "everything" }, include: "all" },
      sites: ["a"],
    },
    {
      id: "everything",
      selection: { scope: "everything", range: { kind: "everything" }, include: "all" },
      sites: ["a", "b"],
    },
  ] as const;

type Popup = {
  readonly rows: readonly {
    readonly id: string;
    readonly preview: { readonly requests: number } | null;
  }[];
};

/**
 * Tab A on 127.0.0.1 (secret in its URL, a 20 MB gzip body, a POST) and tab B on localhost, each preset exported from
 * the extension's page: exactly the servers' logged requests, bodies at their decoded SHA-256, the popup's count, no
 * secret anywhere, valid for har-validator and har-to-k6. Each deliberately broken copy is reported: a flipped byte,
 * a dropped entry, a gzip size at its wire size, the secret in a title, a data: row, no creator.
 */
const check: HarnessCheck = {
  name: NAME,
  description:
    "each preset exported through the API is byte-exact against the servers, counted, redacted and convertible",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    const result = (problems: readonly string[], detail: string, data?: unknown): CheckResult => ({
      name: NAME,
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail: problems.length === 0 ? detail : problems.join("; "),
      data,
    });
    if (context.extensionPath === null) return result(["needs --extension"], "");
    await using a = await startFixtureServer();
    await using b = await startFixtureServer();
    await using workspace = recordingWorkspace("export-presets");
    const servers: readonly TruthServer[] = [
      { host: `127.0.0.1:${String(a.port)}`, server: a },
      { host: `localhost:${String(b.port)}`, server: b },
    ];
    const hostOf = { a: servers[0]!.host, b: servers[1]!.host } as const;
    await using session = await workspace.launch({
      binaryPath: context.binaryPath,
      extensionPath: context.extensionPath,
      display: context.display,
      protocol: "marionette",
      signal: context.signal,
    });
    const page = await openExtensionPage(session, context.extensionPath);
    const tabA = await session.openTab(`http://${hostOf.a}/?access_token=${SECRET}`);
    await session.evaluate(
      tabA,
      `Promise.all([fetch("/fixtures/gzip").then((r) => r.arrayBuffer()), fetch("/fixtures/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: 1 }) }).then((r) => r.arrayBuffer())]).then(() => "done")`,
    );
    const tabAId = await newestPageTab(page);
    await session.openTab(`http://${hostOf.b}/`);

    const problems: string[] = [];
    const rows: unknown[] = [];
    let tabFile: string | null = null;
    for (const preset of presets(tabAId, "127.0.0.1")) {
      const popup = await value<Popup>(page, `browser.hark.getPopup({ tabId: ${String(tabAId)} })`);
      const previewCount = popup.rows.find((row) => row.id === preset.id)?.preview?.requests ?? -1;
      const job = await startExport(page, {
        selection: preset.selection,
        bodies: "include",
        redaction: "standard",
        packaging: "har",
        fileName: `preset-${preset.id}`,
      });
      const finished = await waitForJob(page, job.id, ended);
      if (finished.state.kind !== "done") {
        problems.push(`${preset.id}: ${JSON.stringify(finished.state)}`);
        continue;
      }
      const file = NodePath.join(workspace.downloads, finished.state.fileName);
      const text = NodeFS.readFileSync(file, "utf8");
      const verdict = checkExport(text, {
        servers,
        hosts: preset.sites.map((site) => hostOf[site]),
        previewCount,
        secret: SECRET,
      });
      problems.push(...verdict.problems.map((p) => `${preset.id}: ${p}`));
      const invalid = await validateHar(text);
      if (invalid !== null) problems.push(`${preset.id}: har-validator: ${invalid}`);
      const k6 = convertsWithK6(file, workspace.downloads);
      if (!k6) problems.push(`${preset.id}: har-to-k6 wrote no script`);
      rows.push({
        preset: preset.id,
        previewCount,
        entries: verdict.entries,
        exact: verdict.exact,
        bytes: text.length,
        k6,
      });
      if (preset.id === "this-tab-everything") tabFile = file;
    }

    const caught: string[] = [];
    if (tabFile !== null) {
      const text = NodeFS.readFileSync(tabFile, "utf8");
      const expectation = {
        servers,
        hosts: [hostOf.a],
        previewCount: (JSON.parse(text) as { log: { entries: unknown[] } }).log.entries.length,
        secret: SECRET,
      };
      for (const breakage of EXPORT_FAULTS) {
        const broken = JSON.stringify(breakage.alter(JSON.parse(text)));
        if (checkExport(broken, expectation).problems.length === 0)
          problems.push(`a copy with ${breakage.name} was not reported`);
        else caught.push(breakage.name);
      }
      if (checkExport(withSecretInTitle(text, SECRET), expectation).problems.length === 0)
        problems.push("the secret in a page title was not reported");
      else caught.push("the secret in a page title");
      const dataRow = NodePath.join(workspace.downloads, "broken-data-row.har");
      NodeFS.writeFileSync(dataRow, withDataRow(text));
      if (convertsWithK6(dataRow, workspace.downloads))
        problems.push("a data: row converted with har-to-k6");
      else caught.push("a data: row har-to-k6 rejects");
      if ((await validateHar(withoutCreator(text))) === null)
        problems.push("a log without its creator passed har-validator");
      else caught.push("a log without its creator");
    }
    return result(
      problems,
      `${rows.map((r) => JSON.stringify(r)).join(" ")}; broken copies reported: ${caught.join(", ")}`,
      { rows, caught },
    );
  },
};

/** @discovered-check */
export default check;
