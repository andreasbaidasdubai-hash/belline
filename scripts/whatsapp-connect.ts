/**
 * Connect a WhatsApp number to a venue.
 *
 *   npm run whatsapp -- list
 *   npm run whatsapp -- connect --venue loc_lumiere --number +14155238886 --provider twilio
 *   npm run whatsapp -- connect --venue loc_lumiere --number +971... --provider meta \
 *                               --number-id 1065... --account-id 1022... --token EAAG...
 *   npm run whatsapp -- disconnect --number +14155238886
 *
 * This is the onboarding step that will eventually be a button. It exists as a
 * command first because the first business to connect is ours, and because a
 * screen that writes credentials is a screen that has to be designed carefully
 * — better to do that once the shape is known than to guess at it now.
 *
 * The token never touches the argument list in any form we keep: it is sealed
 * with CREDENTIALS_KEY before it reaches the database, and nothing that serves
 * a browser ever selects the column it lands in.
 */

import { isConfigured } from "../src/lib/db/client";
import { credentialsConfigured, sealCredentials } from "../src/lib/db/credentials";

if (!isConfigured()) {
  console.error("\n  DATABASE_URL is not set. Reception needs Postgres.\n");
  process.exit(1);
}

const { seedIfEmpty } = await import("../src/lib/seed");
const { getLocation, listLocations } = await import("../src/lib/store");
const { listAccounts, saveAccount, accountForInbound } = await import(
  "../src/lib/reception/repo"
);
const { query, close } = await import("../src/lib/db/client");
const { DEFAULT_TENANT_ID } = await import("../src/lib/tenancy");

seedIfEmpty();

const args = process.argv.slice(2);
const command = args[0] ?? "list";

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function bail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

switch (command) {
  case "list": {
    // Every tenant we know about — this is an operator's tool, not a route.
    const tenants = new Set(
      listLocations({ includeInternal: true }).map((l) => l.tenantId),
    );
    let found = 0;
    for (const tenantId of tenants) {
      for (const a of await listAccounts(tenantId)) {
        found++;
        const venue = a.locationId ? getLocation(a.locationId)?.name : "(no venue)";
        console.log(
          `\n  ${a.phoneE164 ?? "(no number)"}  ${a.channel} via ${a.provider}` +
            `\n    venue    ${venue}` +
            `\n    business ${a.businessId}  tenant ${a.tenantId}` +
            `\n    status   ${a.status}, Belline ${a.aiEnabled ? "answers" : "is off"}`,
        );
      }
    }
    console.log(found ? "" : "\n  No numbers connected yet.\n");
    break;
  }

  case "connect": {
    const venueId = flag("venue") ?? bail("Which venue? --venue loc_lumiere");
    const number = flag("number") ?? bail("Which number? --number +14155238886");
    const provider = (flag("provider") ?? "twilio") as "twilio" | "meta";

    const venue = getLocation(venueId);
    if (!venue) {
      bail(
        `No venue "${venueId}". Known: ` +
          listLocations({ includeInternal: true })
            .map((l) => l.id)
            .join(", "),
      );
    }
    if (!/^\+[1-9]\d{6,14}$/.test(number)) {
      bail(`"${number}" is not an E.164 number. It needs the leading + and the country code.`);
    }

    const existing = await accountForInbound("whatsapp", { phoneE164: number });
    if (existing && existing.tenantId !== venue.tenantId) {
      bail("That number is already connected to a different Belline account.");
    }

    const token = flag("token");
    let credentialsEnc: string | undefined;
    if (token) {
      if (!credentialsConfigured()) {
        bail(
          "CREDENTIALS_KEY is not set, so a token cannot be stored safely. Generate one with:\n" +
            "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
        );
      }
      credentialsEnc = sealCredentials(
        provider === "meta"
          ? { accessToken: token, phoneNumberId: flag("number-id") ?? "" }
          : // Twilio falls back to the account-wide credentials already in the
            // environment for voice and SMS, so a token here is optional.
            { accountSid: flag("account-sid") ?? "", authToken: token, from: number },
      );
    }

    const account = await saveAccount({
      tenantId: venue.tenantId,
      businessId: venue.businessId,
      locationId: venue.id,
      channel: "whatsapp",
      provider,
      phoneE164: number,
      externalAccountId: flag("account-id"),
      externalNumberId: flag("number-id"),
      credentialsEnc,
    });

    console.log(
      `\n  ${number} → ${venue.name}` +
        `\n    provider    ${provider}` +
        `\n    credentials ${credentialsEnc ? "stored, encrypted" : provider === "twilio" ? "using the account-wide Twilio credentials" : "NONE — sending will fail"}` +
        `\n    account id  ${account.id}` +
        `\n\n  Webhook to register with the provider:` +
        `\n    https://app.belline.ai/api/whatsapp/webhook\n`,
    );
    break;
  }

  case "disconnect": {
    const number = flag("number") ?? bail("Which number? --number +14155238886");
    const account = await accountForInbound("whatsapp", { phoneE164: number });
    if (!account) bail(`${number} is not connected.`);
    await query(
      "update channel_account set status = 'revoked', credentials_enc = null, updated_at = now() where id = $1",
      [account.id],
    );
    console.log(`\n  ${number} disconnected and its credentials erased.\n`);
    break;
  }

  default:
    bail(`Unknown command "${command}". Try: list, connect, disconnect`);
}

await close();
process.exit(0);

// Referenced so the import is not dropped by a bundler that thinks it is unused.
void DEFAULT_TENANT_ID;
