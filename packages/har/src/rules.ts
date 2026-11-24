// Which values count as secrets. Its own module so the recorder can drop secret header values at capture without
// bundling the redaction tables.

import type { HarRedactionTarget } from "./model.ts";

export interface HarRedactionRule {
  readonly id: string;
  readonly target: HarRedactionTarget;
  readonly names: readonly string[];
  readonly matchAll?: boolean | undefined;
}

const SECRET_PARAMETER_NAMES = [
  "access_token",
  "refresh_token",
  "id_token",
  "token",
  "api_key",
  "apikey",
  "key",
  "client_secret",
  "secret",
  "password",
  "auth",
  "code",
  "sig",
  "signature",
  "x-amz-signature",
  "x-amz-security-token",
] as const;

// A header is listed when its value is a credential or a proof bound to one request. `Digest`,
// `Content-Digest` and `Repr-Digest` hold a hash of the body, which proves nothing about the sender,
// so they are not listed.
export const DEFAULT_REDACTION_RULES: readonly HarRedactionRule[] = [
  { id: "header:cookie", target: "header", names: ["cookie"] },
  { id: "header:set-cookie", target: "header", names: ["set-cookie"] },
  { id: "header:authorization", target: "header", names: ["authorization"] },
  { id: "header:proxy-authorization", target: "header", names: ["proxy-authorization"] },
  {
    id: "header:x-api-key",
    target: "header",
    names: ["x-api-key", "api-key", "x-api-token", "x-auth-token", "x-amz-security-token"],
  },
  {
    id: "header:x-csrf-token",
    target: "header",
    names: ["x-csrf-token", "x-xsrf-token", "csrf-token"],
  },
  // RFC 9449 DPoP proofs and RFC 9421 HTTP message signatures, each signed for one request.
  { id: "header:request-proof", target: "header", names: ["dpop", "signature"] },
  { id: "cookie:all", target: "cookie", names: [], matchAll: true },
  { id: "query:secrets", target: "query", names: SECRET_PARAMETER_NAMES },
  { id: "body:secrets", target: "body", names: SECRET_PARAMETER_NAMES },
  { id: "url:userinfo", target: "url-userinfo", names: [], matchAll: true },
];
