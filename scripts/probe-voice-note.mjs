// npm run probe:voice — a voice note against production, end to end: mint a visitor token by
// loading the chat page the way the widget does, synthesise a sentence, post
// it to the voice route, and read back what Belline heard and replied.
import fs from "node:fs";

const BASE = "https://app.belline.ai";
const KEY = "be_belline_site";

// The chat page mints the token only when framed by a named origin; the ?o=
// is what the widget passes. The token sits in the RSC payload as freshToken.
const html = await fetch(`${BASE}/embed/${KEY}/chat?o=${encodeURIComponent("https://belline.ai")}`, {
  headers: { referer: "https://belline.ai/" },
}).then((r) => r.text());
const token = html.match(/freshToken\\?":\\?"([^"\\]+)/)?.[1] ?? html.match(/"freshToken":"([^"]+)"/)?.[1];
if (!token) throw new Error("no visitor token on the chat page");

// Say something with ElevenLabs (local key), as an mp3.
const key = process.env.ELEVENLABS_API_KEY;
const said = "Hi, what time do you close on a Saturday, and can I book a call for Tuesday afternoon?";
const tts = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream?output_format=mp3_44100_128`, {
  method: "POST",
  headers: { "xi-api-key": key, "content-type": "application/json" },
  body: JSON.stringify({ text: said, model_id: "eleven_flash_v2_5" }),
});
const mp3 = Buffer.from(await tts.arrayBuffer());
console.log(`clip ${Math.round(mp3.length / 1024)} KB`);

const t0 = Date.now();
const res = await fetch(`${BASE}/api/webchat/${KEY}/voice`, {
  method: "POST",
  headers: {
    "content-type": "audio/mpeg",
    "x-visitor-token": token,
    "x-client-id": `probe${Date.now().toString(36)}`,
    "x-note-seconds": "6",
  },
  body: mp3,
});
const body = await res.json();
console.log(`${res.status} in ${Date.now() - t0} ms`);
console.log("heard:", body.heard);
console.log("reply:", (body.messages ?? []).map((m) => m.body).join(" | "));
