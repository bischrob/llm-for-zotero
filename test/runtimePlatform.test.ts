import { assert } from "chai";
import {
  buildRuntimePlatformGuidanceText,
  getRuntimePlatformInfo,
} from "../src/utils/runtimePlatform";

describe("runtimePlatform", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: { isWin?: boolean; isMac?: boolean };
  };
  const originalZotero = globalScope.Zotero;

  beforeEach(function () {
    globalScope.Zotero = { ...(originalZotero || {}) };
  });

  afterEach(function () {
    if (originalZotero) {
      globalScope.Zotero = originalZotero;
      return;
    }
    delete globalScope.Zotero;
  });

  it("builds Windows shell guidance", function () {
    if (!globalScope.Zotero) {
      throw new Error("Zotero test stub was not initialized");
    }
    globalScope.Zotero.isWin = true;
    globalScope.Zotero.isMac = false;

    const info = getRuntimePlatformInfo();
    const text = buildRuntimePlatformGuidanceText(info);
    assert.equal(info.shellName, "cmd.exe");
    assert.include(text, "cmd.exe");
    assert.include(text, "%USERPROFILE%");
    assert.include(text, "dir %USERPROFILE%\\Desktop");
  });

  it("builds macOS shell guidance", function () {
    if (!globalScope.Zotero) {
      throw new Error("Zotero test stub was not initialized");
    }
    globalScope.Zotero.isWin = false;
    globalScope.Zotero.isMac = true;

    const info = getRuntimePlatformInfo();
    const text = buildRuntimePlatformGuidanceText(info);
    assert.equal(info.shellPath, "/bin/zsh");
    assert.include(text, "/bin/zsh");
    assert.include(text, "ls ~/Desktop");
    assert.include(text, "Native path separator: /");
  });
});
