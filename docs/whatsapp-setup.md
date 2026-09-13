# Putting Belle on WhatsApp

Everything on our side is built: the Meta adapter, the signed webhook, the
inbox, the honesty check, and — as of this commit — the boot-time connection
of our own number and the "WhatsApp Belle" button on belline.ai that goes to
WhatsApp when the number is live and says "not yet" when it is not.

What is left is Meta's side, which only the business owner can do. Four values
come out of it. Paste them into Railway, restart, and Belle answers WhatsApp.

## 1. Meta Business — verification

1. business.facebook.com → Business settings → Security centre → **Start
   verification**. Legal name, trade licence, address, a phone Meta can ring.
   Takes days to a couple of weeks. Nothing below works until it is approved.

## 2. The app

1. developers.facebook.com → Create app → **Business** type → add the
   **WhatsApp** product.
2. App settings → Basic → copy the **App secret** → `WHATSAPP_APP_SECRET`.

## 3. The number

1. WhatsApp → API setup → **Add phone number**. Use a number that is *not*
   already on a WhatsApp app (personal or Business app), or migrate it. A
   UAE number is strongly preferred — the website now says "the UAE", and a
   +1 WhatsApp number contradicts it.
2. Verify it by SMS or call.
3. Copy the **Phone number ID** (a long integer, not the number) →
   `WHATSAPP_PHONE_NUMBER_ID`.
4. The number itself, E.164, e.g. `+9715XXXXXXXX` → `WHATSAPP_NUMBER`.

## 4. A permanent token

The token on the API-setup page expires in 24 hours. Do not use it.

1. Business settings → Users → **System users** → Add → Admin.
2. Assign assets → the app → Full control.
3. **Generate new token** → the app → permissions `whatsapp_business_messaging`
   and `whatsapp_business_management` → expiry **Never**.
4. → `WHATSAPP_ACCESS_TOKEN`.

## 5. The webhook

1. WhatsApp → Configuration → Webhook → Edit.
2. Callback URL: `https://app.belline.ai/api/whatsapp/webhook`
3. Verify token: the value of `WHATSAPP_VERIFY_TOKEN` in Railway (already
   set). Meta calls the URL immediately and will not save until it echoes the
   challenge — that route is live today, so it will.
4. Subscribe to the **messages** field.

## 6. Railway

```
WHATSAPP_NUMBER=+9715XXXXXXXX
WHATSAPP_PHONE_NUMBER_ID=1234567890
WHATSAPP_ACCESS_TOKEN=EAAB...
WHATSAPP_APP_SECRET=...
WHATSAPP_VERIFY_TOKEN=(already set)
CREDENTIALS_KEY=(already set — the token is stored encrypted)
```

Restart the service. The boot log says one of:

```
[whatsapp] Belline's own number is connected: +9715XXXXXXXX
[whatsapp] not connected — missing WHATSAPP_ACCESS_TOKEN, ...
```

## 7. Prove it

- Message the number from a phone: "What time do you close?" — Belle
  answers in writing, and the thread appears in the inbox under the Belline
  venue.
- Open https://app.belline.ai/whatsapp — it should now redirect to
  `wa.me/<number>` instead of showing the "not yet" page.
- Then take the "not connected yet" sentence out of the channels section on
  belline.ai (`public/landing.html`, `channel-note`), rebuild (`npm run site`)
  and deploy. `check:webchat` will fail until you do — it pins the claim.

## Notes

- Voice notes on WhatsApp are still answered with "I can't listen to voice
  notes just yet". The web chat transcribes; wiring `transcribeClip` into the
  Meta audio path is a small follow-up once the number exists to test it on.
- Customers' own WhatsApp numbers are a separate, per-business connection
  (each business proves it owns its number). Not self-serve yet.

## Connecting a customer's venue (the second-number model)

A customer keeps their own WhatsApp exactly as it is. Belle answers a *second*
number that lives in **our** WhatsApp business account — so our verification
covers it and the customer does no Meta paperwork at all.

1. Meta → WhatsApp Manager → our business → **Phone numbers → Add phone
   number**. Use a number the customer bought (a SIM they can receive the OTP
   on) or one we provide. Display name: the venue's name.
2. Copy that number's **Phone number ID**.
3. app.belline.ai/sales/clients → the venue's row → **Connect a number** →
   paste the number (E.164) and the ID → Connect.
4. Message it. The thread appears in the venue's inbox; Belle answers as that
   venue. Tell the customer to put the number on their site, Google profile
   and Instagram; their Integrations page now shows it.
5. To stop answering on it: the same row → **Pause**. The history stays.

The token used is our own (`WHATSAPP_ACCESS_TOKEN`), which is why our number
has to be connected before any venue's can be.
