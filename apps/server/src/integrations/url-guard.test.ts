import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertReachableIntegrationUrl,
  BlockedIntegrationUrlError,
  parseAllowedHosts,
} from "./url-guard.ts";

/** Asserts the URL is refused, and returns why, so the reason can be asserted too. */
async function refusal(url: string, hosts = new Set<string>()): Promise<string> {
  try {
    await assertReachableIntegrationUrl(url, hosts);
  } catch (error) {
    assert.ok(error instanceof BlockedIntegrationUrlError, `wrong error type for ${url}`);
    return error.message;
  }
  return assert.fail(`expected ${url} to be refused`);
}

describe("parseAllowedHosts", () => {
  it("is empty when unset, which means 'public addresses only'", () => {
    assert.equal(parseAllowedHosts(undefined).size, 0);
    assert.equal(parseAllowedHosts("  ,  ").size, 0);
  });

  it("trims and lowercases, because these are typed into a compose file", () => {
    assert.deepEqual(
      [...parseAllowedHosts(" GitLab.Internal , 10.0.0.5 ")],
      ["gitlab.internal", "10.0.0.5"],
    );
  });
});

describe("assertReachableIntegrationUrl", () => {
  it("allows a public host", async () => {
    const url = await assertReachableIntegrationUrl("https://gitlab.com", new Set());
    assert.equal(url.hostname, "gitlab.com");
  });

  it("refuses the cloud metadata address", async () => {
    assert.match(await refusal("http://169.254.169.254/latest/meta-data/"), /private or loopback/);
  });

  it("refuses loopback, by name and by literal", async () => {
    assert.match(await refusal("http://127.0.0.1:6379/"), /private or loopback/);
    assert.match(await refusal("http://localhost:5432/"), /private or loopback/);
    assert.match(await refusal("http://[::1]/"), /private or loopback/);
  });

  it("refuses the RFC1918 ranges", async () => {
    for (const host of ["10.0.0.5", "172.16.4.4", "192.168.1.1", "100.64.0.1"]) {
      assert.match(await refusal(`http://${host}/`), /private or loopback/, host);
    }
  });

  it("refuses an IPv4 address smuggled in as IPv6", async () => {
    // `new URL` normalises this to `[::ffff:7f00:1]`, so the guard has to read
    // the hex notation as well as the dotted one.
    assert.match(await refusal("http://[::ffff:127.0.0.1]/"), /private or loopback/);
    assert.match(await refusal("http://[::ffff:a9fe:a9fe]/"), /private or loopback/);
  });

  it("allows a private address once the operator names it", async () => {
    const hosts = parseAllowedHosts("gitlab.internal,10.0.0.5");
    const url = await assertReachableIntegrationUrl("https://10.0.0.5/", hosts);
    assert.equal(url.hostname, "10.0.0.5");
  });

  it("treats a configured allowlist as exhaustive", async () => {
    // gitlab.com is public and would pass on its own — the point is that
    // naming any host at all narrows the field to exactly those hosts.
    assert.match(
      await refusal("https://gitlab.com", parseAllowedHosts("gitlab.internal")),
      /not in CAMERI_INTEGRATION_HOSTS/,
    );
  });

  it("refuses schemes that are not http", async () => {
    assert.match(await refusal("file:///etc/passwd"), /not a supported scheme/);
    assert.match(await refusal("gopher://gitlab.com/"), /not a supported scheme/);
  });

  it("refuses credentials in the URL, which the dashboard would display", async () => {
    assert.match(await refusal("https://root:hunter2@gitlab.com/"), /credentials in the URL/);
  });

  it("refuses something that is not a URL at all", async () => {
    assert.match(await refusal("gitlab.com"), /not a supported scheme|not a URL/);
  });
});
