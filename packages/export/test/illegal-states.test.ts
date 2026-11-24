import { describe, expect, it } from "vite-plus/test";
import { parseExportRequest } from "../src/jobs.ts";
import { parseSelection } from "../src/selection.ts";
import * as states from "./illegal-states.ts";

describe("runtime parsers reject what the types reject", () => {
  it("parseSelection rejects zero minutes, inverted spans, empty sessions, and negative tab ids", () => {
    expect(parseSelection(states.lastZero)).toBeNull();
    expect(parseSelection(states.inverted)).toBeNull();
    expect(parseSelection(states.noSessions)).toBeNull();
    expect(parseSelection(states.negativeTab)).toBeNull();
  });

  it("parseExportRequest rejects unsupported packaging", () => {
    expect(parseExportRequest(states.badPackaging)).toBeNull();
    expect(parseExportRequest(states.ownLevel)).toBeNull();
  });

  it("keeps legal twins and tables intact", () => {
    expect(states.completeAndMissing.kind).toBe("candidates");
    expect(states.noCandidates.kind).toBe("candidates");
    expect(states.cacheSource).toBeDefined();
    expect(states.legalCandidates.kind).toBe("candidates");
    expect(states.legalNone.kind).toBe("none");
    expect(states.lastFifteen.scope).toBe("everything");
    expect(states.legalBetween.scope).toBe("everything");
    expect(states.legalSessions.scope).toBe("sessions");
    expect(states.legalTab.scope).toBe("tab");
    expect(states.keep).toHaveLength(3);
  });
});
