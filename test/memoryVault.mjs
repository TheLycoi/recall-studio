// Shared by the tests that run WikiLM's write guard and upstream's engine on a
// vault held in memory. Not a test file itself: npm test runs test/*.test.mjs.

const CONFIG = ".obsidian";

/**
 * Obsidian's App as far as upstream's engine and WikiLM's ingest reach it:
 * Vault, its DataAdapter, FileManager, a MetadataCache with no cache
 * (obsidian.d.ts). One map holds every file; the Vault side does not see the
 * config folder, as Obsidian's does not. `classes` carries the TFile and
 * TFolder of the bundle under test, so its `instanceof` checks hold.
 */
export function memoryVault(initial, classes) {
  const m = classes;
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  const inConfig = (p) => p === CONFIG || p.startsWith(`${CONFIG}/`);
  const parentOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const addDirs = (p) => {
    for (let d = parentOf(p); d; d = parentOf(d)) dirs.add(d);
  };
  for (const p of files.keys()) addDirs(p);

  const fileObj = (p) => {
    const name = p.split("/").pop();
    const dot = name.lastIndexOf(".");
    const f = Object.assign(new m.TFile(), { path: p, name, basename: dot > 0 ? name.slice(0, dot) : name, extension: dot > 0 ? name.slice(dot + 1) : "" });
    f.stat = { ctime: 0, mtime: 0, size: files.get(p)?.length ?? 0 };
    return f;
  };
  const folderObj = (p) => {
    const prefix = `${p}/`;
    const children = [...files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map(fileObj);
    return Object.assign(new m.TFolder(), { path: p, name: p.split("/").pop(), children });
  };
  const exists = (p) => files.has(p) || dirs.has(p);
  const need = (p) => {
    if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
  };
  const noteFiles = () => [...files.keys()].filter((p) => !inConfig(p)).sort().map(fileObj);

  const vault = {
    configDir: CONFIG,
    adapter: null,
    getName: () => "memory",
    getAbstractFileByPath: (p) => {
      if (inConfig(p)) return null;
      if (files.has(p)) return fileObj(p);
      if (dirs.has(p)) return folderObj(p);
      return null;
    },
    getFileByPath: (p) => (files.has(p) && !inConfig(p) ? fileObj(p) : null),
    getFolderByPath: (p) => (dirs.has(p) ? folderObj(p) : null),
    getFiles: noteFiles,
    getMarkdownFiles: () => noteFiles().filter((f) => f.extension === "md"),
    getAllLoadedFiles: noteFiles,
    read: async (f) => (need(f.path), files.get(f.path)),
    cachedRead: async (f) => (need(f.path), files.get(f.path)),
    create: async (p, data) => {
      if (exists(p)) throw new Error("File already exists.");
      files.set(p, data);
      addDirs(p);
      return fileObj(p);
    },
    createFolder: async (p) => {
      if (exists(p)) throw new Error("Folder already exists.");
      dirs.add(p);
      addDirs(p);
      return folderObj(p);
    },
    createBinary: async (p) => {
      if (exists(p)) throw new Error("File already exists.");
      files.set(p, "<binary>");
      addDirs(p);
      return fileObj(p);
    },
    modify: async (f, data) => (need(f.path), void files.set(f.path, data)),
    modifyBinary: async (f) => (need(f.path), void files.set(f.path, "<binary>")),
    appendBinary: async (f) => (need(f.path), void files.set(f.path, `${files.get(f.path)}<binary>`)),
    append: async (f, data) => (need(f.path), void files.set(f.path, files.get(f.path) + data)),
    process: async (f, fn) => {
      need(f.path);
      const next = fn(files.get(f.path));
      files.set(f.path, next);
      return next;
    },
    delete: async (f) => void files.delete(f.path),
    trash: async (f) => void files.delete(f.path),
    rename: async (f, to) => {
      need(f.path);
      files.set(to, files.get(f.path));
      files.delete(f.path);
      addDirs(to);
    },
    copy: async (f, to) => {
      need(f.path);
      if (exists(to)) throw new Error("File already exists.");
      files.set(to, files.get(f.path));
      addDirs(to);
      return fileObj(to);
    },
    on: () => ({}),
  };
  vault.adapter = {
    getName: () => "memory",
    exists: async (p) => exists(p),
    stat: async (p) => (files.has(p) ? { type: "file", ctime: 0, mtime: 0, size: files.get(p).length } : dirs.has(p) ? { type: "folder", ctime: 0, mtime: 0, size: 0 } : null),
    list: async (p) => {
      const prefix = `${p}/`;
      const direct = (k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/");
      return { files: [...files.keys()].filter(direct), folders: [...dirs].filter(direct) };
    },
    read: async (p) => (need(p), files.get(p)),
    write: async (p, data) => {
      files.set(p, data);
      addDirs(p);
    },
    writeBinary: async (p) => {
      files.set(p, "<binary>");
      addDirs(p);
    },
    appendBinary: async (p) => void files.set(p, `${files.get(p) ?? ""}<binary>`),
    append: async (p, data) => void files.set(p, (files.get(p) ?? "") + data),
    process: async (p, fn) => {
      need(p);
      const next = fn(files.get(p));
      files.set(p, next);
      return next;
    },
    mkdir: async (p) => {
      dirs.add(p);
      addDirs(p);
    },
    remove: async (p) => void files.delete(p),
    rmdir: async (p) => {
      for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k);
      for (const d of [...dirs]) if (d === p || d.startsWith(`${p}/`)) dirs.delete(d);
    },
    rename: async (p, to) => {
      files.set(to, files.get(p));
      files.delete(p);
    },
    copy: async (p, to) => void files.set(to, files.get(p)),
    trashSystem: async (p) => (files.delete(p), true),
    trashLocal: async (p) => void files.delete(p),
  };
  const fileManager = {
    trashFile: async (f) => void files.delete(f.path),
    renameFile: async (f, to) => vault.rename(f, to),
    processFrontMatter: async () => {
      throw new Error("not used by the engine");
    },
  };
  return {
    files,
    app: {
      vault,
      fileManager,
      metadataCache: { getFileCache: () => null, getFirstLinkpathDest: () => null, resolvedLinks: {}, unresolvedLinks: {} },
      workspace: { getActiveFile: () => null },
    },
  };
}
