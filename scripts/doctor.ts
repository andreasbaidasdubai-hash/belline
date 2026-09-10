/**
 * Preflight for a real phone call.
 *
 * Checks every credential by actually calling the provider, not by checking
 * that an environment variable is non-empty. A key that is present but wrong,
 * expired, or out of credit is the common failure and looks identical to a
 * working one until a caller is on the line.
 *
 *   npm run doctor
 */

// Marks the file as a module so top-level await is legal.
export {};

const results: { name: string; ok: boolean; detail: string; fix?: string }[] = [];

function record(name: string, ok: boolean, detail: string, fix?: string) {
  results.push({ name, ok, detail, fix });
}

async function ping(
  name: string,
  url: string,
  headers: Record<string, string>,
  fix: string,
): Promise<void> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      record(name, true, "key works");
      return;
    }
    const body = await res.text().catch(() => "");
    record(
      name,
      false,
      res.status === 401 || res.status === 403
        ? `rejected (${res.status}) — the key is wrong or revoked`
        : `HTTP ${res.status} ${body.slice(0, 90)}`,
      fix,
    );
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err), fix);
  }
}

// --- the brain -------------------------------------------------------------

if (!process.env.ANTHROPIC_API_KEY) {
  record("Model (Anthropic)", false, "ANTHROPIC_API_KEY not set", "console.anthropic.com → API keys");
} else {
  await ping(
    "Model (Anthropic)",
    "https://api.anthropic.com/v1/models",
    {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    "console.anthropic.com → API keys. Check the account has credit.",
  );
}

// --- ears ------------------------------------------------------------------

if (!process.env.DEEPGRAM_API_KEY) {
  record("Speech-in (Deepgram)", false, "DEEPGRAM_API_KEY not set", "console.deepgram.com → API keys");
} else {
  await ping(
    "Speech-in (Deepgram)",
    "https://api.deepgram.com/v1/projects",
    { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
    "console.deepgram.com → API keys",
  );
}

// --- voice -----------------------------------------------------------------

if (!process.env.ELEVENLABS_API_KEY) {
  record("Speech-out (ElevenLabs)", false, "ELEVENLABS_API_KEY not set", "elevenlabs.io → Profile → API key");
} else {
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      record("Speech-out (ElevenLabs)", false, `rejected (${res.status})`, "elevenlabs.io → Profile → API key");
    } else {
      const sub = (await res.json()) as {
        tier?: string;
        character_count?: number;
        character_limit?: number;
      };
      const left = (sub.character_limit ?? 0) - (sub.character_count ?? 0);
      record(
        "Speech-out (ElevenLabs)",
        left > 0,
        left > 0
          ? `key works · ${sub.tier ?? "unknown"} tier · ${left.toLocaleString()} characters left`
          : `out of characters on the ${sub.tier ?? "current"} tier`,
        left > 0 ? undefined : "Top up or upgrade at elevenlabs.io",
      );
    }
  } catch (err) {
    record("Speech-out (ElevenLabs)", false, err instanceof Error ? err.message : String(err));
  }
}

// --- telephony -------------------------------------------------------------

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;

if (!sid || !token) {
  record(
    "Telephony (Twilio)",
    false,
    "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set",
    "twilio.com → Console. Upgrade off trial, or every call opens with a warning message.",
  );
} else {
  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`,
      { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      record("Telephony (Twilio)", false, `rejected (${res.status})`, "Check the SID and auth token");
    } else {
      const acc = (await res.json()) as { status?: string; type?: string };
      const live = acc.type !== "Trial";
      record(
        "Telephony (Twilio)",
        acc.status === "active",
        `account ${acc.status}${live ? "" : " · TRIAL — callers hear a warning first"}`,
        live ? undefined : "Upgrade the account before demoing to anyone.",
      );

      // Which numbers can actually receive a call?
      const nums = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/IncomingPhoneNumbers.json?PageSize=20`,
        { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(10_000) },
      );
      if (nums.ok) {
        const data = (await nums.json()) as {
          incoming_phone_numbers?: {
            phone_number: string;
            voice_url?: string;
            capabilities?: { voice?: boolean; sms?: boolean };
          }[];
        };
        const list = data.incoming_phone_numbers ?? [];
        if (list.length === 0) {
          record("Phone number", false, "no numbers on the account", "Twilio Console → Phone Numbers → Buy a number (Voice)");
        } else {
          for (const n of list) {
            const wired = Boolean(n.voice_url && /\/api\/twilio\/voice/.test(n.voice_url));
            record(
              `Number ${n.phone_number}`,
              wired,
              wired
                ? `webhook → ${n.voice_url}`
                : n.voice_url
                  ? `webhook points elsewhere: ${n.voice_url}`
                  : "no voice webhook set",
              wired ? undefined : "Set the Voice webhook to POST <your-host>/api/twilio/voice",
            );
          }
        }
      }
    }
  } catch (err) {
    record("Telephony (Twilio)", false, err instanceof Error ? err.message : String(err));
  }
}

// --- reachability ----------------------------------------------------------

// Not `origin` — that is a DOM global and shadowing it is a type error.
const publicOrigin = process.env.PUBLIC_WS_ORIGIN;
if (!publicOrigin) {
  record(
    "Public address",
    false,
    "PUBLIC_WS_ORIGIN not set",
    "Twilio dials in from the internet and cannot reach localhost. Run a tunnel or deploy.",
  );
} else if (!publicOrigin.startsWith("wss://")) {
  record(
    "Public address",
    false,
    `must start with wss:// — got ${publicOrigin}`,
    "Use the wss:// form of your public host.",
  );
} else {
  const https = publicOrigin.replace(/^wss:/, "https:");
  try {
    const res = await fetch(`${https}/api/twilio/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "From=%2B10000000000&To=%2B10000000001&CallSid=doctor",
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text().catch(() => "");
    if (res.status === 403) {
      // The signature check is doing its job — the endpoint is reachable.
      record("Public address", true, `${https} reachable · webhook rejects unsigned requests (correct)`);
    } else if (res.ok && body.includes("<Stream")) {
      record("Public address", true, `${https} reachable · webhook returns TwiML`);
      if (!process.env.TWILIO_AUTH_TOKEN) {
        record(
          "Webhook security",
          false,
          "webhook accepts unsigned requests",
          "Set TWILIO_AUTH_TOKEN — without it anyone who guesses the URL can start billed calls.",
        );
      }
    } else {
      record("Public address", false, `${https} answered ${res.status}`, "Is the server running behind that host?");
    }
  } catch (err) {
    record("Public address", false, `cannot reach ${https}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- optional --------------------------------------------------------------

record(
  "SMS confirmations",
  Boolean(process.env.TWILIO_SMS_FROM),
  process.env.TWILIO_SMS_FROM ? `from ${process.env.TWILIO_SMS_FROM}` : "off — bookings are confirmed by voice only",
  process.env.TWILIO_SMS_FROM ? undefined : "Optional. Set TWILIO_SMS_FROM to an SMS-capable Twilio number.",
);

// --- report ----------------------------------------------------------------

console.log("\n  Belline preflight\n");
for (const r of results) {
  console.log(`   ${r.ok ? "✓" : "✗"} ${r.name.padEnd(28)} ${r.detail}`);
  if (!r.ok && r.fix) console.log(`     ${" ".repeat(28)} → ${r.fix}`);
}

const blockers = results.filter((r) => !r.ok && r.name !== "SMS confirmations");
console.log("");
if (blockers.length === 0) {
  console.log("   Everything a real call needs is in place. Dial the number.\n");
} else {
  console.log(
    `   ${blockers.length} thing${blockers.length === 1 ? "" : "s"} still between you and a ringing phone.\n`,
  );
}
process.exit(blockers.length === 0 ? 0 : 1);
