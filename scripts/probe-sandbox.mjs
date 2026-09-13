// railway run --service belline node scripts/probe-sandbox.mjs [+971…]
// Prove our half of the Twilio sandbox without the console: check the Twilio
// credentials are live, then post a correctly signed "sandbox message" to the
// production webhook, exactly as Twilio would. Run with `railway run` so the
// auth token comes from the service's own environment and is never printed.
import crypto from "node:crypto";

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
if (!sid || !token) {
  console.log("missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN in this environment");
  process.exit(1);
}
const auth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");

// 1. Are the credentials good, and is the account active?
const acct = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, { headers: { authorization: auth } });
const acctBody = await acct.json().catch(() => ({}));
console.log(`twilio account: HTTP ${acct.status}, status=${acctBody.status ?? "?"}, type=${acctBody.type ?? "?"}`);

// 2. A signed inbound, the way the sandbox would send it.
const url = "https://app.belline.ai/api/whatsapp/webhook";
const from = process.argv[2] || "+971500000001";
const params = {
  AccountSid: sid,
  ApiVersion: "2010-04-01",
  Body: "Hi Belle, what time do you close on Saturday?",
  From: `whatsapp:${from}`,
  MessageSid: `SMprobe${Date.now()}`,
  NumMedia: "0",
  ProfileName: "Sandbox probe",
  SmsMessageSid: `SMprobe${Date.now()}`,
  To: "whatsapp:+14155238886",
  WaId: from.slice(1),
};
let payload = url;
for (const key of Object.keys(params).sort()) payload += key + params[key];
const signature = crypto.createHmac("sha1", token).update(payload, "utf8").digest("base64");

const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
  body: new URLSearchParams(params).toString(),
});
console.log(`webhook: HTTP ${res.status} ${await res.text()}`);

// 3. The same request with a wrong signature must be refused.
const forged = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "forged" },
  body: new URLSearchParams(params).toString(),
});
console.log(`forged signature: HTTP ${forged.status}`);
console.log(`probe sid: ${params.MessageSid}`);
