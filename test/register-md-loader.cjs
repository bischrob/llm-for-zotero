const fs = require("fs");
const Module = require("module");

require.extensions[".md"] = function loadMarkdown(module, filename) {
  module.exports = fs.readFileSync(filename, "utf8");
};

class StubBasicTool {
  constructor() {
    this.basicOptions = {
      log: {},
      api: {},
    };
    this.commandAction = {
      createMenuNode() {},
      removeMenuNode() {},
    };
    this.ProgressWindow = {
      setIconURI() {},
    };
  }
}

class StubUITool {
  constructor() {
    this.basicOptions = {
      ui: {},
    };
  }
}

class StubZoteroToolkit extends StubBasicTool {
  constructor() {
    super();
    this.UI = new StubUITool();
  }
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "zotero-plugin-toolkit") {
    return {
      BasicTool: StubBasicTool,
      UITool: StubUITool,
      ZoteroToolkit: StubZoteroToolkit,
      unregister() {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

if (!globalThis.Zotero) {
  globalThis.Zotero = {};
}

const prefStore = new Map();
if (!globalThis.Zotero.Prefs) {
  globalThis.Zotero.Prefs = {
    get(key) {
      return prefStore.get(key);
    },
    set(key, value) {
      prefStore.set(key, value);
    },
  };
}

if (!globalThis.Zotero.Items) {
  globalThis.Zotero.Items = {
    get() {
      return null;
    },
  };
}
