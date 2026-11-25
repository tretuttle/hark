import { describe, expect, it } from "vite-plus/test";

import { buildMarkerDocument, markerPresent, type Marker } from "./marker-document.ts";
import {
  HAR_REDACTION_PLACES,
  type HarDocument,
  type HarModelField,
  type HarRedactionPlace,
  type RedactionLevel,
} from "../src/model.ts";
import {
  HAR_MODEL_FIELD_TABLE,
  HAR_PLACE_TABLE,
  type HarPlaceRule,
  redactHar,
} from "../src/redact.ts";

const STANDARD_REMOVED_PLACES: ReadonlySet<HarRedactionPlace> = new Set([
  "request-url-userinfo",
  "request-url-query-secret",
  "header-value-secret",
  "cookie",
  "query-string-secret",
  "body-param-secret",
  "body-json",
  "body-form",
  "body-multipart",
  "redaction-record",
  "wrong-type",
]);

const SHAREABLE_KEPT_PLACES: ReadonlySet<HarRedactionPlace> = new Set([
  "request-url-host",
  "request-url-path",
  "header-name",
  "header-value-allowlisted",
  "protocol-metadata",
  "measurement",
]);

function verifyLevel(
  document: HarDocument,
  markers: readonly Marker[],
  level: RedactionLevel,
  placeTable: Readonly<Record<HarRedactionPlace, HarPlaceRule>> = HAR_PLACE_TABLE,
): readonly string[] {
  const { document: redacted, report } = redactHar(document, { level, placeTable });
  const failures: string[] = [];

  for (const item of markers) {
    const present = markerPresent(redacted, item);
    const coverage = report.places.find((place) => place.place === item.place);
    if (!coverage) {
      failures.push(`${item.field} (${item.place}) missing from report.places`);
      continue;
    }
    if (coverage.count <= 0) {
      failures.push(`${item.field} (${item.place}) has count ${String(coverage.count)}`);
    }

    if (present) {
      const expectedKeptStatus = level === "standard" ? "kept-not-examined" : "kept-by-allowlist";
      if (coverage.status !== expectedKeptStatus) {
        failures.push(
          `${item.field} (${item.place}) marker stayed in output, but report status is ${coverage.status}`,
        );
      }
      if (level === "standard" && STANDARD_REMOVED_PLACES.has(item.place)) {
        failures.push(
          `${item.field} (${item.place}) is a credential carrier and must be removed under standard`,
        );
      }
      if (level === "shareable" && !SHAREABLE_KEPT_PLACES.has(item.place)) {
        failures.push(
          `${item.field} (${item.place}) is not on the shareable allowlist and must be removed`,
        );
      }
    } else {
      if (coverage.status !== "removed") {
        failures.push(
          `${item.field} (${item.place}) marker was removed, but report status is ${coverage.status}`,
        );
      }
      if (level === "standard" && !STANDARD_REMOVED_PLACES.has(item.place)) {
        failures.push(
          `${item.field} (${item.place}) must be kept byte-for-byte intact under standard`,
        );
      }
      if (level === "shareable" && SHAREABLE_KEPT_PLACES.has(item.place)) {
        failures.push(
          `${item.field} (${item.place}) is on the shareable allowlist and must be kept`,
        );
      }
    }
  }

  return failures;
}

describe("total model place table and marker verification", () => {
  it("fills every field of the HAR model that holds a value with a marker and accounts for 100% of markers at both levels", () => {
    const { document, markers, markedFields } = buildMarkerDocument();

    // A field whose own fields are listed is walked through them; every other field holds a value.
    const allFields = Object.keys(HAR_MODEL_FIELD_TABLE) as HarModelField[];
    const valueFields = allFields.filter(
      (field) =>
        HAR_MODEL_FIELD_TABLE[field].places.some((place) => place !== "wrong-type") &&
        !allFields.some((other) =>
          other.startsWith(
            `${HAR_MODEL_FIELD_TABLE[field].children ?? field}${HAR_MODEL_FIELD_TABLE[field].kinds.includes("array") ? "[]" : ""}.`,
          ),
        ),
    );
    expect([...markedFields].sort()).toEqual([...valueFields].sort());

    for (const field of valueFields) {
      const expectedPlaces = HAR_MODEL_FIELD_TABLE[field].places.filter(
        (place) => place !== "wrong-type",
      );
      const markedPlacesForField = markers
        .filter((item) => item.field === field && item.place !== "wrong-type")
        .map((item) => item.place);
      expect([...markedPlacesForField].sort(), field).toEqual([...expectedPlaces].sort());
    }
    expect(markers.some((item) => item.place === "wrong-type")).toBe(true);

    for (const item of markers) {
      expect(markerPresent(document, item), `missing initial marker for ${item.field}`).toBe(true);
    }

    const standardFailures = verifyLevel(document, markers, "standard");
    expect(standardFailures).toEqual([]);

    const shareableFailures = verifyLevel(document, markers, "shareable");
    expect(shareableFailures).toEqual([]);
  });

  it("fails when any single row in HAR_PLACE_TABLE has the wrong disposition at either level", () => {
    const { document, markers } = buildMarkerDocument();

    for (const place of HAR_REDACTION_PLACES) {
      const original = HAR_PLACE_TABLE[place];

      const flippedStandard: Record<HarRedactionPlace, HarPlaceRule> = {
        ...HAR_PLACE_TABLE,
        [place]: {
          ...original,
          standard: original.standard === "removed" ? "kept-not-examined" : "removed",
        },
      };
      const standardFailures = verifyLevel(document, markers, "standard", flippedStandard);
      expect(
        standardFailures.some((msg) => msg.includes(`(${place})`)),
        `expected flipping the standard row for ${place} to fail`,
      ).toBe(true);

      const flippedShareable: Record<HarRedactionPlace, HarPlaceRule> = {
        ...HAR_PLACE_TABLE,
        [place]: {
          ...original,
          shareable: original.shareable === "removed" ? "kept-by-allowlist" : "removed",
        },
      };
      const shareableFailures = verifyLevel(document, markers, "shareable", flippedShareable);
      expect(
        shareableFailures.some((msg) => msg.includes(`(${place})`)),
        `expected flipping the shareable row for ${place} to fail`,
      ).toBe(true);
    }
  });
});
