# Belline

A proprietary AI voice receptionist for restaurants and salons. It answers the
phone, understands what the caller wants, checks **real** availability against a
real booking engine, and books, moves or cancels the appointment — then writes
the whole thing to a dashboard the venue can audit.

This is the same shape of product as Retell or Vapi, except the booking logic —
the part that actually decides whether a venue trusts it — is yours rather than
a webhook you have to write anyway.

---

## Run it

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. The first visit asks you to create the owner
account — after that everything is behind a login. Then go to
**Test console → Start call**.

It runs with no API keys at all. The booking engine, dashboard, tool tracing
and call log are fully functional; the model and the speech vendors fall back
to stubs and tell you so. To hear the real thing, copy `.env.example` to `.env`
and fill in what you have — each key switches on independently.

| Key | Turns on |
| --- | --- |
| `ANTHROPIC_API_KEY` | The actual agent. Everything below is cosmetic without it. |
| `DEEPGRAM_API_KEY` | Talking to it instead of typing. |
| `ELEVENLABS_API_KEY` | Hearing it reply. |
| `TWILIO_*` + `PUBLIC_WS_ORIGIN` | Answering a real phone number. |

```bash
npm run site       # build the public website into site/ for any static host
npm run doctor     # why isn't the phone ringing? checks every key against the provider
npm run demo       # fill the dashboard with a plausible week (add -- reset to wipe first)
npm run check      # booking-engine test suite (22 cases, no keys needed)
npm run user -- list                                  # accounts
npm run user -- reset you@example.com "new password"  # if you lock yourself out
npm run typecheck
```

Run `npm run demo`, then put **+971 50 447 2210** into "Calling from" in the test
console and start a call — that number belongs to a regular, and the agent
opens by name.

The customer-facing pages are plain HTML in `public/`, served by the same
server and deployable to any static host on their own:

| Page | Local |
| --- | --- |
| Landing page | <http://localhost:3000/landing.html> |
| 90-day plan | <http://localhost:3000/plan.html> |
| Market study | <http://localhost:3000/market.html> |
| Go-live runbook | <http://localhost:3000/golive.html> |

### From a phone

The server already listens on every interface, so on the same Wi-Fi just open
`http://<your-machine-ip>:3000`. The dashboard and the text console work fully.

The **microphone will not**, and not because of anything here: browsers only
expose `getUserMedia` in a secure context, so a plain `http://` origin on a
phone has no microphone at all. For voice on a real device you need HTTPS —
run a tunnel and open the `https://` URL it gives you:

```bash
cloudflared tunnel --url http://localhost:3000
```

A VPN client on the machine will usually break the Wi-Fi route before anything
else does; disconnect it first if the phone cannot reach the page.

---

## How it works

```
  caller ──► Twilio Media Stream ──┐
                                   ├──► WebSocket bridge (server.ts)
  browser mic ─────────────────────┘             │
                                                 ▼
                     Deepgram  ──►  transcript, with endpointing
                                                 │
                                                 ▼
                     Claude (streaming, tools) ──► booking engine
                                                 │
                                                 ▼
                     ElevenLabs  ──►  audio, cut at clause boundaries
```

Four design decisions carry most of the weight:

**Speak before the sentence is finished.** The model's reply is streamed and cut
at clause boundaries by `SentenceChunker`, and each fragment goes to the speech
engine the moment it is whole enough to say. First audio leaves at roughly a
third of a second rather than after the last token. The first fragment is
allowed to be short and break on a comma — getting *something* into the
caller's ear fast matters more than prosody on the opening clause.

**Barge-in is real.** When the caller talks over the agent it stops mid-word:
the TTS request is aborted, the transport is told to drop whatever it has
buffered, and a generation counter fences off every unit of work belonging to
the abandoned turn. On a phone call the `clear` message to Twilio is what makes
this audible — without it Twilio keeps playing audio our process has already
forgotten about.

**The greeting never touches the model.** It is configured text, spoken the
instant the call connects. Pickup feels immediate, and the model is told what
it already said so it does not greet twice.

**A public demo line is not a test number.** Anyone can dial it and every
minute spends money with four vendors, so a demo venue is capped before it is
clever: a daily call limit refused in the webhook *before* any vendor
connection opens, a shorter maximum call length, a disclosure in the first
breath, and yesterday's demo bookings cleared so the next prospect isn't told
the diary is full. One number per vertical, because the webhook already routes
by the number dialled — so a clinic owner hears a clinic.

**Three roles, enforced in three places.** `owner` sees every venue and manages
the team; `manager` changes how the agent behaves at their venues; `staff`
reads the book and the calls. The guarded layout covers every page, route
handlers check for themselves, and the websocket bridge checks the same
session cookie — because the test console starts real, metered calls, and an
open socket there spends money.

**Regulars are recognised before the model runs.** The caller's number is
matched against past bookings at pickup, so recognition lands in the opening
line where it belongs rather than three seconds later. The guest record is a
*projection* over bookings, not a second store — nothing to import, nothing to
fall out of sync, and every venue that has taken one booking already has it.

**One engine, three verticals.** A salon and a clinic are the same scheduling
problem — qualified people, timed services, shared rooms, cleanup buffers — so
they run the same code and differ only in configuration and vocabulary. A
clinic that hears "stylist" from its own phone line has lost the room, so the
words live in `verticals.ts` rather than in a hand-edited prompt per venue.

**Availability is computed, never guessed.** The agent cannot state a time
without calling `check_availability`, and that tool runs the same engine the
venue's own diary would. Failures carry their own recovery — an unavailable
slot returns nearby alternatives in the same result, so the agent answers
"eight is gone, I have quarter past seven or half past eight" in one turn.

### The booking engine

This is the part that is genuinely vertical-specific, and the reason a generic
voice platform leaves you with all the hard work still to do.

**Restaurants** (`src/lib/booking/restaurant.ts`) — three constraints must hold
at once. A physical table or a valid same-section combination that fits the
party; that table free for the full turn time, which grows with party size;
and kitchen pacing, a cap on covers seated per slot that applies *even when
tables are free*. It seats the tightest fit available, because putting a couple
on a six-top on a Saturday costs the venue four covers.

**Salons** (`src/lib/booking/salon.ts`) — one qualified person free for the
exact duration of the requested service chain, plus any shared equipment that
chain needs (colour stations are a real constraint), plus the cleanup buffer
after it. The buffer is held in the diary but never quoted to the guest.
Work is spread across qualified staff rather than stacked on whoever is first
in the list.

`npm run check` covers all of the above, including the cases a demo never
reaches: turn times growing with party size, pacing blocking a slot with empty
tables, a stylist's cleanup buffer blocking the next booking, two colour
clients contending for two stations, a three-hour service that would overrun a
shift.

### Files worth knowing

| Path | What lives there |
| --- | --- |
| `server.ts` | HTTP + WebSocket bridge. Next runs inside it. |
| `src/lib/voice/session.ts` | One live call: barge-in, turn-taking, generation fencing. |
| `src/lib/voice/transports.ts` | Browser vs. Twilio. The only place framing differs. |
| `src/lib/agent/runtime.ts` | Streaming model loop, sentence chunking, tool execution. |
| `src/lib/agent/prompt.ts` | System prompt. Split at the cache boundary. |
| `src/lib/agent/tools.ts` | The eight tools, with validation and recovery text. |
| `src/lib/booking/` | Availability, per vertical. |
| `src/lib/auth.ts` | Passwords, sessions, roles. No `next/*` imports — the WS bridge uses it too. |
| `src/lib/auth-server.ts` | `requireUser()` for pages, `requireApiUser()` for routes. |
| `src/app/(app)/layout.tsx` | The guard. Every route under it needs a session. |
| `src/lib/demo.ts` | Public demo line: caps, disclosure, self-cleaning diary. |
| `src/lib/guests.ts` | Guest recognition, derived from booking history. |
| `src/lib/store.ts` | Persistence. One narrow interface; swap for Postgres here. |
| `public/*.html` | Landing page and the three written documents. |

---

## Connecting a phone number

1. Expose the local server: `ngrok http 3000` (or deploy it somewhere).
2. Set `PUBLIC_WS_ORIGIN=wss://<your-host>` and `TWILIO_AUTH_TOKEN` in `.env`.
3. Point the Twilio number's **Voice** webhook at
   `POST https://<your-host>/api/twilio/voice`.

The webhook matches the dialled number against a location's `phone` field, so
one deployment serves every venue. Twilio signatures are verified — without
that check the endpoint is an open door and every forged request starts a call
that bills three vendors.

**Where this can and cannot be deployed.** The dashboard is ordinary Next.js
and would sit happily on Vercel. This process cannot: a serverless function
has no persistent socket, and a voice bridge is nothing but persistent
sockets. It belongs on Fly, Railway, Render, or any container host.

---

## Roughly what a call costs

Per minute of connected call, at list prices — verify current rates before
quoting anyone:

| | ~$/min |
| --- | --- |
| Telephony (Twilio inbound) | 0.014 |
| Speech-to-text (Deepgram streaming) | 0.008 |
| Text-to-speech (ElevenLabs Flash) | 0.02 – 0.03 |
| Model (Claude Opus 5, cached prompt, ~4 turns) | 0.02 – 0.03 |
| **Total** | **≈ 0.07 – 0.09** |

Two levers move this materially. Switching the model to Sonnet 5 or Haiku 4.5
in **Agent → Model** roughly halves the model line and takes ~300 ms off
response time, at the cost of judgement on awkward calls. And prompt caching —
already wired up, the venue's facts and rules sit behind a cache breakpoint —
is what keeps the input side flat as a call goes on instead of growing with
every turn.

That total is close to what the incumbents charge retail, which is the point:
owning the stack means the per-minute cost is your floor rather than someone
else's margin, and the per-venue subscription is yours.

---

## What is deliberately not built yet

Named honestly, because each is a real piece of work:

- **Outbound calling** — no-show chasing, waitlist offers, confirmation calls.
  The engine supports it; there is no dialler.
- **PMS integrations** — SevenRooms, OpenTable, Fresha, Treatwell. The seam is
  `BookingBackend` in `src/lib/booking/index.ts`; implementing it against a
  venue's API is the whole integration. Until then this is the source of truth,
  which most venues will not accept as a permanent arrangement.
- **Outbound calling** — no-show recovery and waitlist fill. The engine
  supports it; there is no dialler.
- **A phone number** — nothing is dialable yet. Answering a real call needs a
  Twilio number, a public HTTPS host, and the three provider keys.
- **Multi-language** — the prompt and the STT config are English-only today.
  Both are per-location fields already; Deepgram handles the switch, and Gulf
  Arabic and Swiss German both need testing against real callers before anyone
  promises them.
- **Password reset by email** — an owner resets passwords from the server
  shell. Fine for a small team, awkward for a venue manager on a Saturday.
- **Two-factor** — one password currently guards every guest number you hold.
- **Recordings** — transcripts are stored, audio is not.
