// Try the core on a real folder: what's on now and the next few hours, one channel per decade.
//   npm run guide -- /path/to/library [hours]
import { argv } from "node:process";

import type { ChannelRule } from "./src/model.ts";
import { guide, onAir, programsFor } from "./src/schedule.ts";
import { LocalFolder } from "./src/sources/local.ts";

const [root, hoursArg] = argv.slice(2);
if (!root) {
  console.error("usage: npm run guide -- <library folder> [hours]");
  process.exit(2);
}
const hours = Number(hoursArg ?? 3);
const library = await new LocalFolder(root).list();
const years = library.map((m) => m.year).filter((y): y is number => y !== undefined);
if (!years.length) {
  console.error(`no dated videos under ${root}`);
  process.exit(1);
}
const now = Date.now();
const fmt = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
let number = 2;
for (let decade = Math.floor(Math.min(...years) / 10) * 10; decade <= Math.max(...years); decade += 10) {
  const rule: ChannelRule = { id: `${decade}s`, number: number++, name: `The ${decade}s`, years: [decade, decade + 9] };
  if (!programsFor(rule, library).length) continue;
  const live = onAir(rule, library, now);
  console.log(`\n${rule.number}  ${rule.name}`);
  if (live) {
    const what = live.segment.item ? `${live.segment.role}: ${live.segment.item.title}`
      : live.block.program ? "commercial break (no ad long enough)" : "station break";
    console.log(`   now: ${what}, ${Math.floor(live.offsetSec / 60)}m${Math.round(live.offsetSec % 60)}s in`);
  }
  for (const b of guide(rule, library, now, now + hours * 3600_000)) {
    const p = b.program;
    console.log(`   ${fmt(b.start).padStart(8)}  ${p ? `${p.show ? `${p.show}: ` : ""}${p.title}${p.year ? ` (${p.year})` : ""}` : "station break"}`);
  }
}
