// Who may talk to the station, and how other screens find it.
//
// A local server is reachable from web pages the user visits through DNS rebinding (a site
// points its own name at 127.0.0.1 and reads the API). So requests must name the station by
// an address or a home-network name, never someone else's domain. That costs nothing on
// this machine (localhost, 127.0.0.1) or at home (192.168.x.x, a .local name, a Tailscale
// .ts.net name, this computer's own name).

import { hostname, networkInterfaces } from "node:os";
import { isIP } from "node:net";

const HOME_SUFFIXES = [".local", ".lan", ".home", ".home.arpa", ".internal", ".ts.net"];

/** The hostname part of a Host header, lowercased; "" when it can't be read. */
export function hostOf(header: string | undefined): string {
  if (!header) return "";
  const h = header.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]"));          // [::1]:8420
  return h.replace(/:\d+$/, "");
}

/** Whether a request naming the station `host` should be served. */
export function allowedHost(host: string, extra: readonly string[] = []): boolean {
  if (!host) return false;
  if (isIP(host)) return true;
  const me = hostname().toLowerCase();
  if (host === "localhost" || host === me) return true;     // exact: "<me>.evil.com" is not me
  if (extra.map((x) => x.toLowerCase()).includes(host)) return true;
  return HOME_SUFFIXES.some((s) => host.endsWith(s));
}

/** URLs other screens on the home network can use, e.g. http://192.168.1.20:8420. */
export function lanUrls(port: number): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${port}`);
    }
  }
  return out;
}
