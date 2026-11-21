// Run the station:  npm run station -- [--config path] [--port 8420] [--host 127.0.0.1] [folder ...]
// Folders given on the command line are aired as-is (handy for trying it out); otherwise the
// config file's folders are used. Open http://127.0.0.1:8420 for the TV screen.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { DEFAULT_CONFIG, Library } from "./library.ts";
import { createStation } from "./server.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    port: { type: "string", default: "8420" },
    host: { type: "string", default: "127.0.0.1" },
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
const port = Number(values.port);
createStation(lib).listen(port, values.host, () => {
  console.log(`on the air: http://${values.host === "0.0.0.0" ? "127.0.0.1" : values.host}:${port}`);
});
