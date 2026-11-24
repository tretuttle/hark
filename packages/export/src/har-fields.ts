// Every field of a HAR entry as a dotted path, derived from @hark/har/model.

import type {
  HarCache,
  HarContent,
  HarEntry,
  HarRequest,
  HarResponse,
  HarTimings,
} from "@hark/har/model";

/** The declared keys of a model type, without the CustomHarFields index signature. */
type DeclaredKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]-?: T[K];
} &
  string;
type Prefixed<T, P extends string> = `${P}${DeclaredKeys<T>}`;

export type HarEntryField =
  | Exclude<DeclaredKeys<HarEntry>, "request" | "response" | "cache" | "timings">
  | Prefixed<HarRequest, "request.">
  | Exclude<Prefixed<HarResponse, "response.">, "response.content">
  | Prefixed<HarContent, "response.content.">
  | Prefixed<HarCache, "cache.">
  | Prefixed<HarTimings, "timings.">;
