// Calls `browser.hark` the way extension pages do: from a tab showing the extension's own page, with the
// moz-extension principal. Arguments and results cross as JSON, as they do for a real page.

import {
  readExtensionId,
  readExtensionPopupPath,
  waitForActiveExtensionUrl,
  type BrowserSession,
} from "./browser.ts";

export type ExtensionPage = { readonly session: BrowserSession; readonly tab: string };

/** The fields of an export job the checks read. */
export type Job = {
  readonly id: string;
  readonly fileName: string;
  readonly state:
    | {
        readonly kind: "writing";
        readonly done: number;
        readonly total: number;
        readonly bytes: number;
      }
    | {
        readonly kind: "done";
        readonly fileName: string;
        readonly report: { readonly requests: number };
      }
    | { readonly kind: "cancelled" }
    | {
        readonly kind: "write-failed";
        readonly failure: {
          readonly kind: string;
          readonly needBytes?: number;
          readonly freeBytes?: number;
        };
      };
};

export type Called<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const DEADLINE_MS = 120_000;

export async function openExtensionPage(
  session: BrowserSession,
  extensionPath: string,
): Promise<ExtensionPage> {
  const url = await waitForActiveExtensionUrl(
    session,
    await readExtensionId(extensionPath),
    await readExtensionPopupPath(extensionPath),
  );
  return { session, tab: await session.openTab(url) };
}

/** `expression` runs in the extension page; its value comes back, or the error the page saw. */
export async function call<T>(page: ExtensionPage, expression: string): Promise<Called<T>> {
  const answer = await page.session.evaluate(
    page.tab,
    `(async () => {
      try { return JSON.stringify({ ok: true, value: await (${expression}) }); }
      catch (error) { return JSON.stringify({ ok: false, error: String(error) }); }
    })()`,
  );
  return JSON.parse(answer) as Called<T>;
}

export async function value<T>(page: ExtensionPage, expression: string): Promise<T> {
  const called = await call<T>(page, expression);
  if (!called.ok) throw new Error(`${expression}: ${called.error}`);
  return called.value;
}

/** The newest tab the extension cannot read the URL of, which is the newest web page tab. */
export async function newestPageTab(page: ExtensionPage): Promise<number> {
  const tabs = await value<{ id: number; url?: string }[]>(page, "browser.tabs.query({})");
  return Math.max(...tabs.filter((tab) => tab.url === undefined).map((tab) => tab.id));
}

export const startExport = (page: ExtensionPage, request: unknown): Promise<Job> =>
  value<Job>(page, `browser.hark.startExport(${JSON.stringify(request)})`);

/** Reads listExports until the job satisfies `until`. */
export async function waitForJob(
  page: ExtensionPage,
  id: string,
  until: (job: Job) => boolean,
): Promise<Job> {
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    const job = (await value<Job[]>(page, "browser.hark.listExports()")).find((j) => j.id === id);
    if (job === undefined) throw new Error(`export ${id} is not listed`);
    if (until(job)) return job;
    if (Date.now() > deadline) throw new Error(`export ${id} still ${JSON.stringify(job.state)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export const ended = (job: Job): boolean => job.state.kind !== "writing";
