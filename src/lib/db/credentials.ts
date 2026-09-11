import crypto from "node:crypto";

/**
 * Provider credentials, encrypted at rest.
 *
 * A WhatsApp access token is a bearer credential for somebody else's business
 * phone number. Stored in plaintext it is readable by anything that can read
 * the database — a backup, a support query, a `select *` in a console — and
 * the blast radius of one leaked row is one customer's entire WhatsApp
 * presence. So it is encrypted with a key that lives in the environment and
 * never in the database, which means a copy of the database on its own is not
 * enough to send a message as anybody.
 *
 * AES-256-GCM rather than CBC: the tag detects tampering, and a credential
 * that has been altered should fail loudly rather than decrypt to rubbish and
 * get sent to a provider.
 *
 * The key is 32 bytes, base64, in CREDENTIALS_KEY. Generate one with:
 *
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Losing it means re-connecting every channel, not losing customer data — the
 * conversations, bookings and customers are not encrypted, because they are
 * what the product is for and encrypting them would mean the application could
 * not read its own book.
 */

const VERSION = "v1";

function key(): Buffer {
  const raw = process.env.CREDENTIALS_KEY;
  if (!raw) {
    throw new Error(
      "CREDENTIALS_KEY is not set. Channel credentials cannot be stored without it — " +
        "generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      `CREDENTIALS_KEY must decode to 32 bytes, got ${buf.length}. It is base64 of 32 random bytes.`,
    );
  }
  return buf;
}

/** True when credentials can be stored at all. Checked before offering to connect a channel. */
export function credentialsConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt a credential bundle.
 *
 * The whole object rather than field by field: a provider's credentials are
 * used together, and one encrypted blob is one thing to get right rather than
 * four.
 */
export function sealCredentials(value: Record<string, string>): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), body.toString("base64")].join(
    ".",
  );
}

/**
 * Decrypt, or throw.
 *
 * Never returns a partial or a default. A caller that cannot get the
 * credentials must not fall through to sending with whatever it has —
 * that is how a message goes out on the wrong account.
 */
export function openCredentials(sealed: string): Record<string, string> {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || !body) {
    throw new Error("Stored credential is not in a format this build understands.");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(body, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plain) as Record<string, string>;
}
