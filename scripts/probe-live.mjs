// npm run probe:live — a real turn against production, over the same socket the website bell uses.
// Fetches /call for its signed demo token, opens /ws/demo, types a question
// (the text path skips the recogniser, so this measures the server's part:
// model + voice + network to here) and times the first agent audio frame.
import WebSocket from "ws";

const BASE = process.env.PROBE_BASE ?? "https://app.belline.ai";
const html = await fetch(`${BASE}/call`).then((r) => r.text());
const token = html.match(/demoToken\\?":\\?"([^"\\]+)/)?.[1] ?? html.match(/"demoToken":"([^"]+)"/)?.[1];
if (!token) throw new Error("no demo token in /call");

const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws/demo?token=${encodeURIComponent(token)}`);
ws.binaryType = "nodebuffer";

let t0 = 0;
let firstAudio = 0;
let answerAt = 0;
let inAnswer = false;
const said = [];
let greeted = false;

ws.on("open", () => console.log("connected"));
ws.on("message", (data, isBinary) => {
  if (isBinary) {
    if (!t0) return; // greeting audio
    if (!firstAudio) firstAudio = Date.now() - t0;
    if (inAnswer && !answerAt) answerAt = Date.now() - t0;
    return;
  }
  const msg = JSON.parse(data.toString());
  if (msg.type === "turn_end" && !greeted) {
    greeted = true;
    // Greeting done. Ask.
    t0 = Date.now();
    ws.send(JSON.stringify({ type: "text", text: "What time do you close on a Saturday?" }));
    return;
  }
  if (!t0) return;
  if (msg.type === "transcript" && msg.role === "agent") {
    said.push(msg.text);
    if (!["Sure.", "Okay.", "Right.", "Let me see."].includes(msg.text)) inAnswer = true;
  }
  if (msg.type === "turn_end" && greeted) {
    console.log(`first sound ${firstAudio} ms, first answer audio ${answerAt} ms, turn ${Date.now() - t0} ms`);
    console.log(`said: ${said.join(" | ")}`);
    ws.send(JSON.stringify({ type: "hangup" }));
    setTimeout(() => process.exit(0), 300);
  }
});
ws.on("error", (e) => { console.error(e.message); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(1); }, 30000);
