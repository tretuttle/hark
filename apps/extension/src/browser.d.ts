/// <reference types="firefox-webext-browser" />

import type { HarkApi } from "../experiment/contract.ts";

declare global {
  namespace browser {
    /** Undefined when the browser has `extensions.experiments.enabled` set to false. */
    const hark: HarkApi | undefined;
  }
}
