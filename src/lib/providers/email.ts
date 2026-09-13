/**
 * Transactional email: booking confirmations, changes, cancellations.
 *
 * Resend's REST API with a raw fetch, for the same reason SMS is raw Twilio:
 * one authenticated POST does not justify an SDK. Not the cold-outreach
 * provider — that one lives on a separate, warmed domain on purpose, and a
 * guest's confirmation must never share a reputation with a sales email.
 *
 * Inert without `RESEND_API_KEY`, like every other provider here.
 */

export function emailEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Where a guest's reply goes. The venue, ideally, never a no-reply void. */
  replyTo?: string;
  attachments?: { filename: string; content: string; contentType?: string }[];
}

/** Never throws. A confirmation that fails must not undo a booking that succeeded. */
export async function sendEmail(message: EmailMessage): Promise<{ sent: boolean; reason?: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: "Email is not configured." };

  const from = process.env.EMAIL_FROM || "Belline <bookings@belline.ai>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        ...(message.attachments?.length
          ? {
              attachments: message.attachments.map((a) => ({
                filename: a.filename,
                content: Buffer.from(a.content, "utf8").toString("base64"),
                ...(a.contentType ? { content_type: a.contentType } : {}),
              })),
            }
          : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { sent: false, reason: `Resend ${res.status}: ${detail.slice(0, 160)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
