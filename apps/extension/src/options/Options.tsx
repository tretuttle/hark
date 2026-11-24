import type { ReactNode } from "react";
import type { RecordingProblem, SettingsView } from "../../experiment/contract.ts";
import { PROBLEM_COPY, SETTINGS_LINKS } from "../popup/copy.ts";
import type { SettingsSection } from "../popup/view.ts";
import { bytes, limitLabel, plural } from "../popup/format.ts";
import { Icon, type IconName } from "../ui/icon.tsx";
import { PageHeader } from "../ui/page.tsx";
import { BODY_LIMITS, choicesWith, KEEP_DAYS, REFUSED_COPY, type OptionsState } from "./model.ts";
import type { OptionsStore } from "./store.ts";

export const OPTIONS_TITLE = "Hark settings";

type Props = { readonly state: OptionsState; readonly store: OptionsStore };

/**
 * A popup link opens this page at a section's id, but the browser looks for it before the sections render. The
 * sections render together once settings are read, so the linked one is scrolled to then, once per page load.
 */
let landed = false;
const landOn = (section: HTMLElement | null): void => {
  if (landed || section === null || `#${section.id}` !== window.location.hash) return;
  landed = true;
  section.scrollIntoView({ block: "start" });
};
type Ready = Props & { readonly settings: SettingsView };

const Section = ({
  id,
  title,
  lead,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly lead?: string;
  readonly children: ReactNode;
}) => (
  <section className="section" id={id} aria-labelledby={`${id}-title`} ref={landOn}>
    <h2 id={`${id}-title`}>{title}</h2>
    {lead !== undefined && <p className="lead">{lead}</p>}
    {children}
  </section>
);

const Radio = ({
  name,
  checked,
  label,
  help,
  onPick,
}: {
  readonly name: string;
  readonly checked: boolean;
  readonly label: string;
  readonly help: string;
  readonly onPick: () => void;
}) => (
  <label className="check">
    <input type="radio" name={name} checked={checked} onChange={onPick} />
    <span>
      <span className="check-l">{label}</span>
      <span className="help">{help}</span>
    </span>
  </label>
);

/** Read-only. Nothing on this page, or anywhere in the add-on, turns the recording off. */
const Status = ({ id, title, state }: Heading & { readonly state: OptionsState }) => {
  const problems = state.status?.problems ?? [];
  const on = state.status?.recording ?? false;
  return (
    <Section id={id} title={title}>
      <div className={`callout status-block ${on ? "callout-ok" : "callout-warn"}`} role="status">
        <Icon name={on ? "check-circle" : "alert"} />
        <div className="stack-s">
          <p>
            <b>{on ? "Recording is on" : "Recording is stopped"}</b>
          </p>
          <p>
            Recording runs whenever the browser is open and cannot be turned off. Private windows
            are never recorded.
          </p>
        </div>
      </div>
      {problems.length > 0 && (
        <ul className="stack-s problems">
          {problems.map((problem) => {
            const section = PROBLEM_COPY[problem].settings;
            return (
              <li key={problem} className="warn-line">
                <Icon name="alert" />
                <span>
                  {PROBLEM_COPY[problem].text}{" "}
                  {section !== null && <a href={`#${section}`}>{SETTINGS_LINKS[section]}</a>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
};

const Storage = ({ id, title, settings, store }: Ready & Heading) => {
  const { retention } = settings.user;
  const used = settings.usage.bodyBytes;
  const percent = Math.min(100, Math.round((used / retention.maxBodyBytes) * 100));
  return (
    <Section
      id={id}
      title={title}
      lead="The oldest data is removed first when a limit is reached. A removed body leaves its request in place, marked as removed."
    >
      <div className="stack-s narrow">
        <p className="row tn">
          <b>{bytes(used)}</b>
          <span className="muted">
            of {limitLabel(retention.maxBodyBytes)} used by response bodies
          </span>
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
        <p className="meta tn">Request details use {bytes(settings.usage.detailBytes)}.</p>
      </div>
      <div className="fields">
        <label className="field">
          <span className="fl">Storage limit for response bodies</span>
          <select
            className="ctl"
            value={retention.maxBodyBytes}
            onChange={(event) =>
              store.save({ name: "maxBodyBytes", value: Number(event.currentTarget.value) })
            }
          >
            {choicesWith(BODY_LIMITS, retention.maxBodyBytes).map((n) => (
              <option key={n} value={n}>
                {limitLabel(n)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="fl">Keep data for</span>
          <select
            className="ctl"
            value={retention.maxAgeDays}
            onChange={(event) =>
              store.save({ name: "maxAgeDays", value: Number(event.currentTarget.value) })
            }
          >
            {choicesWith(KEEP_DAYS, retention.maxAgeDays).map((n) => (
              <option key={n} value={n}>
                {plural(n, "day", "days")}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Section>
  );
};

const Sites = ({ id, title, state, settings, store }: Ready & Heading) => (
  <Section
    id={id}
    title={title}
    lead="Requests to these sites are not recorded. Excluding a site also deletes what is already recorded for it."
  >
    <ul className="list-rows narrow">
      {settings.user.excludedSites.map((site) => (
        <li key={site}>
          <span className="grow wrap-any">{site}</span>
          <button type="button" className="btn btn-secondary" onClick={() => store.include(site)}>
            Record again
          </button>
        </li>
      ))}
      {settings.user.excludedSites.length === 0 && <li className="muted">No site is excluded.</li>}
    </ul>
    <form
      className="row narrow add-site"
      onSubmit={(event) => {
        event.preventDefault();
        store.askExclude();
      }}
    >
      <label className="grow field">
        <span className="fl">Site to exclude</span>
        <input
          className="ctl"
          type="text"
          placeholder="example.com"
          value={state.draft}
          aria-invalid={state.draftInvalid}
          onChange={(event) => store.typeSite(event.currentTarget.value)}
        />
      </label>
      <button type="submit" className="btn btn-secondary" disabled={state.confirming !== null}>
        <Icon name="plus" />
        Exclude
      </button>
    </form>
    {state.draftInvalid && (
      <p className="danger-text" role="alert">
        Enter a site name such as example.com.
      </p>
    )}
    {state.confirming !== null && (
      <div
        className="callout callout-warn confirm narrow"
        role="alertdialog"
        aria-labelledby="exclude-title"
      >
        <Icon name="alert" />
        <div className="grow stack-s">
          <p id="exclude-title">
            <b>Stop recording {state.confirming} and delete what is recorded for it?</b>
          </p>
          <p>This cannot be undone. Files you already exported are not affected.</p>
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
    )}
  </Section>
);

const Media = ({ id, title, settings, store }: Ready & Heading) => (
  <Section
    id={id}
    title={title}
    lead="Streams can fill storage fast. Their requests and timings are always recorded."
  >
    <fieldset className="stack-s narrow">
      <legend className="sr">Audio and video bodies</legend>
      <Radio
        name="media"
        checked={settings.user.media === "details-only"}
        label="Record details only"
        help="Keep the request, headers and timings. Do not keep the body."
        onPick={() => store.save({ name: "media", value: "details-only" })}
      />
      <Radio
        name="media"
        checked={settings.user.media === "keep-bodies"}
        label="Keep bodies"
        help="Can use many GB in one session."
        onPick={() => store.save({ name: "media", value: "keep-bodies" })}
      />
    </fieldset>
  </Section>
);

const Secrets = ({ id, title, settings, store }: Ready & Heading) => (
  <Section
    id={id}
    title={title}
    lead="Cookie, Set-Cookie and Authorization headers, and request bodies, can hold passwords and login tokens."
  >
    <fieldset className="stack-s narrow">
      <legend className="sr">Secret values</legend>
      <Radio
        name="secrets"
        checked={settings.user.secretStorage === "store"}
        label="Store them"
        help="Exports remove them unless you turn off Remove secrets."
        onPick={() => store.save({ name: "secretStorage", value: "store" })}
      />
      <Radio
        name="secrets"
        checked={settings.user.secretStorage === "never-store"}
        label="Never store them"
        help="They are dropped when a request is recorded, so no export can contain them."
        onPick={() => store.save({ name: "secretStorage", value: "never-store" })}
      />
    </fieldset>
  </Section>
);

const Defaults = ({ id, title, state, settings, store }: Ready & Heading) => {
  const defaults = settings.user.exportDefaults;
  const where = settings.exportTo;
  return (
    <Section id={id} title={title} lead="What an export uses until you change it in the popup.">
      <div className="stack narrow">
        <div>
          <span className="fl" id="folder-label">
            Export folder
          </span>
          <div className="row">
            <p className="grow folder-name" aria-labelledby="folder-label">
              <Icon name="folder" />
              <span className="wrap-any">
                {where.kind === "downloads" ? "The browser's Downloads folder" : where.label}
              </span>
            </p>
            <button type="button" className="btn btn-secondary" onClick={store.chooseFolder}>
              Choose folder
            </button>
            {where.kind === "chosen" && (
              <button type="button" className="btn btn-secondary" onClick={store.useDownloads}>
                Use Downloads
              </button>
            )}
          </div>
          {state.refused !== null && (
            <div className="callout callout-warn refused" role="alert">
              <Icon name="alert" />
              <p>
                <b>That folder was not chosen.</b> {REFUSED_COPY[state.refused]}
              </p>
            </div>
          )}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={defaults.bodies === "include"}
            onChange={(event) =>
              store.save({
                name: "bodies",
                value: event.currentTarget.checked ? "include" : "omit",
              })
            }
          />
          <span className="check-l">Include response bodies</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={defaults.secrets === "remove"}
            onChange={(event) =>
              store.save({
                name: "secrets",
                value: event.currentTarget.checked ? "remove" : "keep",
              })
            }
          />
          <span>
            <span className="check-l">Remove secrets</span>
            <span className="help">
              Cookie, Set-Cookie and Authorization headers, and tokens in URLs.
            </span>
          </span>
        </label>
      </div>
    </Section>
  );
};

/** A section that explains a recording problem and says what the user can do. */
const ProblemSection = ({
  id,
  title,
  problem,
  explanation,
  steps,
  state,
}: Heading & {
  readonly problem: RecordingProblem;
  readonly explanation: string;
  readonly steps: readonly string[];
  readonly state: OptionsState;
}) => (
  <Section id={id} title={title}>
    <div className="stack-s narrow">
      {state.status?.problems.includes(problem) === true && (
        <div className="callout callout-warn" role="status">
          <Icon name="alert" />
          <p>This is happening now.</p>
        </div>
      )}
      <p>{explanation}</p>
      <h3 className="eyebrow">What you can do</h3>
      <ul className="steps">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ul>
    </div>
  </Section>
);

type PageSection = "status" | SettingsSection;

/** A section's element id and its title, which the side menu also shows. */
type Heading = { readonly id: PageSection; readonly title: string };

type SectionSpec = { readonly title: string; readonly icon: IconName } & (
  | { readonly kind: "status" }
  /**
   * Edits settings. Settings live beside the recording, so while it is stopped the section keeps its id and title
   * and says why it cannot be changed: the popup still links here when the archive is refused.
   */
  | { readonly kind: "settings"; readonly Body: (props: Ready & Heading) => ReactNode }
  /** Shown only while the status reports its problem, or when the page was opened at it. */
  | {
      readonly kind: "problem";
      readonly problem: RecordingProblem;
      readonly explanation: string;
      readonly steps: readonly string[];
    }
);

/**
 * Every section of the page, in page order, keyed by its element id. The keys are every SettingsSection, so a popup
 * link to a section this page lacks fails typecheck.
 */
const SECTIONS: { readonly [S in PageSection]: SectionSpec } = {
  status: { kind: "status", title: "Status", icon: "check-circle" },
  storage: { kind: "settings", title: "Storage", icon: "database", Body: Storage },
  "export-holding": {
    kind: "problem",
    title: "Over the limit while exporting",
    icon: "alert",
    problem: "over-cap-while-exporting",
    explanation:
      "An export keeps the recorded data it reads until it has written its file, so while it runs the recording can grow past the storage limit. When the export ends, the oldest data is removed again until the recording is under the limit. Files you already exported are not affected.",
    steps: [
      "Wait for the export to finish. The popup shows its progress.",
      "If you do not need that export, cancel it in the popup.",
      "If the recording uses more disk than you want, lower the storage limit above.",
    ],
  },
  "unreadable-files": {
    kind: "problem",
    title: "Files skipped at startup",
    icon: "alert",
    problem: "archive-entries-unreadable",
    explanation:
      "When the browser started, some files in the recording folder could not be read, so they were skipped. Requests stored in them are not offered for export. Everything else is recorded and exported as usual.",
    steps: [
      "Check that the disk holding the recording is connected and working.",
      "Check that no other program or user changed the permissions of the recording folder.",
      "Restart the browser to read the folder again.",
    ],
  },
  sites: { kind: "settings", title: "Excluded sites", icon: "globe", Body: Sites },
  media: { kind: "settings", title: "Audio and video", icon: "play", Body: Media },
  secrets: { kind: "settings", title: "Secrets", icon: "lock", Body: Secrets },
  folder: { kind: "settings", title: "Export defaults", icon: "download", Body: Defaults },
};

const ORDER = Object.keys(SECTIONS) as PageSection[];

/** The section the page was opened at, as a popup link opens it. Read once, before the first render. */
const OPENED_AT = window.location.hash.slice(1);

const showing = (id: PageSection, state: OptionsState): boolean => {
  const spec = SECTIONS[id];
  return (
    spec.kind !== "problem" ||
    id === OPENED_AT ||
    state.status?.problems.includes(spec.problem) === true
  );
};

const PageSectionBody = ({ id, state, store }: Props & { readonly id: PageSection }) => {
  const spec = SECTIONS[id];
  const heading: Heading = { id, title: spec.title };
  switch (spec.kind) {
    case "status":
      return <Status {...heading} state={state} />;
    case "problem":
      return (
        <ProblemSection
          {...heading}
          problem={spec.problem}
          explanation={spec.explanation}
          steps={spec.steps}
          state={state}
        />
      );
    case "settings":
      return state.settings === null ? (
        <Section {...heading}>
          <p className="muted">
            This setting is stored with the recording, so it can be changed only while recording is
            on.
          </p>
        </Section>
      ) : (
        <spec.Body {...heading} state={state} settings={state.settings} store={store} />
      );
  }
};

export const Options = ({ state, store }: Props) => (
  <div
    className="page"
    data-view={
      state.reading.kind !== "read"
        ? state.reading.kind
        : state.settings === null
          ? "stopped"
          : "ready"
    }
  >
    <PageHeader title={OPTIONS_TITLE}>
      {state.saved !== null && (
        <span className={state.saved === "saved" ? "meta" : "danger-text"} role="status">
          {state.saved === "saved" ? "Saved." : "The change was not saved. Try again."}
        </span>
      )}
      <a className="btn btn-secondary" href="/pages/history.html">
        <Icon name="history" />
        History
      </a>
    </PageHeader>
    <div className="nav-layout page-body">
      <nav className="sidenav" aria-label="Sections">
        {ORDER.filter((id) => showing(id, state)).map((id) => (
          <a key={id} href={`#${id}`}>
            <Icon name={SECTIONS[id].icon} />
            {SECTIONS[id].title}
          </a>
        ))}
      </nav>
      <div>
        {state.reading.kind === "failed" && (
          <div className="callout callout-warn" role="alert">
            <Icon name="alert" />
            <div className="stack-s">
              <p>
                <b>The settings could not be read.</b> {state.reading.message}
              </p>
              <button type="button" className="btn btn-secondary" onClick={store.read}>
                <Icon name="refresh" />
                Try again
              </button>
            </div>
          </div>
        )}
        {state.reading.kind === "read" &&
          ORDER.filter((id) => showing(id, state)).map((id) => (
            <PageSectionBody key={id} id={id} state={state} store={store} />
          ))}
      </div>
    </div>
  </div>
);
