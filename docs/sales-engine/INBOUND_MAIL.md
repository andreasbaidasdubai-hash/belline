# Inbound mail, and adding a sending domain

Two pieces, built on top of the outreach engine in `src/lib/sales/sending/`.
The first makes a reply stop a sequence without anybody noticing it arrived.
The second makes adding a sending domain a few minutes instead of an afternoon.

---

## 1. How a reply travels

```
  Dr Khan hits reply in Outlook
        │
        ▼
  MX for try-belline.com ──► inbound-smtp.eu-west-1.amazonaws.com
        │
        ▼
  SES receipt rule  ──► writes the raw message to s3://belline-inbound/inbound/<id>
                    └─► publishes a notification to the SNS topic
        │
        ▼
  SNS POSTs https://app.belline.ai/api/sales/inbound
        │
        ├─ signature, certificate host, topic ARN and age verified   sns.ts
        ├─ a bad one is a 403; everything else is a 200 and a log line
        ▼
  the raw message is read back out of S3                              s3.ts
        │
        ▼
  parsed: headers, the first readable text part, quoted history cut   mime.ts
        │
        ▼
  classified: reply | auto_reply | bounce | complaint                 classify.ts
        │
        ▼
  matched to a send:  In-Reply-To / References                        receive.ts
                      then the plus-address on Reply-To
                      then the address itself
        │
        ▼
  acted on, idempotently on the SES message id                        receive.ts
        │
        ├─ sequence_state: stopped, or paused until a date
        ├─ send_item: anything queued is cancelled, or rescheduled
        ├─ inbound_reply: one row, with what it did
        ├─ send_event: reply / unsubscribe / bounce / complaint
        └─ sales.activity + the lead timeline, with the message body
        │
        ▼
  /sales/outreach/replies, against the lead
```

### The three identifiers, and why there are three

A reply has no foreign keys. Everything that lets us attribute one is something
we put there on the way out, in `dispatch.ts`, written to the `send_item` row in
the same update that marks it `sending` — before the bytes leave, so a reply
arriving seconds later finds a row that already exists.

| | Where it lives | Lost when |
|---|---|---|
| `Message-ID` | `send_item.rfc_message_id` | the client strips threading headers |
| plus-address | `send_item.reply_token`, on `Reply-To` | somebody types the address by hand |
| the address | `send_item.to_address` | a shared mailbox answers for two people |

Both minted identifiers carry a short HMAC over the item id, signed with
`OUTREACH_UNSUBSCRIBE_SECRET`. Not to keep them secret — they travel in the
clear in every message — but because `In-Reply-To` is attacker-controlled, and
an unverified one would let anybody stop any sequence by guessing an id.

A **second message in the same thread** attaches to the same lead: the
`References` chain still carries our original `Message-ID`, and if it does not,
the sender's address does.

### What each kind does

| Kind | Sequence | Suppression | Queued items |
|---|---|---|---|
| Human reply | stopped, `replied` | none | cancelled |
| Reply with an unmistakable opt-out | stopped, `unsubscribed` | the whole company, for good | cancelled |
| Reply that might be an opt-out | stopped, `replied` | **none — flagged for a person** | cancelled |
| Out-of-office | **paused until a date** | none | **rescheduled, not cancelled** |
| Permanent bounce (5.x.x) | stopped, `bounced` | the address | cancelled |
| Temporary bounce (4.x.x) | untouched | none | untouched |
| Spam complaint | stopped, `complaint` | the whole company, for good | cancelled |
| Matched to no lead | nothing | none | none — recorded and flagged |

---

## 2. What an out-of-office does

This is the part most worth getting right, because getting it wrong is silent.

An auto-reply is **not** a reply. It is evidence that the address is live and
that nobody has read the message — the two facts that most argue for writing
again later. Stopping on one loses the lead with no error anywhere.

So `sequence_state` grows two columns, `paused_until` and `pause_reason`, and:

- **The status stays `active`.** The step does not move. The stop reason stays
  empty. Nothing about the lead's position in the sequence changes.
- **`paused_until` is the date they said they are back**, parsed out of the
  message (`2026-10-05`, `05.10.2026`, `5 October`, and the German and French
  equivalents), or a week from now when they did not say. Clamped to
  `MAX_PAUSE_DAYS` (42): an auto-rule claiming 2029 must not lose the lead as
  surely as stopping would.
- **A later pause wins; an earlier one never shortens one already in place.**
  Two auto-replies are two reasons to wait.
- **Items already on the clock are rescheduled, not cancelled.** A cancelled
  item is a follow-up that never happens, and this lead has not answered.
- **`dueNow` skips a paused sequence and `screen()` blocks one**
  (`sequence_paused`). Without both, an auto-responder gets a follow-up the
  same afternoon.
- **It resumes by itself.** Nothing has to be un-paused; once the date passes
  the lead is due again. The screen says so in those words, because somebody
  reading "stopped" against a lead who is merely in Greece is how a working
  pipeline gets written off.
- **A real reply afterwards stops it for good** and clears the pause.
- **A machine never suppresses a company.** An auto-reply that reads like an
  opt-out — "she no longer works here" is the common one — pauses and goes to
  a person.

---

## 3. What the founder has to set up in AWS

Once, for all domains. About twenty minutes.

### a. An S3 bucket for received mail

1. S3 → **Create bucket** → `belline-inbound`, in the **same region** as the
   SES identity (SES can only receive in some regions —
   `records.ts:INBOUND_REGIONS` has the list; `eu-west-1` is the intended one).
   Block all public access, default encryption on.
2. Bucket → **Permissions → Bucket policy**, so SES may write into it. Replace
   the account id:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowSESPuts",
    "Effect": "Allow",
    "Principal": { "Service": "ses.amazonaws.com" },
    "Action": "s3:PutObject",
    "Resource": "arn:aws:s3:::belline-inbound/inbound/*",
    "Condition": {
      "StringEquals": { "AWS:SourceAccount": "123456789012" },
      "StringLike": { "AWS:SourceArn": "arn:aws:ses:eu-west-1:123456789012:receipt-rule-set/*" }
    }
  }]
}
```

3. **Lifecycle rule**: expire `inbound/` after 90 days. These are other
   people's emails; there is no reason to keep them forever.

### b. Two SNS topics

SNS → **Create topic** → Standard.

- `belline-inbound` — receipt notifications. Subscribe the endpoint:
  **Create subscription** → protocol **HTTPS** → endpoint
  `https://app.belline.ai/api/sales/inbound` → **Enable raw message delivery
  OFF** (the endpoint verifies the SNS envelope's signature, so it needs the
  envelope). SNS immediately POSTs a `SubscriptionConfirmation`; the endpoint
  verifies it and confirms it, and logs a line saying so. If the deployment was
  not up, press **Request confirmation** again, or open the `SubscribeURL` from
  the console.
- `belline-ses-events` — bounce, complaint, delivery and reject events from the
  configuration set. Nothing needs to subscribe to it for setup to be valid;
  it is what `domain:setup --topic` points the event destination at.

### c. A receipt rule set

SES → **Email receiving** → **Rule sets** → create `belline-inbound` and set it
active (only one rule set is active at a time — check nothing else is using it).

Then **Create rule**:

1. **Recipient conditions** — add each sending domain: `try-belline.com`,
   and one line per further domain. A domain condition matches every address
   at it, including the `andreas+b12.9f3a@` plus-addresses.
2. **Actions**, in this order:
   - **S3** → bucket `belline-inbound`, object key prefix `inbound/`,
     SNS topic **none** (the next action does it, and doing both sends two
     notifications for one message).
   - **SNS** → topic `belline-inbound`, encoding **UTF-8**.
   - Optionally a **Stop rule set** action last.
3. Enable **spam and virus scanning**. The endpoint reads SES's verdicts: a
   virus is dropped, and spam is dropped only when it answers nothing we sent.

> The SNS action alone also works and is simpler — the notification carries the
> whole message — but it caps at 150 KB, which one forwarded thread exceeds.
> The endpoint handles both: it uses the embedded content when there is one and
> falls back to the S3 pointer.

### d. Two IAM users

Deliberately separate from the sending credentials.

- **Reading inbound mail** — the deployment holds this one.
  Policy: `s3:GetObject` on `arn:aws:s3:::belline-inbound/inbound/*`, nothing
  else. Set `OUTREACH_INBOUND_ACCESS_KEY_ID`,
  `OUTREACH_INBOUND_SECRET_ACCESS_KEY`, `OUTREACH_INBOUND_REGION`.
- **The SES control plane** — a laptop holds this one, and no deployment does.
  Policy: `ses:CreateEmailIdentity`, `ses:GetEmailIdentity`,
  `ses:PutEmailIdentityDkimAttributes`, `ses:PutEmailIdentityMailFromAttributes`,
  `ses:PutEmailIdentityConfigurationSetAttributes`,
  `ses:CreateConfigurationSet`, `ses:CreateConfigurationSetEventDestination`,
  `ses:GetAccount`. Set `OUTREACH_SES_ADMIN_ACCESS_KEY_ID`,
  `OUTREACH_SES_ADMIN_SECRET_ACCESS_KEY`, `OUTREACH_SES_ADMIN_REGION`.
  `check:domain-setup` fails if any web route can reach this pair.

### e. The environment

```
OUTREACH_INBOUND_SNS_TOPIC_ARN=arn:aws:sns:eu-west-1:123456789012:belline-inbound
OUTREACH_INBOUND_ACCESS_KEY_ID=...
OUTREACH_INBOUND_SECRET_ACCESS_KEY=...
OUTREACH_INBOUND_REGION=eu-west-1
OUTREACH_UNSUBSCRIBE_SECRET=...        # already set; also signs the reply tokens
```

With no topic ARN the endpoint accepts nothing at all — there is no wildcard
and no "allow everything" mode.

### f. Production access

SES starts in the sandbox and can only send to verified addresses.
`domain:setup` prints a warning when it sees one. Request production access in
the SES console before anything goes to a stranger.

---

## 4. Adding a sending domain

```
npm run domain:setup -- --domain try-belline.com \
                        --mailbox andreas --name "Andreas Baidas" \
                        --topic arn:aws:sns:eu-west-1:123456789012:belline-ses-events \
                        --dmarc-reports dmarc@belline.ai
```

It does everything AWS can do — creates the identity, turns Easy DKIM on, sets
the custom MAIL FROM subdomain, creates the configuration set with a
bounce/complaint/delivery/reject destination and attaches it — registers the
domain and its mailboxes in `sales.sending_domain` and `sales.sending_mailbox`
with today's warm-up start date, and prints the DNS records.

It is safe to re-run: every call treats "already exists" as done. `--dry-run`
shows the shape without touching AWS, and prints **no** DKIM records rather
than three plausible-looking strings, because those can only come from AWS.

It refuses `belline.ai`, in code, before anything else happens.

### The records, at Namecheap

Domain List → Manage → **Advanced DNS**. Delete the parking CNAME on `@` and
any URL Redirect first; both quietly win against what you add. Under **Mail
Settings** choose **Custom MX**, not Email Forwarding — Namecheap's forwarding
MX records otherwise sit in front of the SES one and replies never arrive.

| Type | Host | Value | Pri |
|---|---|---|---|
| CNAME | `<token1>._domainkey` | `<token1>.dkim.amazonses.com` | |
| CNAME | `<token2>._domainkey` | `<token2>.dkim.amazonses.com` | |
| CNAME | `<token3>._domainkey` | `<token3>.dkim.amazonses.com` | |
| TXT | `@` | `v=spf1 include:amazonses.com -all` | |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:…; adkim=r; aspf=r; pct=100` | |
| MX | `mail` | `feedback-smtp.eu-west-1.amazonses.com` | 10 |
| TXT | `mail` | `v=spf1 include:amazonses.com -all` | |
| MX | `@` | `inbound-smtp.eu-west-1.amazonaws.com` | 10 |

The tokens come from the SES API in that run. `-all` rather than `~all`: this
is a dedicated domain with exactly one sender, and a soft fail on such a domain
is an invitation to spoof it. `adkim=r`/`aspf=r` because the MAIL FROM is a
subdomain of the From domain and strict alignment would fail SPF on every
message.

### Checking it

```
npm run domain:verify -- --domain try-belline.com
```

Checks every record through Cloudflare and Google rather than this machine's
resolver, and asks SES separately what it has noticed — they fail
independently, and one combined verdict would hide whichever was wrong. It
distinguishes **missing** from **wrong**, because a registrar default has to be
deleted before yours will work. Exits non-zero while anything is outstanding.

---

## 5. The checks

```
npm run check:inbound-mail     # 77 cases
npm run check:domain-setup     # 41 cases
```

Both are in `check:all`. Neither touches the network, AWS or a database:
`globalThis.fetch` throws, the SES client is a stub, and each ends with a
section that scans the tree to prove no code path could have reached AWS
without somebody explicitly supplying credentials — one signer module, no
`process.env` read outside a defaulted argument, no web route that can reach
the control plane.

Screens: `docs/sales-engine/screens/outreach-replies-1280.png` and
`outreach-replies-review-1280.png`.
