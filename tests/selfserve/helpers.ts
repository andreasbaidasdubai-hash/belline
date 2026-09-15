import type { BrowserContext, Route } from "@playwright/test";
import { test as base, expect } from "@playwright/test";
import os from "node:os";
import path from "node:path";

/**
 * Shared setup for the self-serve journey specs.
 *
 * Two things every spec gets without asking. The server runs with stub
 * providers against a database that cannot exist, so nothing it does reaches
 * anyone. And the browser cannot reach a provider either: any request to a
 * known provider host, and any non-GET to a host that is not this machine,
 * is aborted and recorded, and the test fails if the app tried.
 */

/** Hosts the journey must never talk to from the browser. */
export const EXTERNAL =
  /(app\.belline\.ai|stripe\.com|graph\.facebook\.com|api\.twilio\.com|accounts\.google\.com|login\.microsoftonline\.com|api\.anthropic\.com|api\.resend\.com|api\.elevenlabs\.io|api\.deepgram\.com)/;

export const SELFSERVE_PORT = Number(process.env.SELFSERVE_PORT ?? 3117);

/** The server's environment for a stubbed run. Real provider keys are blanked, not inherited. */
export function selfserveEnv(runId = String(Date.now())): Record<string, string> {
  return {
    PORT: String(SELFSERVE_PORT),
    NODE_ENV: "development",
    DATA_DIR: path.join(os.tmpdir(), `belline-e2e-data-${runId}`),
    DATABASE_URL: "postgres://nobody:nothing@disabled.invalid:5432/none",
    FLAG_STUBS: "on",
    STUB_POOL: "+97140000001,+97140000002",
    TWILIO_AUTH_TOKEN: "stub-token",
    STRIPE_WEBHOOK_SECRET: "whsec_stub",
    TWILIO_ACCOUNT_SID: "",
    STRIPE_SECRET_KEY: "",
    ANTHROPIC_API_KEY: "",
    DEEPGRAM_API_KEY: "",
    ELEVENLABS_API_KEY: "",
    RESEND_API_KEY: "",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    GOOGLE_PLACES_API_KEY: "",
    WHATSAPP_ACCESS_TOKEN: "",
    WHATSAPP_APP_SECRET: "",
  };
}

export interface Aborted {
  method: string;
  url: string;
  external: boolean;
}

function isLocal(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Install the external-host block on a context. Returns the live list of aborted requests. */
export async function blockExternal(context: BrowserContext): Promise<Aborted[]> {
  const aborted: Aborted[] = [];
  await context.route("**/*", (route: Route) => {
    const request = route.request();
    let hostname = "";
    try {
      hostname = new URL(request.url()).hostname;
    } catch {
      return route.continue();
    }
    const external = EXTERNAL.test(hostname);
    if (!isLocal(hostname) && (request.method() !== "GET" || external)) {
      aborted.push({ method: request.method(), url: request.url(), external });
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  return aborted;
}

/**
 * `test` with the block installed on every context. After each test, a
 * non-GET the app sent towards a provider fails it: the journey must never
 * have needed one.
 */
export const test = base.extend<{ aborted: Aborted[] }>({
  aborted: [
    async ({ context }, use) => {
      const aborted = await blockExternal(context);
      await use(aborted);
      const writes = aborted.filter((a) => a.external && a.method !== "GET");
      expect(writes, `the app tried to write to a provider: ${writes.map((w) => `${w.method} ${w.url}`).join(", ")}`).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
