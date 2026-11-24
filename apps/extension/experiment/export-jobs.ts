// The export slot: jobs run one at a time, in the parent process, and outlive the popup that started them. Pure: the
// host passes the run, the clock and the id source.

import type {
  ExportId,
  ExportJob,
  ExportRequest,
  ExportState,
  WriteFailure,
} from "@hark/export/jobs";
import type { ExportReport } from "@hark/export/report";
import type { AbortSignalLike } from "@hark/export/source";
import type { ByteCount, EpochMs } from "@hark/recording/ids";
import type { ExportRoute } from "./export-file.ts";

/** How one run ended. A run never throws: the host turns every refusal into `write-failed`. */
export type RunOutcome =
  | {
      readonly kind: "done";
      readonly fileName: string;
      readonly folderLabel: string;
      readonly report: ExportReport;
      readonly route: ExportRoute;
    }
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "write-failed";
      readonly failure: WriteFailure;
      readonly route?: ExportRoute;
      /** The export named its file, then could not prove the name still holds it. */
      readonly unconfirmed?: true;
    };

export interface RunProgress {
  readonly done: number;
  readonly total: number;
  readonly bytes: ByteCount;
}

export type ExportRun = (
  job: { readonly id: ExportId; readonly request: ExportRequest },
  control: { readonly signal: AbortSignalLike; readonly progress: (p: RunProgress) => void },
) => Promise<RunOutcome>;

/**
 * Bytes written when cancel was asked and when the run stopped, so a check can see it stopped within one chunk. The
 * job ends cancelled as soon as cancel is asked; `bytesAtStop` comes when the run itself has stopped.
 */
export interface CancelAudit {
  readonly bytesAtCancel: number;
  readonly bytesAtStop: number | null;
  /** The export's own file, when its run finished it before it saw the cancel: left as it is. */
  readonly keptFile: string | null;
}

/** The jobs `listExports` returns: this run's, newest first. */
export const KEPT_JOBS = 10;

interface Slot {
  job: ExportJob;
  readonly signal: { aborted: boolean; reason?: unknown };
  /** Ends the job as cancelled at once, whatever the run is still doing. */
  stop: () => void;
  started: boolean;
  bytes: number;
  audit: { bytesAtCancel: number; bytesAtStop: number | null; keptFile: string | null } | null;
  /** The route the run took and why, for diagnosis: never in the job a page sees, which has only its kind. */
  route: ExportRoute | null;
}

/** What a page sees of an outcome: the route's kind, never why. */
const shown = (outcome: RunOutcome): ExportState => {
  if (outcome.kind !== "write-failed")
    return outcome.kind === "done" ? { ...outcome, route: outcome.route.route } : outcome;
  const { route, ...failed } = outcome;
  return route === undefined ? failed : { ...failed, route: route.route };
};

const WAITING: ExportState = { kind: "writing", done: 0, total: 0, bytes: 0 as ByteCount };

const isFinal = (state: ExportState): boolean => state.kind !== "writing";

export function createExportJobs(ports: {
  readonly run: ExportRun;
  readonly now: () => EpochMs;
  readonly newId: () => ExportId;
  readonly plannedName: (request: ExportRequest) => string;
  readonly onChange: (job: ExportJob) => void;
}) {
  const slots: Slot[] = [];
  let queue: Promise<void> = Promise.resolve();

  const set = (slot: Slot, state: ExportState): void => {
    slot.job = { ...slot.job, state };
    ports.onChange(slot.job);
  };

  const execute = async (slot: Slot): Promise<void> => {
    if (slot.signal.aborted) {
      set(slot, { kind: "cancelled" });
      return;
    }
    slot.started = true;
    const stopped = new Promise<RunOutcome>((resolve) => {
      slot.stop = () => resolve({ kind: "cancelled" });
    });
    const ran = ports
      .run(
        { id: slot.job.id, request: slot.job.request },
        {
          signal: slot.signal,
          progress: (p) => {
            slot.bytes = p.bytes;
            if (!slot.signal.aborted)
              set(slot, { kind: "writing", done: p.done, total: p.total, bytes: p.bytes });
          },
        },
      )
      .catch((): RunOutcome => ({ kind: "write-failed", failure: { kind: "other" } }))
      .then((outcome) => {
        slot.route = outcome.kind === "cancelled" ? null : (outcome.route ?? null);
        if (slot.audit !== null) {
          slot.audit.bytesAtStop = slot.bytes;
          slot.audit.keptFile = outcome.kind === "done" ? outcome.fileName : null;
        }
        return outcome;
      });
    set(slot, shown(await Promise.race([ran, stopped])));
  };

  const find = (id: ExportId): Slot | undefined => slots.find((slot) => slot.job.id === id);

  return {
    start: (request: ExportRequest): ExportJob => {
      const slot: Slot = {
        job: {
          id: ports.newId(),
          request,
          fileName: ports.plannedName(request),
          startedAt: ports.now(),
          state: WAITING,
        },
        signal: { aborted: false },
        stop: () => undefined,
        started: false,
        bytes: 0,
        audit: null,
        route: null,
      };
      slots.unshift(slot);
      const dropped = slots.findLastIndex((s, index) => index >= KEPT_JOBS && isFinal(s.job.state));
      if (dropped !== -1) slots.splice(dropped, 1);
      queue = queue.then(() => execute(slot));
      return slot.job;
    },
    list: (): readonly ExportJob[] => slots.slice(0, KEPT_JOBS).map((slot) => slot.job),
    /** True while the job is cancelled or stopping. A finished, failed or unknown job is not changed. */
    cancel: (id: ExportId): boolean => {
      const slot = find(id);
      if (slot === undefined) return false;
      if (slot.job.state.kind === "cancelled") return true;
      if (isFinal(slot.job.state)) return false;
      if (!slot.signal.aborted) {
        slot.signal.aborted = true;
        slot.signal.reason = undefined;
        slot.audit = { bytesAtCancel: slot.bytes, bytesAtStop: null, keptFile: null };
        slot.stop();
      }
      return true;
    },
    job: (id: ExportId): ExportJob | null => find(id)?.job ?? null,
    audit: (id: ExportId): CancelAudit | null => find(id)?.audit ?? null,
    /** The route a finished or failed run took, and why: for the harness and diagnosis only. */
    route: (id: ExportId): ExportRoute | null => find(id)?.route ?? null,
    /** Resolves when every job queued so far has ended. */
    idle: (): Promise<void> => queue,
  };
}

export type ExportJobs = ReturnType<typeof createExportJobs>;
