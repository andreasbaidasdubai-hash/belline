import WebSocket from "ws";

/**
 * A raw socket, no browser.
 *
 * The browser tests told me the line drops but not why. A close *code* does:
 * 1000 is a clean close by one side, 1001 going away, 1006 an abnormal
 * termination with no close frame — which is what a proxy killing the
 * connection looks like from the inside.
 */
const page = await (await fetch("https://app.belline.ai/call?start=1")).text();
const token = page.match(/loc_belline\.\d+\.[A-Za-z0-9_-]+/)?.[0];
if (!token) throw new Error("no token on the page");

const url = `wss://app.belline.ai/ws/demo?token=${encodeURIComponent(token)}`;
const ws = new WebSocket(url);

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let bytes = 0;
let lastData = 0;

ws.on("open", () => console.log(`${at()}  open`));
ws.on("message", (d, isBinary) => {
  lastData = Date.now();
  if (isBinary) {
    bytes += d.length;
  } else {
    const msg = JSON.parse(d.toString());
    if (msg.type !== "partial") console.log(`${at()}  << ${msg.type}`);
  }
});
ws.on("ping", () => console.log(`${at()}  << ping from server`));
ws.on("pong", () => console.log(`${at()}  << pong`));
ws.on("close", (code, reason) => {
  console.log(`${at()}  CLOSED code=${code} reason="${reason}"`);
  console.log(`        ${bytes} audio bytes, last data ${((Date.now() - lastData) / 1000).toFixed(1)}s before close`);
  process.exit(0);
});
ws.on("error", (e) => console.log(`${at()}  ERROR ${e.message}`));

setTimeout(() => {
  console.log(`${at()}  still open after three minutes — ${bytes} audio bytes`);
  ws.close();
}, 180000);
