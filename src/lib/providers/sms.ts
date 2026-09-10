/**
 * Confirmation messages.
 *
 * A booking reference read aloud over a phone is written down wrong often
 * enough to matter — and a caller with no written confirmation rings back to
 * check, which costs the venue the call the agent just saved them. One text
 * closes that loop.
 *
 * Raw REST rather than the Twilio SDK: this is one authenticated POST, and a
 * whole SDK for it would be the largest dependency in the project.
 */

export function smsEnabled(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_SMS_FROM,
  );
}

export interface SmsResult {
  sent: boolean;
  reason?: string;
}

/**
 * Never throws. A confirmation that fails to send must not take down the call
 * it is confirming — the booking is already made and the caller is still on
 * the line.
 */
export async function sendSms(to: string, body: string): Promise<SmsResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_SMS_FROM;

  if (!sid || !token || !from) {
    return { sent: false, reason: "SMS is not configured." };
  }

  const digits = to.replace(/[^\d+]/g, "");
  if (digits.replace(/\D/g, "").length < 8) {
    return { sent: false, reason: "That number is too short to text." };
  }

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: digits, From: from, Body: body.slice(0, 600) }),
        // A hung SMS request must not hold a live call open.
        signal: AbortSignal.timeout(6000),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return { sent: false, reason: `Twilio ${response.status}: ${detail.slice(0, 160)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
