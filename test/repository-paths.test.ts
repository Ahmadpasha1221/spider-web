import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSessionStorePaths,
  isValidSessionId,
  resolveSpiderDataDirectory,
  sessionDirectory,
  sessionFile,
} from "../src/repository/session-store-paths.js";
import { SessionRepositoryError } from "../src/repository/session-repository.js";

const VALID_ID = "spw_550e8400-e29b-4166-a716-446655440000";

describe("platform data directory resolution", () => {
  it("uses the Windows LOCALAPPDATA application data location", () => {
    expect(
      resolveSpiderDataDirectory({
        platform: "win32",
        homeDirectory: "C:\\Users\\demo",
        env: { LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local" },
      }),
    ).toBe(join("C:\\Users\\demo\\AppData\\Local", "Spider Web"));
  });

  it("falls back to the Windows home directory when LOCALAPPDATA is absent", () => {
    expect(
      resolveSpiderDataDirectory({
        platform: "win32",
        homeDirectory: "C:\\Users\\demo",
        env: {},
      }),
    ).toBe(join("C:\\Users\\demo", "AppData", "Local", "Spider Web"));
  });

  it("uses the macOS application support location", () => {
    expect(
      resolveSpiderDataDirectory({
        platform: "darwin",
        homeDirectory: "/Users/demo",
        env: {},
      }),
    ).toBe(join("/Users/demo", "Library", "Application Support", "spider-web"));
  });

  it("uses XDG_DATA_HOME on Linux when it is absolute", () => {
    expect(
      resolveSpiderDataDirectory({
        platform: "linux",
        homeDirectory: "/home/demo",
        env: { XDG_DATA_HOME: "/data" },
      }),
    ).toBe(join("/data", "spider-web"));
  });

  it("ignores a relative XDG_DATA_HOME per the XDG specification", () => {
    expect(
      resolveSpiderDataDirectory({
        platform: "linux",
        homeDirectory: "/home/demo",
        env: { XDG_DATA_HOME: "relative/data" },
      }),
    ).toBe(join("/home/demo", ".local", "share", "spider-web"));
  });

  it("falls back to the Linux home data location", () => {
    expect(
      resolveSpiderDataDirectory({
        platform: "linux",
        homeDirectory: "/home/demo",
        env: {},
      }),
    ).toBe(join("/home/demo", ".local", "share", "spider-web"));
  });

  it("lets SPIDER_WEB_DATA_DIR override every platform default", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(
        resolveSpiderDataDirectory({
          platform,
          homeDirectory: "/home/demo",
          env: {
            SPIDER_WEB_DATA_DIR: "/custom/spider",
            LOCALAPPDATA: "/ignored",
            XDG_DATA_HOME: "/ignored",
          },
        }),
      ).toBe(resolve("/custom/spider"));
    }
  });
});

describe("session store layout", () => {
  it("places sessions and the index under the data directory", () => {
    const paths = createSessionStorePaths("/repo");
    expect(paths.sessionsDirectory).toBe(join(paths.dataDirectory, "sessions"));
    expect(paths.indexFile).toBe(join(paths.dataDirectory, "index.json"));
  });

  it("resolves relative data directories", () => {
    const paths = createSessionStorePaths("relative/repo");
    expect(isAbsolute(paths.dataDirectory)).toBe(true);
  });

  it("builds safe session paths from valid IDs", () => {
    const paths = createSessionStorePaths("/repo");
    expect(sessionDirectory(paths, VALID_ID)).toBe(
      join(paths.sessionsDirectory, VALID_ID),
    );
    expect(sessionFile(paths, VALID_ID)).toBe(
      join(paths.sessionsDirectory, VALID_ID, "session.json"),
    );
  });

  it("rejects IDs that are not schema session IDs", () => {
    const paths = createSessionStorePaths("/repo");
    for (const sessionId of [
      "",
      "..",
      "../escape",
      "spw_550e8400-E29B-4166-A716-446655440000",
      "spw_550e8400-e29b-1166-a716-446655440000",
      "spw_550e8400-e29b-4166-7716-446655440000",
      "claude-session",
      "spw_evil/../../etc",
      "spw_evil\\..\\..\\etc",
      "spw_",
      "C:\\Users",
    ]) {
      expect(() => sessionDirectory(paths, sessionId)).toThrow(
        SessionRepositoryError,
      );
      expect(() => sessionFile(paths, sessionId)).toThrow(
        SessionRepositoryError,
      );
    }
  });
});

describe("session ID validation", () => {
  it("accepts lowercase spw_ UUID v4 IDs", () => {
    expect(isValidSessionId(VALID_ID)).toBe(true);
  });

  it("rejects malformed IDs", () => {
    for (const sessionId of [
      "",
      "550e8400-e29b-4166-a716-446655440000",
      "spw_550e8400-E29B-4166-A716-446655440000",
      "spw_550e8400-e29b-4166-a716-44665544000",
      "spw_550e8400-e29b-4166-a716-4466554400000",
      "spw_550e8400-e29b-1166-a716-446655440000",
      "spw_550e8400-e29b-4166-0716-446655440000",
      "spw_zzzzzzzz-e29b-4166-a716-446655440000",
    ]) {
      expect(isValidSessionId(sessionId)).toBe(false);
    }
  });
});
