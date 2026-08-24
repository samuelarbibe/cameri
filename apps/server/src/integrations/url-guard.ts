import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";

/**
 * Decides whether the server is willing to make a request to a URL somebody
 * else chose.
 *
 * An integration's base URL is the one place where a value that arrived over
 * the network becomes a destination this process connects to, carrying a
 * credential. Left open that is a request forgery: the server sits inside the
 * network the caller is trying to reach, so `http://169.254.169.254/` or
 * `http://10.0.0.5:6379/` are addresses it can reach and they cannot.
 *
 * The awkward part is that a self-hosted GitLab is *usually* on exactly the
 * private network we would otherwise refuse to touch. So there are two modes,
 * and the operator picks by whether they set `CAMERI_INTEGRATION_HOSTS`:
 *
 *   set    — that list is the whole answer. Any host on it is allowed, private
 *            or not, because naming it is a deliberate act.
 *   unset  — public addresses only, which is the right default for gitlab.com
 *            and refuses to be turned into a port scanner.
 */

export class BlockedIntegrationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedIntegrationUrlError";
  }
}

/** Hostnames the operator has vouched for, parsed once from the env value. */
export function parseAllowedHosts(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Ranges that are never a GitLab someone meant to name.
 *
 * Loopback and link-local are the ones that matter — cloud metadata lives on
 * `169.254.169.254` and every sidecar in the pod is on `127.0.0.1` — but the
 * RFC1918 and carrier-grade blocks are here too, because "the database" is as
 * interesting a target as the metadata service.
 */
function isPrivateIPv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  if (a === undefined || b === undefined) return true;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224;
}

/**
 * The IPv4 address inside an IPv4-mapped IPv6 address, or null.
 *
 * These arrive in two notations and both have to be understood. Resolvers on a
 * dual-stack host produce the readable one, `::ffff:127.0.0.1` — but `new URL`
 * rewrites it to `::ffff:7f00:1` before anything here ever sees it, so reading
 * only the readable form is the same as reading neither.
 */
function mappedIPv4(value: string): string | null {
  const hex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex?.[1] && hex[2]) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }

  return value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1] ?? null;
}

function isPrivateIPv6(address: string): boolean {
  const value = address.toLowerCase().split("%")[0] ?? "";

  const mapped = mappedIPv4(value);
  if (mapped) return isPrivateIPv4(mapped);

  if (value === "::1" || value === "::") return true;
  return /^(f[cd]|fe[89ab]|ff)/.test(value);
}

function isPrivate(address: string): boolean {
  return isIPv4(address) ? isPrivateIPv4(address) : isPrivateIPv6(address);
}

/**
 * Throws unless the server should be willing to call this URL.
 *
 * Resolution happens here rather than being left to `fetch`, because the
 * hostname is not the thing that has to be safe — the address it points at is,
 * and `evil.example.com A 127.0.0.1` is a two-minute DNS change. Every address
 * behind the name has to pass, not just the first.
 *
 * This is a check before a connection, not a connection, so a name that
 * resolves differently a moment later slips past. Closing that properly means
 * pinning the socket to the address we validated; the allowlist is the answer
 * for anyone who needs that guarantee.
 */
export async function assertReachableIntegrationUrl(
  raw: string,
  allowedHosts: Set<string>,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedIntegrationUrlError("not a URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BlockedIntegrationUrlError(`${url.protocol} is not a supported scheme`);
  }

  // Credentials in the URL would be a second, unencrypted place a secret could
  // end up — in `baseUrl`, which the dashboard displays in clear.
  if (url.username || url.password) {
    throw new BlockedIntegrationUrlError("credentials in the URL are not accepted");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (allowedHosts.has(hostname)) return url;

  if (allowedHosts.size > 0) {
    throw new BlockedIntegrationUrlError(
      `${hostname} is not in CAMERI_INTEGRATION_HOSTS`,
    );
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new BlockedIntegrationUrlError(`${hostname} does not resolve`);
  }

  if (addresses.some(({ address }) => isPrivate(address))) {
    throw new BlockedIntegrationUrlError(
      `${hostname} resolves to a private or loopback address. If that is really ` +
        "where your GitLab lives, add the host to CAMERI_INTEGRATION_HOSTS.",
    );
  }

  return url;
}
