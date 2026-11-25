import type { ReactNode } from "react";
import { PRESETS, type PresetId } from "@hark/export/selection";
import type { RecordingProblem } from "../../experiment/contract.ts";
import { Icon, type IconName } from "../ui/icon.tsx";
import { Mark } from "../ui/mark.tsx";
import {
  COPY,
  PRESET_COPY,
  PROBLEM_COPY,
  RANGE_COPY,
  SCOPE_COPY,
  SETTINGS_LINKS,
  sizeUpTo,
  sourceLine,
  unexaminedRequestBodiesNote,
  WRITE_FAILURE_COPY,
  writeFailureText,
} from "./copy.ts";
import { bytes, count, plural } from "./format.ts";
import {
  gaps,
  RANGES,
  RECORDING_PROBLEMS,
  SCOPES,
  unexaminedRequestBodies,
  unexpectedGaps,
  type Choices,
  type Gap,
  type PopupEvent,
  type PopupReading,
  type PopupView,
  type SettingsSection,
} from "./view.ts";

type Dispatch = (event: PopupEvent) => void;
type ViewOf<K extends PopupView["kind"]> = Extract<PopupView, { readonly kind: K }>;
type ScreenProps<K extends PopupView["kind"]> = {
  readonly view: ViewOf<K>;
  readonly dispatch: Dispatch;
};

const StatusIcon = ({
  tone,
  name,
}: {
  readonly tone: "ok" | "warn" | "err" | "info";
  readonly name: IconName;
}) => (
  <div className={`status-ic ${tone}`}>
    <Icon name={name} size={22} />
  </div>
);

const SettingsLink = ({
  section,
  dispatch,
}: {
  readonly section: SettingsSection;
  readonly dispatch: Dispatch;
}) => (
  <button
    type="button"
    className="btn-link"
    onClick={() => dispatch({ kind: "settings", section })}
  >
    {SETTINGS_LINKS[section]}
  </button>
);

const BackButton = ({
  dispatch,
  label,
}: {
  readonly dispatch: Dispatch;
  readonly label: string;
}) => (
  <button type="button" className="btn-link" onClick={() => dispatch({ kind: "back" })}>
    {label}
  </button>
);

const rowOf = (reading: PopupReading, id: PresetId) =>
  reading.rows.find((row) => row.id === id) ?? null;

const PresetRow = ({
  reading,
  id,
  primary,
  dispatch,
}: {
  readonly reading: PopupReading;
  readonly id: PresetId;
  readonly primary: boolean;
  readonly dispatch: Dispatch;
}) => {
  const copy = PRESET_COPY[id];
  const preview = rowOf(reading, id)?.preview ?? null;
  return (
    <li>
      <button
        type="button"
        className={primary ? "preset preset-primary" : "preset"}
        disabled={preview === null}
        onClick={() => dispatch({ kind: "row-clicked", row: id })}
      >
        <span className="p-ic">
          <Icon name={copy.icon} size={18} />
        </span>
        <span className="grow">
          <span className="p-t">{copy.title}</span>
          <span className="p-s">{copy.subtitle(reading.site)}</span>
        </span>
        {preview !== null && (
          <span className="p-n tn">
            <span>
              <b>{count(preview.requests)}</b> {preview.requests === 1 ? "request" : "requests"}
            </span>
            <span>{sizeUpTo(preview.bodyBytesAtMost)}</span>
          </span>
        )}
        <span className="p-dl">
          <Icon name="download" size={18} />
        </span>
      </button>
    </li>
  );
};

const PresetList = ({
  reading,
  ids,
  dispatch,
}: {
  readonly reading: PopupReading;
  readonly ids: readonly PresetId[];
  readonly dispatch: Dispatch;
}) => (
  <ul className="presets" aria-label={COPY.rowsLabel}>
    {ids.map((id, index) => (
      <PresetRow key={id} reading={reading} id={id} primary={index === 0} dispatch={dispatch} />
    ))}
  </ul>
);

const Toggles = ({
  choices,
  dispatch,
  legend,
}: {
  readonly choices: Choices;
  readonly dispatch: Dispatch;
  readonly legend: string | null;
}) => (
  <fieldset className="stack-s">
    {legend !== null && <legend className="fl">{legend}</legend>}
    <div className="row wrap">
      <label className="check">
        <input
          type="checkbox"
          checked={choices.bodies === "include"}
          onChange={(e) =>
            dispatch({
              kind: "choices-changed",
              choices: { ...choices, bodies: e.currentTarget.checked ? "include" : "omit" },
            })
          }
        />
        <span className="check-l">{COPY.bodies}</span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={choices.redaction !== "none"}
          onChange={(e) =>
            dispatch({
              kind: "choices-changed",
              choices: { ...choices, redaction: e.currentTarget.checked ? "standard" : "none" },
            })
          }
        />
        <span className="check-l">{COPY.secrets}</span>
      </label>
    </div>
    {choices.redaction === "none" && (
      <p className="warn-line">
        <Icon name="alert" />
        <span>{COPY.secretsKept}</span>
      </p>
    )}
  </fieldset>
);

const Warnings = ({
  problems,
  dispatch,
}: {
  readonly problems: readonly RecordingProblem[];
  readonly dispatch: Dispatch;
}) => (
  <>
    {problems
      .filter((p) => !RECORDING_PROBLEMS[p].blocking)
      .map((p) => (
        <p key={p} className="warn-line">
          <Icon name="alert" />
          <span>
            {PROBLEM_COPY[p].text}{" "}
            {PROBLEM_COPY[p].settings !== null && (
              <SettingsLink section={PROBLEM_COPY[p].settings} dispatch={dispatch} />
            )}
          </span>
        </p>
      ))}
  </>
);

const Source = ({ reading }: { readonly reading: PopupReading }) => {
  const line = sourceLine(reading);
  return (
    <p className="src">
      <Icon name={line.icon} />
      <span>{line.text(reading.site)}</span>
    </p>
  );
};

const LastExport = ({
  reading,
  dispatch,
}: {
  readonly reading: PopupReading;
  readonly dispatch: Dispatch;
}) =>
  reading.last === null ? null : (
    <p className="meta row">
      <span className="grow wrap-any">
        {COPY.lastExport}: <span className="fname">{reading.last.fileName}</span>
      </span>
      <button type="button" className="btn-link" onClick={() => dispatch({ kind: "show-last" })}>
        {COPY.showResult}
      </button>
    </p>
  );

const Heading = () => (
  <div>
    <h1 className="title">{COPY.heading}</h1>
    <p className="meta">{COPY.headingHelp}</p>
  </div>
);

const ALL_ROWS: readonly PresetId[] = PRESETS.map((p) => p.id);

const Ready = ({ view, dispatch }: ScreenProps<"ready">) => (
  <div className="pad stack">
    <Heading />
    <Warnings problems={view.reading.problems} dispatch={dispatch} />
    <PresetList reading={view.reading} ids={ALL_ROWS} dispatch={dispatch} />
    <Source reading={view.reading} />
    <hr className="divider" />
    <Toggles choices={view.choices} dispatch={dispatch} legend={COPY.appliesTo} />
    <button
      type="button"
      className="btn-link"
      onClick={() => dispatch({ kind: "custom-opened", now: Date.now() })}
    >
      {COPY.custom}
    </button>
    <LastExport reading={view.reading} dispatch={dispatch} />
  </div>
);

const NoTab = ({ view, dispatch }: ScreenProps<"no-tab">) => (
  <div className="pad stack">
    <div className="row top">
      <StatusIcon tone="info" name="tab" />
      <div className="grow">
        <h1 className="title">{COPY.noTabTitle}</h1>
        <p className="muted">{COPY.noTabText}</p>
      </div>
    </div>
    <PresetList
      reading={view.reading}
      ids={ALL_ROWS.filter((id) => rowOf(view.reading, id)?.preview != null)}
      dispatch={dispatch}
    />
    <hr className="divider" />
    <Toggles choices={view.choices} dispatch={dispatch} legend={COPY.appliesTo} />
    <LastExport reading={view.reading} dispatch={dispatch} />
  </div>
);

const ElsewhereCard = ({
  reading,
  label,
  dispatch,
}: {
  readonly reading: PopupReading;
  readonly label: string;
  readonly dispatch: Dispatch;
}) => {
  const everything = rowOf(reading, "everything")?.preview ?? null;
  if (everything === null || everything.requests === 0) return null;
  return (
    <div className="card stack-s">
      <p className="meta">{label}</p>
      <div className="row">
        <span className="grow tn">
          <b>{count(everything.requests)}</b> {everything.requests === 1 ? "request" : "requests"},{" "}
          <span className="nowrap">{sizeUpTo(everything.bodyBytesAtMost)}</span>
        </span>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => dispatch({ kind: "row-clicked", row: "everything" })}
        >
          <Icon name="download" />
          {COPY.exportEverything}
        </button>
      </div>
    </div>
  );
};

const EmptyTab = ({ view, dispatch }: ScreenProps<"empty-tab">) => (
  <div className="pad stack">
    <div className="row top">
      <StatusIcon tone="info" name={view.reading.gate === "excluded-site" ? "lock" : "clock"} />
      <div className="grow">
        <h1 className="title">{COPY.emptyTabTitle}</h1>
        <p className="muted">
          {view.reading.gate === "excluded-site"
            ? sourceLine(view.reading).text(view.reading.site)
            : COPY.emptyTabText}
        </p>
        {view.reading.gate === "excluded-site" && (
          <SettingsLink section="sites" dispatch={dispatch} />
        )}
      </div>
    </div>
    <Warnings problems={view.reading.problems} dispatch={dispatch} />
    <ElsewhereCard reading={view.reading} label={COPY.otherTabs} dispatch={dispatch} />
    <LastExport reading={view.reading} dispatch={dispatch} />
  </div>
);

const EmptyPrivate = ({ view, dispatch }: ScreenProps<"empty-private">) => (
  <div className="pad stack">
    <div className="row top">
      <StatusIcon tone="info" name="incognito" />
      <div className="grow">
        <h1 className="title">{COPY.emptyPrivateTitle}</h1>
        <p className="muted">{COPY.emptyPrivateText}</p>
      </div>
    </div>
    <ElsewhereCard reading={view.reading} label={COPY.normalWindows} dispatch={dispatch} />
  </div>
);

const ErrorStore = ({ view, dispatch }: ScreenProps<"error-store">) => {
  const devtools = view.reading.devtools === "open";
  const problem = PROBLEM_COPY[view.problem];
  return (
    <div className="pad stack">
      <div className="row top">
        <StatusIcon tone="err" name="alert-circle" />
        <div className="grow">
          <h1 className="title">{COPY.storeTitle}</h1>
          <p className="muted">{problem.text}</p>
        </div>
      </div>
      {devtools ? (
        <div className="callout callout-info">
          <Icon name="code" />
          <p>{COPY.storeDevtools}</p>
        </div>
      ) : (
        <p className="meta">{COPY.storeNoDevtools}</p>
      )}
      <div className="btns">
        {devtools && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => dispatch({ kind: "row-clicked", row: "this-tab-everything" })}
          >
            <Icon name="download" />
            {COPY.exportDevtools}
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => dispatch({ kind: "reload" })}
        >
          <Icon name="refresh" />
          {COPY.checkAgain}
        </button>
      </div>
      {problem.settings !== null && <SettingsLink section={problem.settings} dispatch={dispatch} />}
    </div>
  );
};

const Custom = ({ view, dispatch }: ScreenProps<"custom">) => {
  const draft = view.draft;
  const change = (patch: Partial<typeof draft>) =>
    dispatch({ kind: "draft-changed", draft: { ...draft, ...patch } });
  const ranges = RANGES.filter((r) => !r.tabOnly || draft.scope === "tab");
  return (
    <div className="pad stack">
      <div className="row">
        <button
          type="button"
          className="iconbtn back"
          aria-label={COPY.back}
          title={COPY.back}
          onClick={() => dispatch({ kind: "back" })}
        >
          <Icon name="chevron-left" size={18} />
        </button>
        <h1 className="title">{COPY.customTitle}</h1>
      </div>
      <fieldset>
        <legend className="fl">{COPY.scope}</legend>
        <div className="seg">
          {SCOPES.map((scope) => (
            <label key={scope.id}>
              <input
                type="radio"
                name="scope"
                checked={draft.scope === scope.id}
                disabled={scope.raw(view.reading) === null}
                onChange={() => change({ scope: scope.id })}
              />
              <span>{SCOPE_COPY[scope.id]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="span-grid">
        <label htmlFor="custom-range" className="fl">
          {COPY.range}
        </label>
        <select
          id="custom-range"
          className="ctl"
          value={draft.range}
          onChange={(e) => change({ range: e.currentTarget.value as typeof draft.range })}
        >
          {ranges.map((r) => (
            <option key={r.id} value={r.id}>
              {RANGE_COPY[r.id]}
            </option>
          ))}
        </select>
        {draft.range === "between" && (
          <>
            <label htmlFor="custom-from" className="fl">
              {COPY.from}
            </label>
            <input
              id="custom-from"
              className="ctl"
              type="datetime-local"
              value={draft.from}
              onChange={(e) => change({ from: e.currentTarget.value })}
            />
            <label htmlFor="custom-to" className="fl">
              {COPY.to}
            </label>
            <input
              id="custom-to"
              className="ctl"
              type="datetime-local"
              value={draft.to}
              onChange={(e) => change({ to: e.currentTarget.value })}
            />
          </>
        )}
        <label htmlFor="custom-name" className="fl">
          {COPY.fileName}
        </label>
        <input
          id="custom-name"
          className="ctl"
          type="text"
          value={draft.fileName}
          placeholder={COPY.fileNamePlaceholder}
          spellCheck={false}
          onChange={(e) => change({ fileName: e.currentTarget.value })}
        />
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.include === "fetch-and-xhr"}
          onChange={(e) => change({ include: e.currentTarget.checked ? "fetch-and-xhr" : "all" })}
        />
        <span>
          <span className="check-l">{COPY.onlyApi}</span>
          <span className="help">{COPY.onlyApiHelp}</span>
        </span>
      </label>
      <Toggles choices={view.choices} dispatch={dispatch} legend={null} />
      <p className="row" aria-live="polite">
        {!view.check.ok ? (
          <span className="danger-text">
            {view.check.problem === "range" ? COPY.badRange : COPY.badFileName}
          </span>
        ) : view.preview === null ? (
          <span className="muted">{COPY.counting}</span>
        ) : (
          <span className="grow tn">
            <b>{count(view.preview.requests)}</b>{" "}
            {view.preview.requests === 1 ? "request" : "requests"},{" "}
            <span className="nowrap">{sizeUpTo(view.preview.bodyBytesAtMost)}</span>
          </span>
        )}
      </p>
      <button
        type="button"
        className="btn btn-primary btn-lg"
        disabled={!view.check.ok}
        onClick={() => dispatch({ kind: "custom-export" })}
      >
        <Icon name="download" size={18} />
        {COPY.exportButton}
      </button>
    </div>
  );
};

const Exporting = ({ view, dispatch }: ScreenProps<"exporting">) => {
  const { done, total, bytes: written } = view.progress;
  const percent = total === 0 ? 0 : Math.min(100, Math.floor((done / total) * 100));
  return (
    <div className="pad stack">
      <div>
        <h1 className="title">{COPY.exportingTitle}</h1>
        <p className="fname">{view.job.fileName}</p>
      </div>
      <div className="stack-s">
        <div
          className="meter"
          role="progressbar"
          aria-label={COPY.exportingTitle}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <i style={{ width: `${String(percent)}%` }} />
        </div>
        <div className="row tn">
          <span>
            {total === 0
              ? COPY.collecting
              : `${count(done)} of ${plural(total, "request", "requests")}`}
          </span>
          <span className="right muted">{String(percent)}%</span>
        </div>
        <p className="meta tn">{bytes(written)} written</p>
      </div>
      <p className="src">
        <Icon name="info" />
        <span>{COPY.keepsRunning}</span>
      </p>
      <div className="btns">
        <button
          type="button"
          className="btn btn-secondary"
          autoFocus
          onClick={() => dispatch({ kind: "cancel" })}
        >
          {COPY.cancel}
        </button>
      </div>
    </div>
  );
};

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const gapText = (gap: Gap): string =>
  `${gap.place === "request" ? "Request bodies: " : ""}${capitalize(`${gap.cutShort ? "cut short, " : ""}${gap.label}`)}.`;

const GapRow = ({ gap, dispatch }: { readonly gap: Gap; readonly dispatch: Dispatch }) => (
  <li className="row top">
    <b className="tn gn">{count(gap.count)}</b>{" "}
    <span className="grow">
      {gapText(gap)}{" "}
      {gap.settings !== null && <SettingsLink section={gap.settings} dispatch={dispatch} />}
    </span>
  </li>
);

const Done = ({ view, dispatch }: ScreenProps<"done">) => {
  const report = view.saved.report;
  const list = gaps(report);
  const missing = unexpectedGaps(list);
  const unexamined = unexaminedRequestBodies(report);
  const response = report.bodies.response;
  return (
    <div className="pad stack">
      <div className="row top">
        <StatusIcon
          tone={missing === 0 ? "ok" : "warn"}
          name={missing === 0 ? "check-circle" : "alert"}
        />
        <div className="grow">
          <h1 className="title">
            {missing === 0
              ? COPY.saved
              : `${COPY.saved} with ${plural(missing, "body", "bodies")} missing`}
          </h1>
          <p className="file wrap-any">{view.saved.fileName}</p>
          <p className="meta wrap-any">
            {COPY.savedIn} {view.saved.folderLabel}
          </p>
        </div>
      </div>
      <div className="btns">
        <button
          type="button"
          className="btn btn-primary"
          autoFocus
          onClick={() => dispatch({ kind: "reveal" })}
        >
          <Icon name="folder" />
          {COPY.showInFolder}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => dispatch({ kind: "copy-path" })}
        >
          <Icon name="copy" />
          {COPY.copyPath}
        </button>
      </div>
      <p className="meta notice" aria-live="polite">
        {view.notice === null ? null : view.notice === "copied" ? COPY.copied : COPY.gone}
      </p>
      <dl className="kv card">
        <dt>Requests</dt>
        <dd>{count(report.requests)}</dd>
        <dt>Response bodies</dt>
        <dd>
          {count(response.included + response.empty)} of {count(report.requests)}
        </dd>
        <dt>File size</dt>
        <dd>{bytes(report.fileBytes)}</dd>
        <dt>Secrets</dt>
        <dd>{report.redaction.choice === "none" ? "Kept" : "Removed"}</dd>
      </dl>
      {unexamined > 0 && (
        <p className="warn-line">
          <Icon name="alert" />
          <span>{unexaminedRequestBodiesNote(unexamined, count(unexamined))}</span>
        </p>
      )}
      {list.length === 0 ? (
        <p className="meta">{COPY.nothingMissing}</p>
      ) : (
        <>
          <ul className="gaps" aria-label={COPY.missingLabel}>
            {list.map((gap) => (
              <GapRow
                key={`${gap.place}-${gap.label}-${String(gap.cutShort)}`}
                gap={gap}
                dispatch={dispatch}
              />
            ))}
          </ul>
          <p className="meta">{COPY.whyInFile}</p>
        </>
      )}
      <BackButton dispatch={dispatch} label={COPY.exportAnother} />
    </div>
  );
};

const ErrorWrite = ({ view, dispatch }: ScreenProps<"error-write">) => {
  const failure = view.failed.failure;
  const settings = WRITE_FAILURE_COPY[failure.kind].settings;
  return (
    <div className="pad stack">
      <div className="row top">
        <StatusIcon tone="err" name="alert-circle" />
        <div className="grow">
          <h1 className="title">
            {view.failed.unconfirmed ? COPY.writeUnconfirmedTitle : COPY.writeTitle}
          </h1>
          <p className="muted">
            {view.failed.unconfirmed ? COPY.writeUnconfirmed : writeFailureText(failure)}
          </p>
        </div>
      </div>
      <div className="callout callout-ok">
        <Icon name="check-circle" />
        <p>{COPY.recordingSafe}</p>
      </div>
      <div className="btns">
        <button
          type="button"
          className="btn btn-primary"
          autoFocus
          onClick={() => dispatch({ kind: "retry", bodies: view.job.request.bodies })}
        >
          <Icon name="refresh" />
          {COPY.tryAgain}
        </button>
        {failure.kind === "disk-full" && view.job.request.bodies === "include" && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => dispatch({ kind: "retry", bodies: "omit" })}
          >
            {COPY.tryWithoutBodies}
          </button>
        )}
      </div>
      <div className="row wrap">
        {settings !== null && <SettingsLink section={settings} dispatch={dispatch} />}
        <BackButton dispatch={dispatch} label={COPY.back} />
      </div>
    </div>
  );
};

const ApiMissing = () => (
  <div className="pad stack">
    <div className="row top">
      <StatusIcon tone="err" name="plug" />
      <div className="grow">
        <h1 className="title">{COPY.apiMissingTitle}</h1>
        <p className="muted">{COPY.apiMissing}</p>
      </div>
    </div>
    <p className="meta">{COPY.apiMissingNote}</p>
  </div>
);

const SCREENS: { readonly [K in PopupView["kind"]]: (props: ScreenProps<K>) => ReactNode } = {
  "api-missing": ApiMissing,
  ready: Ready,
  "no-tab": NoTab,
  "empty-tab": EmptyTab,
  "empty-private": EmptyPrivate,
  "error-store": ErrorStore,
  custom: Custom,
  exporting: Exporting,
  done: Done,
  "error-write": ErrorWrite,
};

export const Popup = ({
  view,
  dispatch,
}: {
  readonly view: PopupView;
  readonly dispatch: Dispatch;
}) => {
  const Screen = SCREENS[view.kind] as (props: ScreenProps<PopupView["kind"]>) => ReactNode;
  return (
    <div className="popup" data-view={view.kind}>
      <header className="hdr">
        <div className="brand">
          <Mark />
          Hark
        </div>
        {view.kind !== "api-missing" && (
          <button
            type="button"
            className="iconbtn"
            aria-label={COPY.history}
            title={COPY.history}
            onClick={() => dispatch({ kind: "history" })}
          >
            <Icon name="history" size={18} />
          </button>
        )}
        {view.kind !== "api-missing" && (
          <button
            type="button"
            className="iconbtn"
            aria-label={COPY.settings}
            title={COPY.settings}
            onClick={() => dispatch({ kind: "settings", section: "storage" })}
          >
            <Icon name="sliders" size={18} />
          </button>
        )}
      </header>
      <main>
        <Screen view={view} dispatch={dispatch} />
      </main>
    </div>
  );
};
