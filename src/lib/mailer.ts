import fs from "node:fs";
import path from "node:path";
import { flag } from "./flags";
import { sendEmail, type EmailMessage } from "./providers/email";
import { dataDir } from "./store";

/**
 * Mail Belline itself sends: password resets and alerts to the team.
 *
 * Real email goes out only when `email.transactional` is on and stubs are
 * off. Otherwise the message is written to `outbox.ndjson` beside the data,
 * in the same shape `stubMailer` in testing/stubs.ts reads, so a local run
 * can pick a reset link out of it and nothing ever reaches Resend.
 *
 * Callers must not tell anybody an email is on its way unless `delivered` is
 * true or they know the outbox is being read (a stubbed test run).
 */

export interface Delivery {
  delivered: boolean;
  via: "email" | "outbox" | "none";
  reason?: string;
}

export function realEmailOn(env: Record<string, string | undefined> = process.env): boolean {
  return flag("email.transactional", env) && !flag("stubs", env);
}

export function outboxFile(): string {
  return path.join(dataDir(), "outbox.ndjson");
}

/** Never throws. */
export async function deliverEmail(message: EmailMessage): Promise<Delivery> {
  if (!message.to.trim()) return { delivered: false, via: "none", reason: "no recipient" };
  if (realEmailOn()) {
    const out = await sendEmail(message);
    return out.sent ? { delivered: true, via: "email" } : { delivered: false, via: "email", reason: out.reason };
  }
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.appendFileSync(outboxFile(), `${JSON.stringify({ at: new Date().toISOString(), ...message })}\n`);
    return { delivered: false, via: "outbox" };
  } catch (err) {
    return { delivered: false, via: "none", reason: err instanceof Error ? err.message : String(err) };
  }
}
