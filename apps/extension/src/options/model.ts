// What the options page offers and says. Pure: the store makes the calls.

import type { Site } from "@hark/recording/ids";
import { SETTINGS_FLOORS } from "@hark/recording/settings";
import type { RecordingStatus, RefusedFolder, SettingsView } from "../../experiment/contract.ts";

export interface OptionsState {
  /** null until the first reading arrives. */
  readonly status: RecordingStatus | null;
  /** null while the recording is not running: there is nothing to save settings beside. */
  readonly settings: SettingsView | null;
  /** The first read of status and settings. A failed read says why and can be tried again. */
  readonly reading:
    | { readonly kind: "loading" }
    | { readonly kind: "read" }
    | { readonly kind: "failed"; readonly message: string };
  /** The last write's outcome, for the status line under the page header. */
  readonly saved: "saved" | "failed" | null;
  /** The last folder choice that was refused, and why. */
  readonly refused: RefusedFolder | null;
  /** The typed site, and the site waiting for its one confirmation. */
  readonly draft: string;
  readonly draftInvalid: boolean;
  readonly confirming: Site | null;
}

export const EMPTY_OPTIONS: OptionsState = {
  status: null,
  settings: null,
  reading: { kind: "loading" },
  saved: null,
  refused: null,
  draft: "",
  draftInvalid: false,
  confirming: null,
};

/** Why a folder was refused, said so the user knows what to choose instead. */
export const REFUSED_COPY: { readonly [R in RefusedFolder]: string } = {
  "inside-profile":
    "That folder is inside the browser profile. Web pages and other add-ons can reach files there, so exports are never written to it. Choose a folder outside the profile, such as Downloads or Documents.",
  "contains-profile":
    "That folder holds the browser profile. Choose a folder that does not contain the profile, such as Downloads or Documents.",
  "inside-browser":
    "That folder belongs to the browser program. Choose a folder of your own, such as Downloads or Documents.",
  "contains-browser":
    "That folder holds the browser program. Choose a folder of your own, such as Downloads or Documents.",
  "inside-recording":
    "That folder is inside the background recording. Choose a folder outside it, such as Downloads or Documents.",
  "contains-recording":
    "That folder holds the background recording. Choose a folder that does not contain it, such as Downloads or Documents.",
  "not-absolute": "That folder has no full path. Choose another folder.",
};

const MiB = 1_048_576;
/** The smallest choice is the floor the settings parser raises any lower value to, so the list offers no other. */
export const BODY_LIMITS: readonly number[] = [
  SETTINGS_FLOORS.maxBodyBytes,
  256 * MiB,
  512 * MiB,
  1024 * MiB,
  2048 * MiB,
  5120 * MiB,
  10_240 * MiB,
  20_480 * MiB,
];
export const KEEP_DAYS: readonly number[] = [1, 3, 7, 14, 30];

/** The offered values, with the stored one added when it is not among them, so the control shows what is saved. */
export const choicesWith = (offered: readonly number[], current: number): readonly number[] =>
  offered.includes(current) ? offered : [...offered, current].sort((a, b) => a - b);
