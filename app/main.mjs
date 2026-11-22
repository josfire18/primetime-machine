// The desktop app: starts the station inside this process and shows the TV screen in a
// full-screen window. Electron, because its Chromium plays the H.264/AAC most libraries use.
//
//   npm run app                    the library in ~/.primetime-machine/config.json
//   npm run app -- --config path   another config
//
// First run with no folders: it asks for the library folder(s), saves them to the config and
// scans. File > Add folder adds more; File > Rescan picks up new files. The station listens on
// this machine only (127.0.0.1) unless File > Share with other screens at home is on (the
// config's "lan"), which lets a Roku, a phone or another browser at home tune in.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { app, BrowserWindow, dialog, Menu, shell } from "electron";

import { DEFAULT_CONFIG, Library, loadConfig } from "../station/library.ts";
import { lanUrls } from "../station/net.ts";
import { createStation } from "../station/server.ts";

const { values } = parseArgs({
  args: process.argv.slice(app.isPackaged ? 1 : 2),
  strict: false,
  options: { config: { type: "string" }, port: { type: "string" }, windowed: { type: "boolean" } },
});
const configPath = typeof values.config === "string" ? values.config : DEFAULT_CONFIG;

// Sound and picture without a click first: this is a TV.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

let win = null;
let origin = "";
let server = null;
let shared = false;
let port = 0;
const lib = new Library(configPath);

async function updateConfig(change) {
  let raw = {};
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch { /* new config */ }
  change(raw);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(raw, null, 2) + "\n");
}

const saveFolders = (folders) => updateConfig((raw) => {
  raw.folders = [...new Set([...(raw.folders ?? []), ...folders])];
});

async function chooseFolders(first) {
  const res = await dialog.showOpenDialog(win ?? undefined, {
    title: first ? "Where are your shows and commercials?" : "Add a folder",
    message: "Pick the folders that hold your TV shows, movies and commercials.",
    properties: ["openDirectory", "multiSelections"],
  });
  if (res.canceled || !res.filePaths.length) return false;
  await saveFolders(res.filePaths);
  return true;
}

async function rescan() {
  await lib.scan();
  void lib.detectBreaks();
  win?.webContents.reload();
}

function listen(srv, wanted, host) {
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(wanted, host, () => {
      srv.off("error", reject);
      resolve(srv.address().port);
    });
  });
}

/** (Re)start the station: this machine only, or the whole home network. Keeps its port. */
async function startStation(lan, wanted) {
  if (server) await new Promise((r) => server.close(() => r()));
  server = createStation(lib);
  const host = lan ? "0.0.0.0" : "127.0.0.1";
  try {
    port = await listen(server, wanted, host);
  } catch {
    port = await listen(server, 0, host);     // the usual port is taken: any free one
  }
  shared = lan;
  return `http://127.0.0.1:${port}`;
}

async function setShared(lan) {
  await updateConfig((raw) => { raw.lan = lan; });
  const was = origin;
  origin = await startStation(lan, port);
  if (origin !== was) await win?.loadURL(origin);    // only if the port had to change
  buildMenu();
  if (lan) showAddresses();
}

function showAddresses() {
  const urls = lanUrls(port);
  dialog.showMessageBox(win ?? undefined, {
    type: "info", title: "Watch on other screens",
    message: shared ? "Open one of these on a phone, laptop or TV browser at home:" : "Sharing is off.",
    detail: shared ? (urls.join("\n") || "No home-network address found.") +
      "\n\nThe Roku channel finds the station the same way." :
      "Turn on File > Share with other screens at home first.",
  });
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "Add folder…", click: async () => { if (await chooseFolders(false)) await rescan(); } },
        { label: "Rescan library", accelerator: "CmdOrCtrl+R", click: () => rescan() },
        { type: "separator" },
        { label: "Share with other screens at home", type: "checkbox", checked: shared,
          click: (item) => setShared(item.checked) },
        { label: "Addresses for other screens…", enabled: shared, click: () => showAddresses() },
        { type: "separator" },
        { label: "Open config file", click: () => shell.openPath(configPath) },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Channels…", accelerator: "CmdOrCtrl+L", enabled: Boolean(origin), click: () => openTool("channels") },
        { label: "Commercial breaks…", accelerator: "CmdOrCtrl+E", enabled: Boolean(origin), click: () => openTool("editor") },
        { type: "separator" },
        { role: "undo" }, { role: "redo" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
    { label: "View", submenu: [{ role: "togglefullscreen" }, { role: "toggleDevTools" }] },
  ]));
}

/** The station's tools (the break editor, the lineup editor), each in a window of its own
 *  beside the TV, one of each at a time. */
const TOOLS = { editor: "Commercial breaks", channels: "Channels" };
const tools = {};
function openTool(name) {
  const open = tools[name];
  if (open && !open.isDestroyed()) return open.focus();
  const page = `${origin}/${name}.html`;
  const w = new BrowserWindow({
    width: 1200, height: 820, backgroundColor: "#070d33", title: `${TOOLS[name]} · Primetime Machine`,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.setMenuBarVisibility(false);
  w.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(origin)) { e.preventDefault(); shell.openExternal(url); }
    else if (!url.startsWith(page)) { e.preventDefault(); win?.focus(); }   // "Back to TV"
  });
  w.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  tools[name] = w;
  void w.loadURL(page);
}

async function main() {
  await app.whenReady();
  let config = await loadConfig(configPath);
  if (!config.folders.length && await chooseFolders(true)) config = await loadConfig(configPath);
  await lib.scan();
  origin = await startStation(config.lan, values.port !== undefined ? Number(values.port) : config.port);
  buildMenu();
  void lib.detectBreaks();                // in the background; takes effect from midnight
  win = new BrowserWindow({
    width: 1280, height: 720, backgroundColor: "#000000", fullscreen: !values.windowed,
    title: "Primetime Machine", autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // The window only ever shows the station; links elsewhere open in the browser.
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(origin)) { e.preventDefault(); shell.openExternal(url); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    const tool = Object.keys(TOOLS).find((t) => url.startsWith(`${origin}/${t}.html`));
    if (tool) openTool(tool);                                    // E or C on the TV
    else shell.openExternal(url);
    return { action: "deny" };
  });
  await win.loadURL(origin);
}

app.on("window-all-closed", () => app.quit());
main().catch((e) => {
  dialog.showErrorBox("Primetime Machine couldn't start", String(e?.message ?? e));
  app.quit();
});
