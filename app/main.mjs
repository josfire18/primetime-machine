// The desktop app: starts the station inside this process and shows the TV screen in a
// full-screen window. Electron, because its Chromium plays the H.264/AAC most libraries use.
//
//   npm run app                    the library in ~/.primetime-machine/config.json
//   npm run app -- --config path   another config
//
// First run with no folders: it asks for the library folder(s), saves them to the config and
// scans. File > Add folder adds more; File > Rescan picks up new files. The station listens on
// this machine only (127.0.0.1); nothing is reachable from the network.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { app, BrowserWindow, dialog, Menu, shell } from "electron";

import { DEFAULT_CONFIG, Library, loadConfig } from "../station/library.ts";
import { createStation } from "../station/server.ts";

const { values } = parseArgs({
  args: process.argv.slice(app.isPackaged ? 1 : 2),
  strict: false,
  options: { config: { type: "string" }, port: { type: "string" }, windowed: { type: "boolean" } },
});
const configPath = typeof values.config === "string" ? values.config : DEFAULT_CONFIG;
const PREFERRED_PORT = Number(values.port ?? 8420);

// Sound and picture without a click first: this is a TV.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

let win = null;
let origin = "";
const lib = new Library(configPath);

async function saveFolders(folders) {
  let raw = {};
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch { /* new config */ }
  raw.folders = [...new Set([...(raw.folders ?? []), ...folders])];
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(raw, null, 2) + "\n");
}

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

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

async function startStation() {
  const server = createStation(lib);
  let port;
  try {
    port = await listen(server, PREFERRED_PORT);
  } catch {
    port = await listen(server, 0);           // the usual port is taken: any free one
  }
  return `http://127.0.0.1:${port}`;
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "Add folder…", click: async () => { if (await chooseFolders(false)) await rescan(); } },
        { label: "Rescan library", accelerator: "CmdOrCtrl+R", click: () => rescan() },
        { label: "Open config file", click: () => shell.openPath(configPath) },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { label: "View", submenu: [{ role: "togglefullscreen" }, { role: "toggleDevTools" }] },
  ]));
}

async function main() {
  await app.whenReady();
  buildMenu();
  let config = await loadConfig(configPath);
  if (!config.folders.length && await chooseFolders(true)) config = await loadConfig(configPath);
  await lib.scan();
  origin = await startStation();
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
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  await win.loadURL(origin);
}

app.on("window-all-closed", () => app.quit());
main().catch((e) => {
  dialog.showErrorBox("Primetime Machine couldn't start", String(e?.message ?? e));
  app.quit();
});
