import { randomUUID } from "node:crypto";

/**
 * What an owner is told when something behind the screen goes wrong.
 *
 * An SDK's error text is written for the engineer who installed the SDK:
 * "401 invalid x-api-key", "connect ECONNREFUSED 10.0.0.4:443", "Expected one
 * of …". Shown to a salon owner it says nothing they can act on, and some of
 * it (env names, hosts, stack frames) is ours to keep. So every failure an
 * owner can reach goes through here: the raw error is logged with a trace id,
 * and the owner gets one plain sentence and the next thing to do.
 *
 * Errors we wrote for the customer on purpose ("That page does not exist.
 * Check the address.") are thrown as `CustomerError` and pass through as they
 * are. Anything else is treated as internal, whatever it says.
 */

export type Provider = "import" | "model" | "google" | "stripe" | "messaging" | "setup";

export type Kind = "unavailable" | "not_configured" | "refused" | "declined" | "failed";

export interface CustomerMessage {
  /** One sentence, plain, active voice. Safe to render. */
  message: string;
  /** What to do next, as a sentence. */
  next: string;
  /** Quoted in the log line, so a report can be matched to the raw error. */
  traceId: string;
}

/** An error whose message was written for the customer and may be shown as it is. */
export class CustomerError extends Error {
  readonly customer = true;
}

const COPY: Record<Provider, Partial<Record<Kind, [string, string]>> & { failed: [string, string] }> = {
  import: {
    not_configured: [
      "Reading websites and documents is being prepared for your account.",
      "Set it up by hand for now. It takes a few minutes.",
    ],
    failed: ["Belline could not read that just now.", "Try again in a minute, or set it up by hand."],
  },
  model: {
    not_configured: ["Belle's setup help is not switched on yet.", "You can fill everything in yourself on the setup form."],
    failed: ["Belle could not answer just then.", "Try again in a moment."],
  },
  google: {
    not_configured: ["Google Calendar is not available on this account yet.", "Your bookings stay in Belline's diary in the meantime."],
    refused: [
      "Google did not allow the connection.",
      "Connect again, and on Google's screen choose Allow with both permissions ticked: seeing your calendars and adding events.",
    ],
    declined: [
      "No problem — requests for now.",
      "Belline takes the details and your team confirms. You can connect Google Calendar whenever you like.",
    ],
    // Also what a connection that was interrupted says: a restart or a deploy
    // between "Connect" and Google's answer, or a link opened twice.
    failed: ["Google Calendar could not be connected just now.", "Please connect again. If it happens twice, wait a few minutes first."],
    unavailable: ["Google Calendar could not be reached just now.", "Try again in a few minutes."],
  },
  stripe: {
    not_configured: ["Card payments are not switched on yet.", "Nothing is charged until they are."],
    failed: ["Card payment setup could not start just now.", "Try again in a minute."],
  },
  messaging: {
    not_configured: ["Messages are not switched on for this account yet.", "Phone calls are answered as normal."],
    failed: ["Messages cannot be loaded right now.", "Phone calls are still being answered. Reload this page in a minute."],
  },
  setup: {
    failed: ["That could not be saved.", "Try again. Nothing you typed has been lost."],
  },
};

/** Text that must never reach a customer. check:customer-copy scans for the same list. */
export const INTERNAL_TEXT: RegExp[] = [
  /[A-Z][A-Z0-9]*_(API_)?(KEY|SECRET|TOKEN|URL|ID)\b/,
  /Expected one of/i,
  /\bE(CONN\w*|NOTFOUND|TIMEDOUT|AI_AGAIN)\b/,
  /\n\s+at\s/,
  /x-api-key|invalid_request_error|authentication_error/i,
  /^\d{3}\s*[{[]/,
];

export function looksInternal(text: string): boolean {
  return INTERNAL_TEXT.some((re) => re.test(text));
}

/** Email addresses and long digit runs out of anything logged. */
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]")
    .replace(/(sk|pk|rk|whsec)_(live|test)_\w+/g, "[key]");
}

const repeats = new Map<string, number>();
/** After this many of the same failure, it is an exception for the team, not noise. */
export const EXCEPTION_AFTER = 3;

/**
 * Log that something needs a person at Belline. There is no exception queue
 * yet, so this is a log line in a fixed shape the ops tooling can grep for.
 * Deduplicated per key for the life of the process.
 */
const raised = new Set<string>();
export function raiseException(key: string, detail: string): boolean {
  if (raised.has(key)) return false;
  raised.add(key);
  console.error(`[exception] ${key}: ${redact(detail)}`);
  return true;
}

/**
 * Turn a failure into what the owner sees. Logs the raw error; never returns it
 * unless it is a `CustomerError` with nothing internal in it.
 */
export function customerError(provider: Provider, err: unknown, kind: Kind = "failed", scope = ""): CustomerMessage {
  const traceId = randomUUID().slice(0, 8);
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? "");
  console.error(`[${provider}] trace=${traceId}${scope ? ` scope=${scope}` : ""} kind=${kind}: ${redact(raw)}`);

  const key = `${provider}:${kind}`;
  const count = (repeats.get(key) ?? 0) + 1;
  repeats.set(key, count);
  if (count >= EXCEPTION_AFTER) raiseException(key, `${count} failures, latest trace ${traceId}`);

  const [message, next] = COPY[provider][kind] ?? COPY[provider].failed;
  if (err instanceof CustomerError && err.message && !looksInternal(err.message)) {
    return { message: err.message, next, traceId };
  }
  return { message, next, traceId };
}

/** For tests: forget the repeat counts and raised exceptions. */
export function resetCustomerErrors(): void {
  repeats.clear();
  raised.clear();
}

/**
 * The `?error=` codes the integrations page understands. The URL carries a
 * code, never a message: a message in a query string is a message anybody can
 * write, and the old one was Google's own text.
 */
export const INTEGRATION_ERRORS: Record<string, [Provider, Kind]> = {
  google_unavailable: ["google", "not_configured"],
  google_refused: ["google", "refused"],
  google_declined: ["google", "declined"],
  google_failed: ["google", "failed"],
  payments_off: ["stripe", "not_configured"],
  payments_failed: ["stripe", "failed"],
};

export function integrationErrorText(code: string | undefined): string | null {
  if (!code) return null;
  const [provider, kind] = INTEGRATION_ERRORS[code] ?? ["setup", "failed"];
  const [message, next] = COPY[provider][kind] ?? COPY[provider].failed;
  return provider === "setup" ? "Something did not work just then. Try again." : `${message} ${next}`;
}
