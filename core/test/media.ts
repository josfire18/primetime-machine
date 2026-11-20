// Real video files for the tests, made with ffmpeg: a moving test pattern with a tone for
// "show", true black frames with true silence for a "break" (what a cut-out commercial leaves).
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Piece = { show: number } | { gap: number };

export async function makeClip(path: string, pieces: Piece[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const args = ["-v", "error", "-y"];
  const links: string[] = [];
  pieces.forEach((p, i) => {
    if ("show" in p) {
      args.push("-f", "lavfi", "-i", `testsrc2=size=160x120:rate=10:duration=${p.show}`,
                "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=22050:duration=${p.show}`);
    } else {
      args.push("-f", "lavfi", "-i", `color=c=black:size=160x120:rate=10:duration=${p.gap}`,
                "-f", "lavfi", "-i", `anullsrc=r=22050:cl=mono:d=${p.gap}`);
    }
    links.push(`[${2 * i}:v][${2 * i + 1}:a]`);
  });
  args.push("-filter_complex", `${links.join("")}concat=n=${pieces.length}:v=1:a=1[v][a]`,
            "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", path);
  await run("ffmpeg", args);
}
