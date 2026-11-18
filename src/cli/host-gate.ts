// The host gate: notyours only drives personas against hosts the user owns. Shared by the CLI and the
// ratchet (every replay path, including the Stop hook), so no caller can skip it.
import { parseTarget } from '../engine/oracle.js';
import type { Boundary, Config } from '../types.js';
import { hostOf, isLocalHost } from './hosts.js';
import { isOwnedHost } from './owned.js';
import { UserError } from './workspace.js';

/** Dotted words in objectives that are file names, not hosts (index.html, page.tsx). */
// Only extensions that are NOT delegated TLDs (.md .py .zip .go .mov are real TLDs, so they stay hosts).
const FILE_EXT = new Set(['html', 'htm', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'yaml', 'yml', 'css', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf', 'csv', 'txt', 'xml', 'php', 'rb']);

/**
 * Hosts a boundary will make Kane visit: absolute URLs in targets and objectives, plus (deny by default)
 * every hostname-like token or IPv4 address in the objectives, with or without a scheme or slash.
 * Email domains (alice@demo.test) are not navigation targets and are skipped.
 */
export function boundaryUrls(b: Boundary): string[] {
  // NFKC maps fullwidth letters/dots to ASCII; the other ideographic full stops are mapped by hand.
  const objectives = nfkc([b.create.objective, b.proAction?.objective ?? ''].join('\n'));
  const text = [objectives, ...b.targets.ui, ...b.targets.api, ...(b.viewerOwn?.ui ?? []), ...(b.viewerOwn?.api ?? [])].map(nfkc).join('\n');
  const urls = [...text.matchAll(/https?:\/\/[^\s'"`<>)]+/gi)].map((m) => m[0].replace(/[.,;]+$/, ''));
  // Unicode-aware: internationalised names are checked as the punycode host the browser would use.
  const hostTokens = [...objectives.matchAll(/(?<![\p{L}\p{N}_@.-])((?:[\p{L}\p{N}-]+\.)+\p{L}{2,}|\d{1,3}(?:\.\d{1,3}){3})(?![\p{L}\p{N}_-]*@)(?![\p{L}\p{N}])/gu)]
    .map((m) => toAsciiHost(m[1]!))
    .filter((h) => /^\d/.test(h) || !FILE_EXT.has(h.slice(h.lastIndexOf('.') + 1)))
    .map((h) => `http://${h}/`);
  return [...new Set([...urls, ...hostTokens])];
}

const nfkc = (s: string) => s.normalize('NFKC').replace(/[\u3002\uFF0E\uFF61]/g, '.');

/** Host as the URL parser sees it (lowercase, punycode); unparseable tokens stay as-is and fail the check. */
function toAsciiHost(token: string): string {
  try {
    return new URL(`http://${token}/`).hostname;
  } catch {
    return token.toLowerCase();
  }
}

/** A target is an absolute http(s) URL, or exactly a stored value optionally followed by a path/query. */
export const TARGET_RE = /^(?:https?:\/\/.+|\{\{\s*[A-Za-z_][\w.]*\s*\}\}(?:[/?#].*)?)$/i;

/**
 * Refuse to probe hosts we may not touch: the base URL and every URL in the boundaries must be in
 * allowHosts, and a non-local host must also be confirmed on this machine (`init --i-own-this`, stored
 * outside the repo). Fails closed on unparseable URLs and templated hosts.
 */
export function assertHostsAllowed(cfg: Config, boundaries: Boundary[], root: string): void {
  const allowed = new Set(cfg.allowHosts.map((h) => h.toLowerCase()));
  const check = (url: string, where: string) => {
    if (/^https?:\/\/[^/]*\{\{/i.test(url)) throw new UserError(`${where}: the host in ${url} is a template; only paths may use {{variables}}.`);
    let host: string;
    try {
      host = hostOf(url);
    } catch {
      throw new UserError(`${where}: can't parse URL ${url}`);
    }
    if (!allowed.has(host)) throw new UserError(`${where} points at ${host}, which is not in allowHosts (${cfg.allowHosts.join(', ')}). notyours only tests apps you own.`);
    if (!isLocalHost(host) && !isOwnedHost(root, host)) {
      throw new UserError(`${where} points at ${host}, which hasn't been confirmed on this machine. If you own it: notyours init --url ${cfg.baseUrl} --allow-host ${host} --i-own-this`);
    }
  };
  check(cfg.baseUrl, 'config.yaml baseUrl');
  for (const b of boundaries) {
    // api targets may carry an HTTP method (CC-2: "POST http://host/api/export"); the gate checks the URL.
    const apiUrls = b.targets.api.map((a) => parseTarget(nfkc(a)).url);
    for (const t of [...b.targets.ui.map(nfkc), ...apiUrls]) {
      if (!TARGET_RE.test(t) || /[\s'"`<>()\\]/.test(t)) {
        throw new UserError(`boundary ${b.id}: target "${t}" must be an absolute http(s) URL, or a {{stored}} value optionally followed by /path`);
      }
      if (/^https?:\/\/[^/]*\{\{/i.test(t)) throw new UserError(`boundary ${b.id}: the host in ${t} is a template; only paths may use {{variables}}.`);
      if (/^https?:/i.test(t)) {
        // Check the host the browser would actually use, parsed from the whole target string.
        let u: URL;
        try {
          u = new URL(t.replace(/\{\{[^}]*\}\}/g, 'x'));
        } catch {
          throw new UserError(`boundary ${b.id}: can't parse target ${t}`);
        }
        if (u.username || u.password) throw new UserError(`boundary ${b.id}: target ${t} contains credentials (user@host)`);
        check(`${u.protocol}//${u.host}/`, `boundary ${b.id}`);
      }
    }
    for (const u of boundaryUrls(b)) check(u, `boundary ${b.id}`);
  }
}
