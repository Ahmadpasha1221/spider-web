import { describe, expect, it } from "vitest";
import {
  validateAdapterCapabilities,
  type AdapterCapabilities,
} from "../src/adapters/capabilities.js";

const manual: AdapterCapabilities = {
  detect: "none",
  capture: { support: "none", mode: "none", events: [], omissions: [] },
  import: { support: "none", mode: "none", omissions: [] },
  continue: { support: "supported", mode: "manual-handoff" },
};

describe("agent-neutral adapter capabilities", () => {
  it("accepts generic manual handoff without native provider support", () => {
    expect(() => validateAdapterCapabilities(manual)).not.toThrow();
  });
  it("rejects provider-specific event names and unmarked private formats", () => {
    expect(() =>
      validateAdapterCapabilities({
        ...manual,
        capture: {
          ...manual.capture,
          support: "supported",
          mode: "documented-file-export",
          events: ["claudeMessage"],
          omissions: [],
        },
      } as unknown),
    ).toThrow(/neutral event/);
    expect(() =>
      validateAdapterCapabilities({
        ...manual,
        capture: {
          ...manual.capture,
          support: "supported",
          mode: "private-local-format",
        },
      }),
    ).toThrow(/experimental/);
  });
});
