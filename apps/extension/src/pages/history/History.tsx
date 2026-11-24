import type { ExportJob } from "@hark/export/jobs";
import type { Session, SiteSummary } from "@hark/recording/activity";
import type { Site } from "@hark/recording/ids";
import { sizeUpTo, writeFailureText } from "../../popup/copy.ts";
import { bytes, count, limitLabel, plural } from "../../popup/format.ts";
import { Icon } from "../../ui/icon.tsx";
import { PageHeader } from "../../ui/page.tsx";
import {
  byDay,
  lastWeek,
  matching,
  sessionKey,
  timeSpan,
  totals,
  type HistoryState,
} from "./model.ts";
import type { HistoryStore } from "./store.ts";

export const HISTORY_TITLE = "Hark history";

type Props = { readonly state: HistoryState; readonly store: HistoryStore };

const SiteList = ({ state, store }: Props) => {
  const sites = matching(state.sites ?? [], state.search);
  return (
    <ul className="sites">
      {sites.map((s) => (
        <li key={s.site}>
          <button
            type="button"
            className="site-btn"
            aria-current={s.site === state.site ? "true" : undefined}
            onClick={() => store.showSite(s.site)}
          >
            <Icon name="globe" />
            <span className="grow wrap-any">{s.site}</span>
            <span className="tn meta">{count(s.requests)}</span>
          </button>
        </li>
      ))}
      {sites.length === 0 && <li className="meta">No site matches.</li>}
    </ul>
  );
};

const Storage = ({ state }: { readonly state: HistoryState }) => {
  if (state.settings === null) return null;
  const used = state.settings.usage.bodyBytes;
  const limit = state.settings.user.retention.maxBodyBytes;
  const percent = Math.min(100, Math.round((used / limit) * 100));
  return (
    <div className="storage stack-s">
      <p className="meta tn">
        {bytes(used)} of {limitLabel(limit)} used
      </p>
      <div
        className="meter"
        role="progressbar"
        aria-label="Storage used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <i style={{ width: `${String(percent)}%` }} />
      </div>
    </div>
  );
};

const DayChart = ({ summary, now }: { readonly summary: SiteSummary; readonly now: number }) => {
  const week = lastWeek(summary.days, now);
  const most = Math.max(1, ...week.map((d) => d.requests));
  const said = week.map((d) => `${d.day} ${count(d.requests)}`).join(", ");
  return (
    <div className="week">
      <p className="eyebrow">Requests per day, last 7 days</p>
      <div className="daychart" role="img" aria-label={`Requests per day: ${said}`}>
        {week.map((d) => (
          <i
            key={d.day}
            className={d.today ? "on" : undefined}
            style={{ height: `${String(Math.max(2, Math.round((d.requests / most) * 48)))}px` }}
          />
        ))}
      </div>
      <div className="dlabels tn" aria-hidden="true">
        {week.map((d) => (
          <span key={d.day}>{d.day}</span>
        ))}
      </div>
    </div>
  );
};

const SessionRow = ({
  session,
  day,
  state,
  store,
}: Props & { readonly session: Session; readonly day: string }) => {
  const span = timeSpan(session);
  return (
    <li className="sess">
      <label className="check">
        <input
          type="checkbox"
          checked={state.ticked.has(sessionKey(session))}
          onChange={() => store.toggle(session)}
          aria-label={`Select ${session.site}, ${day} ${span}`}
          data-site={session.site}
          data-from={session.from}
        />
      </label>
      <span className="grow">
        <b className="tn">{span}</b>
        <span className="meta">{plural(session.tabs, "tab", "tabs")}</span>
      </span>
      <span className="tn muted nowrap">
        {plural(session.requests, "request", "requests")}, {sizeUpTo(session.bodyBytesAtMost)}
      </span>
      <button
        type="button"
        className="btn btn-secondary"
        aria-label={`Export ${session.site}, ${day} ${span}`}
        onClick={() => store.exportSession(session)}
      >
        <Icon name="download" />
        Export
      </button>
    </li>
  );
};

const Confirm = ({
  site,
  summary,
  store,
}: {
  readonly site: Site;
  readonly summary: SiteSummary | undefined;
  readonly store: HistoryStore;
}) => (
  <div className="callout callout-warn confirm" role="alertdialog" aria-labelledby="confirm-title">
    <Icon name="alert" />
    <div className="grow stack-s">
      <p id="confirm-title">
        <b>Stop recording {site} and delete what is recorded for it?</b>
      </p>
      <p>
        {summary === undefined
          ? "Everything recorded for this site is deleted."
          : `${plural(summary.requests, "request", "requests")} and ${sizeUpTo(summary.bodyBytesAtMost)} of bodies are deleted.`}{" "}
        This cannot be undone. Files you already exported are not affected.
      </p>
      <div className="row">
        <button type="button" className="btn btn-danger" onClick={store.confirmExclude}>
          <Icon name="trash" />
          Exclude and delete
        </button>
        <button type="button" className="btn btn-secondary" onClick={store.cancelExclude}>
          Cancel
        </button>
      </div>
    </div>
  </div>
);

const JobLine = ({
  job,
  notice,
  store,
}: {
  readonly job: ExportJob;
  readonly notice: HistoryState["notice"];
  readonly store: HistoryStore;
}) => {
  switch (job.state.kind) {
    case "writing":
      return (
        <p className="meta tn job" role="status">
          Exporting {job.fileName}: {count(job.state.done)} of {count(job.state.total)} requests
        </p>
      );
    case "done":
      return (
        <div className="callout callout-ok job" role="status">
          <Icon name="check-circle" />
          <div className="grow stack-s">
            <p>
              Saved <span className="file wrap-any">{job.state.fileName}</span> in{" "}
              {job.state.folderLabel}, {plural(job.state.report.requests, "request", "requests")}.
            </p>
            <div className="row">
              <button type="button" className="btn btn-secondary" onClick={store.reveal}>
                <Icon name="folder" />
                Show in folder
              </button>
              <button type="button" className="btn btn-secondary" onClick={store.copyPath}>
                <Icon name="copy" />
                Copy path
              </button>
              {notice !== null && (
                <span className="meta">
                  {notice === "copied" ? "Path copied." : "The file is no longer there."}
                </span>
              )}
            </div>
          </div>
        </div>
      );
    case "cancelled":
      return <p className="meta job">The export was cancelled.</p>;
    case "write-failed":
      return (
        <div className="callout callout-warn job" role="status">
          <Icon name="alert" />
          <p>
            The export did not finish. {writeFailureText(job.state.failure)} The recording is
            unchanged.
          </p>
        </div>
      );
  }
};

const SelectionBar = ({ state, store }: Props) => {
  const sum = totals(state.ticked.values());
  const writing = state.job?.state.kind === "writing";
  return (
    <div className="selbar">
      <p className="grow tn" id="selection-summary">
        {sum.sessions === 0 ? (
          <span className="muted">
            Tick sessions on any site to export them together as one file.
          </span>
        ) : (
          <>
            <b>
              {plural(sum.sessions, "session", "sessions")} on {plural(sum.sites, "site", "sites")}{" "}
              selected
            </b>
            , {plural(sum.requests, "request", "requests")}, {sizeUpTo(sum.bytesAtMost)}
          </>
        )}
      </p>
      <button
        type="button"
        className="btn btn-primary"
        disabled={sum.sessions === 0 || writing}
        aria-describedby="selection-summary"
        onClick={store.exportTicked}
      >
        <Icon name="download" />
        Export as one file
      </button>
    </div>
  );
};

const SiteView = ({ state, store, summary }: Props & { readonly summary: SiteSummary }) => {
  const sessions = state.sessions;
  const now = state.readAt;
  return (
    <>
      <div className="row site-hd">
        <div className="grow">
          <h2 className="site-name wrap-any">{summary.site}</h2>
          <p className="muted tn">
            {sessions === null
              ? "Loading sessions"
              : plural(sessions.length, "session", "sessions")}
            , {plural(summary.requests, "request", "requests")}, {sizeUpTo(summary.bodyBytesAtMost)}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => store.exportSite(summary.site)}
        >
          <Icon name="download" />
          Export site
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => store.askExclude(summary.site)}
          disabled={state.confirming === summary.site}
        >
          <Icon name="x" />
          Exclude site
        </button>
      </div>
      {state.confirming === summary.site && (
        <Confirm site={summary.site} summary={summary} store={store} />
      )}
      <DayChart summary={summary} now={now} />
      {sessions !== null &&
        byDay(sessions, now).map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h3 className="eyebrow day">{group.label}</h3>
            <ul>
              {group.sessions.map((session) => (
                <SessionRow
                  key={sessionKey(session)}
                  session={session}
                  day={group.label}
                  state={state}
                  store={store}
                />
              ))}
            </ul>
          </section>
        ))}
    </>
  );
};

/** The history page: sites on the left, the chosen site's sessions on the right, and one export for every tick. */
export const History = ({ state, store }: Props) => {
  const summary = state.sites?.find((s) => s.site === state.site);
  const view =
    state.failed !== null
      ? "failed"
      : state.sites === null
        ? "loading"
        : state.sites.length === 0
          ? "empty"
          : "sites";
  return (
    <div className="page" data-view={view}>
      <PageHeader title={HISTORY_TITLE}>
        <a className="btn btn-secondary" href="/options/index.html">
          <Icon name="sliders" />
          Settings
        </a>
      </PageHeader>
      <div className="hist">
        <aside className="hist-side">
          <label className="field">
            <span className="fl">Search sites</span>
            <input
              className="ctl"
              type="search"
              value={state.search}
              onChange={(event) => store.search(event.currentTarget.value)}
            />
          </label>
          <SiteList state={state} store={store} />
          <Storage state={state} />
        </aside>
        <main className="hist-main stack">
          {state.excluded !== null && (
            <div className="callout callout-ok" role="status">
              <Icon name="check-circle" />
              <p>
                {state.excluded} is excluded. What was recorded for it is deleted, and nothing more
                is recorded for it.
              </p>
            </div>
          )}
          {state.failed !== null && (
            <div className="callout callout-warn" role="alert">
              <Icon name="alert" />
              <div className="stack-s">
                <p>
                  <b>The history could not be read.</b> {state.failed}
                </p>
                <button type="button" className="btn btn-secondary" onClick={store.retry}>
                  <Icon name="refresh" />
                  Try again
                </button>
              </div>
            </div>
          )}
          {view === "empty" && (
            <div className="callout callout-info">
              <Icon name="info" />
              <p>
                Nothing is recorded yet. Every tab is recorded in the background while the browser
                is open, and its sites show up here.
              </p>
            </div>
          )}
          {summary !== undefined && <SiteView state={state} store={store} summary={summary} />}
          {state.job !== null && <JobLine job={state.job} notice={state.notice} store={store} />}
          <SelectionBar state={state} store={store} />
        </main>
      </div>
    </div>
  );
};
