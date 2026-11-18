// Host allow-listing: notyours only probes apps you own. Localhost is allowed by default;
// any other host must be listed in allowHosts AND confirmed with --i-own-this.

export const LOCAL_HOSTS = ['localhost', '127.0.0.1'] as const;

export type HostCheck = { ok: true; host: string } | { ok: false; host: string; reason: string };

export function hostOf(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Only http(s) URLs are supported: ${url}`);
  return u.hostname.toLowerCase();
}

export function isLocalHost(host: string): boolean {
  return (LOCAL_HOSTS as readonly string[]).includes(host);
}

/**
 * Decide whether `url` may be probed.
 * - host not in allowHosts: refused.
 * - host in allowHosts and local (localhost/127.0.0.1): allowed.
 * - host in allowHosts but remote: allowed only with iOwnThis.
 */
export function checkHost(url: string, allowHosts: readonly string[], iOwnThis: boolean): HostCheck {
  const host = hostOf(url);
  const allowed = allowHosts.map((h) => h.toLowerCase()).includes(host);
  if (!allowed) {
    return {
      ok: false,
      host,
      reason:
        `${host} is not in allowHosts (${allowHosts.join(', ') || 'empty'}). notyours only tests apps you own.\n` +
        `  If you own ${host}: notyours init --url ${url} --allow-host ${host} --i-own-this`,
    };
  }
  if (!isLocalHost(host) && !iOwnThis) {
    return {
      ok: false,
      host,
      reason: `${host} is not localhost. Confirm you own it and may test it: add --i-own-this`,
    };
  }
  return { ok: true, host };
}
