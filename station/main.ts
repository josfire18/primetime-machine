// Run the station:  npm run station -- [--config path] [--port 8420] [--lan] [folder ...]
// Folders given on the command line are aired as-is (handy for trying it out); otherwise the
// config file's folders are used. Open http://127.0.0.1:8420 for the TV screen. --lan (or
// "lan": true in the config) shares it with other screens on the home network.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { DEFAULT_CONFIG, Library, loadConfig } from "./library.ts";
import { lanUrls } from "./net.ts";
import { createStation } from "./server.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    port: { type: "string" },
    lan: { type: "boolean" },
  },
});

let configPath = values.config ?? DEFAULT_CONFIG;
if (positionals.length) {
  configPath = join(await mkdtemp(join(tmpdir(), "ptm-")), "config.json");
  await writeFile(configPath, JSON.stringify({ folders: positionals.map((p) => resolve(p)) }));
}
const lib = new Library(configPath);
console.log(`scanning (config: ${configPath}) ...`);
await lib.scan();
console.log(`${lib.items.length} videos, ${lib.channels.length} channels`);
const config = await loadConfig(configPath);
const port = Number(values.port ?? config.port);
const lan = values.lan ?? config.lan ?? false;
createStation(lib).listen(port, lan ? "0.0.0.0" : "127.0.0.1", () => {
  console.log(`on the air: http://127.0.0.1:${port}`);
  if (lan) for (const u of lanUrls(port)) console.log(`  other screens at home: ${u}`);
});
void lib.detectBreaks().then(() => {
  const j = lib.breakJob;
  if (j.total) console.log(`commercial breaks checked: ${j.done}/${j.total} episodes${j.failed ? `, ${j.failed} unreadable` : ""}`);
});
