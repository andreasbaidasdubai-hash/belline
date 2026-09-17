/**
 * Languages: the registry, a business's settings, and German, for Germany,
 * Austria and Switzerland.
 *
 * Grew out of check:german, whose cases are all still here. A business now has
 * a main language and up to two more, chosen only from languages that are fully
 * built; the first half of this suite is that model, the second is German.
 *
 * A venue answered in German touches everything a customer meets: the
 * recogniser, the voice, the prompt, the numbers read aloud, the guards and
 * every line the system writes by itself. Most of what can go wrong is a single
 * path that forgot — an English voicemail after a German greeting, a German
 * "gebucht" that the English guard cannot read. So this suite is wide rather
 * than deep, and two halves of it matter more than the rest:
 *
 *   With the flag off, nothing is German, whatever a venue has saved.
 *   With the flag on, an English venue is byte for byte what it was.
 *
 * No keys, no network, no database. The end-to-end chat turn at the bottom
 * runs the real prompt, tools and guards against a scripted model.
 *
 *   npm run check:languages
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "belline-languages-"));
for (const k of [
  "ANTHROPIC_API_KEY",
  "DEEPGRAM_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "ELEVENLABS_VOICE_ID_DE",
  "FLAG_STUBS",
  "FLAG_LANGUAGE_DE",
  "STT_ENGINE",
  "DATABASE_URL",
]) {
  delete process.env[k];
}

const ROOT = path.resolve(import.meta.dirname, "..");

const { flag, flagState } = await import("../src/lib/flags");
const { answersIn, germanVariant, inHouseSpelling, languageChoiceOpen, lineFor, localeOf, parseLanguage, swissSpelling } =
  await import("../src/lib/language");
const { CUSTOMER_COPY, CALL_KEYS, CHAT_KEYS, MANAGE_KEYS, copy, placeholdersOf } = await import("../src/lib/customer-copy");
const { seedIfEmpty, ensureLanguage } = await import("../src/lib/seed");
const { getLocation, listLocations, upsertLocation } = await import("../src/lib/store");
const { blankVenue } = await import("../src/lib/onboarding");
const { snapshotOf } = await import("../src/lib/brain");
const { staticPrompt, languageBlock } = await import("../src/lib/agent/prompt");
const { toSpoken, PACE } = await import("../src/lib/voice/spoken");
const { germanNumber } = await import("../src/lib/voice/spoken-de");
const { dateToGerman, minutesToGerman } = await import("../src/lib/time");
const { novaStreamParams, sttEngine } = await import("../src/lib/providers/stt");
const { ttsRequest, voiceIdFor, HOUSE_VOICE_ID } = await import("../src/lib/providers/tts");
const { voiceParams, greetingClip, acknowledgementsFor, sttLanguageOf, ACKNOWLEDGEMENTS } = await import("../src/lib/voice/session");
const { SAY_VOICE, sayTwiml, voicemailGreeting, voicemailTwiml, VOICEMAIL_THANKS } = await import("../src/lib/telephony/voicemail");
const { greetingFor } = await import("../src/lib/agent/runtime");
const { isBackchannel } = await import("../src/lib/voice/backchannel");
const { assessAuthority } = await import("../src/lib/agent/authority");
const { checkRequestReply, checkSlotOffers, checkTimes, publishedTimes, repairReply, timesIn, REQUEST_HANDOVER, REQUEST_NO_SLOT } =
  await import("../src/lib/agent/honesty");
const { reminderMessage } = await import("../src/lib/reminders");
const { confirmationMessage, findAvailability } = await import("../src/lib/booking");
const { bookingEmail, bookingIcs, manageable, whatWasBooked } = await import("../src/lib/booking/manage");
const { lateCancelNotice } = await import("../src/lib/booking/policy");
const { ceilingMessage } = await import("../src/lib/webchat");
const { LINK_NOT_LIVE } = await import("../src/lib/chat-link");
const { converse } = await import("../src/lib/onboarding/selftest");
const { startCall } = await import("../src/lib/calls");

type Location = NonNullable<ReturnType<typeof getLocation>>;

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}
const head = (title: string) => console.log(`\n\x1b[1m${title}\x1b[0m\n`);

/** Run with the German flag on, and put the environment back however it ends. */
async function withGerman<T>(fn: () => T | Promise<T>): Promise<T> {
  process.env.FLAG_LANGUAGE_DE = "on";
  try {
    return await fn();
  } finally {
    delete process.env.FLAG_LANGUAGE_DE;
  }
}

seedIfEmpty();
const restaurant = listLocations().find((l) => l.vertical === "restaurant")!;
const salon = listLocations().find((l) => l.vertical === "salon")!;
const clinic = listLocations().find((l) => l.vertical === "clinic")!;

/** A copy of a seeded venue, moved to Germany (or wherever) and switched to German. */
function inGerman(base: Location, where: { timezone: string; currency: string } = { timezone: "Europe/Berlin", currency: "EUR" }): Location {
  return { ...base, ...where, language: "de", languages: { main: "de", also: [], pick: "auto" } };
}

/** The same venue, English only. */
function inEnglish(base: Location): Location {
  return { ...base, language: "en", languages: { main: "en", also: [], pick: "auto" } };
}

// ---------------------------------------------------------------------------
head("A venue's language: the default, the migration and the flag");

await test("a new venue starts in English", () => {
  const venue = blankVenue({ businessName: "Café Sonne", email: "owner@sonne.test", password: "x" }, "ten_x", "biz_x");
  assert.equal(venue.language, "en");
});

await test("every seeded venue has a language, and plain English languages, after boot", () => {
  for (const l of listLocations({ includeInternal: true, includeArchived: true })) {
    assert.equal(l.language, "en", l.id);
    assert.deepEqual(l.languages, { main: "en", also: [], pick: "auto" }, l.id);
  }
});

await test("the migration fills languages from the old language, once, and never undoes an owner's choice", () => {
  const { language: _drop, languages: _drop2, ...bare } = getLocation(restaurant.id)!;
  void _drop;
  void _drop2;
  upsertLocation(bare as Location);
  const { languages: _drop3, ...oldGerman } = getLocation(salon.id)!;
  void _drop3;
  upsertLocation({ ...(oldGerman as Location), language: "de" });
  const chosen = { main: "en" as const, also: ["de" as const], pick: "ask" as const };
  upsertLocation({ ...getLocation(clinic.id)!, languages: chosen });
  assert.deepEqual(ensureLanguage().sort(), [restaurant.id, salon.id].sort());
  assert.equal(getLocation(restaurant.id)!.language, "en");
  assert.deepEqual(getLocation(restaurant.id)!.languages, { main: "en", also: [], pick: "auto" });
  assert.deepEqual(getLocation(salon.id)!.languages, { main: "de", also: [], pick: "auto" });
  assert.deepEqual(getLocation(clinic.id)!.languages, chosen, "an owner's choice was rewritten");
  assert.deepEqual(ensureLanguage(), [], "the second boot wrote something");
  upsertLocation(inEnglish(getLocation(salon.id)!));
  upsertLocation(inEnglish(getLocation(clinic.id)!));
});

await test("an English venue's brain snapshot is what it was; a German one records the language", () => {
  assert.equal("language" in snapshotOf(getLocation(restaurant.id)!).company, false);
  assert.equal("languages" in snapshotOf(getLocation(restaurant.id)!).company, false);
  assert.equal(snapshotOf(inGerman(restaurant)).company.language, "de");
});

await test("language.de is off with no env, needs an explicit switch, and asks for no credentials", () => {
  assert.equal(flag("language.de", {}), false);
  assert.equal(flagState("language.de", {}).reason, "needs_approval");
  assert.deepEqual(flagState("language.de", {}).missing, []);
  assert.equal(flag("language.de", { FLAG_LANGUAGE_DE: "on" }), true);
  assert.equal(flag("language.de", { FLAG_LANGUAGE_DE: "off" }), false);
  assert.equal(languageChoiceOpen({}), false);
  assert.equal(languageChoiceOpen({ FLAG_LANGUAGE_DE: "on" }), true);
});

await test("only live languages are accepted as a language: English and German, not the slots", () => {
  assert.equal(parseLanguage("de"), "de");
  assert.equal(parseLanguage("en"), "en");
  for (const bad of ["fr", "es", "ar", "pt", "DE", "", null, 1, undefined]) assert.equal(parseLanguage(bad), null);
});

await test("where the German is spoken comes from the clock and the money", () => {
  assert.equal(germanVariant({ timezone: "Europe/Berlin", currency: "EUR" }), "de-DE");
  assert.equal(germanVariant({ timezone: "Europe/Vienna", currency: "EUR" }), "de-AT");
  assert.equal(germanVariant({ timezone: "Europe/Zurich", currency: "CHF" }), "de-CH");
  assert.equal(germanVariant({ timezone: "Europe/Berlin", currency: "CHF" }), "de-CH");
});

// ---------------------------------------------------------------------------
head("Flag off: a venue saved as German is answered in English, everywhere");

const savedGerman = inGerman(restaurant);

await test("answersIn is English and every system line is the English one", () => {
  assert.equal(answersIn(savedGerman), "en");
  assert.equal(localeOf(savedGerman), "en");
  assert.equal(lineFor(savedGerman, "voicemail.thanks"), "Thank you. The team will call you back.");
  assert.equal(ceilingMessage(savedGerman), ceilingMessage(inEnglish(savedGerman)));
});

await test("the prompt is the English prompt, byte for byte", () => {
  for (const channel of ["voice", "text"] as const) {
    assert.equal(staticPrompt(savedGerman, channel), staticPrompt(inEnglish(savedGerman), channel));
    assert.equal(languageBlock(savedGerman, channel), "");
  }
});

await test("the voice, the recogniser and the telephone are English", () => {
  const params = voiceParams(savedGerman, toSpoken("Hello."), "ulaw_8000");
  assert.equal("languageCode" in params, false);
  assert.equal(sttLanguageOf(savedGerman), "en");
  assert.match(voicemailTwiml(savedGerman), /<Say voice="Polly\.Joanna">Thanks for calling/);
  assert.deepEqual(acknowledgementsFor(savedGerman), ACKNOWLEDGEMENTS);
});

await test("texts, the manage page and the guards are English", () => {
  const booking = restaurantBooking(savedGerman);
  assert.match(reminderMessage(savedGerman, booking), /a reminder of your table for 2/);
  assert.match(confirmationMessage(savedGerman, booking), /confirmed for/);
  assert.equal(bookingEmail(savedGerman, booking, "confirmed").subject.startsWith("Confirmed:"), true);
  assert.equal(assessAuthority({ ...inGerman(clinic) }, "Ich habe gerade starke Brustschmerzen."), null);
});

// ---------------------------------------------------------------------------
head("Flag on: an English venue is exactly what it was");

await test("prompts, voice, voicemail and texts of an English venue do not change when the flag is switched on", async () => {
  const booking = restaurantBooking(restaurant);
  const before = {
    voice: staticPrompt(restaurant, "voice"),
    text: staticPrompt(restaurant, "text"),
    voicemail: voicemailTwiml(restaurant),
    reminder: reminderMessage(restaurant, booking),
    email: bookingEmail(restaurant, booking, "confirmed"),
    voiceParams: voiceParams(restaurant, toSpoken("That's £47.50 at 16:15."), "pcm_16000"),
    greeting: greetingFor(restaurant),
  };
  await withGerman(() => {
    assert.equal(staticPrompt(restaurant, "voice"), before.voice);
    assert.equal(staticPrompt(restaurant, "text"), before.text);
    assert.equal(voicemailTwiml(restaurant), before.voicemail);
    assert.equal(reminderMessage(restaurant, booking), before.reminder);
    assert.deepEqual(bookingEmail(restaurant, booking, "confirmed"), before.email);
    assert.deepEqual(voiceParams(restaurant, toSpoken("That's £47.50 at 16:15."), "pcm_16000"), before.voiceParams);
    assert.equal(greetingFor(restaurant), before.greeting);
  });
});

await test("the English system lines are the ones the code said before the table", () => {
  // Written out here on purpose: the table must not drift from what customers were told.
  assert.equal(voicemailGreeting("Azure"), "Thanks for calling Azure. Please leave your name and number after the tone, and the team will call you back.");
  assert.equal(VOICEMAIL_THANKS, "Thank you. The team will call you back.");
  assert.equal(REQUEST_HANDOVER, "Your request is with the team, and they'll get back to you to confirm.");
  assert.equal(REQUEST_NO_SLOT, "I can't hold a time here, but tell me when suits you and I'll pass it to the team to confirm.");
  assert.equal(LINK_NOT_LIVE, "This chat isn't available yet. Please check back soon.");
  assert.equal(
    ceilingMessage({ ...restaurant, businessPhone: "" }),
    "I've taken this as far as I can here. Please give us a ring and someone will pick it up from where we left off.",
  );
  assert.equal(sayTwiml("en", "Hi & bye"), `<Say voice="Polly.Joanna">Hi &amp; bye</Say>`);
});

// ---------------------------------------------------------------------------
head("Speech in, speech out, and the telephone, per language");

await test("Deepgram listens in German, Swiss German for Swiss venues, with nothing else changed", () => {
  const en = novaStreamParams({ encoding: "mulaw", sampleRate: 8000, keyterms: ["Terrasse"] });
  const de = novaStreamParams({ encoding: "mulaw", sampleRate: 8000, keyterms: ["Terrasse"], language: "de" });
  const ch = novaStreamParams({ encoding: "linear16", sampleRate: 16000, language: "de-CH" });
  assert.equal(en.get("language"), "en");
  assert.equal(de.get("language"), "de");
  assert.equal(ch.get("language"), "de-CH");
  assert.equal(de.get("model"), "nova-3");
  assert.deepEqual(de.getAll("keyterm"), ["Terrasse"]);
  // Everything but the language is the English request.
  de.set("language", "en");
  assert.equal(de.toString(), en.toString());
});

await test("a German call stays on nova-3 even when Flux is chosen for English", () => {
  process.env.STT_ENGINE = "flux";
  try {
    assert.equal(sttEngine(), "flux");
    assert.equal(sttEngine("en"), "flux");
    assert.equal(sttEngine("de"), "nova-3");
    assert.equal(sttEngine("de-CH"), "nova-3");
  } finally {
    delete process.env.STT_ENGINE;
  }
});

await test("each German venue listens for its own German", async () => {
  await withGerman(() => {
    assert.equal(sttLanguageOf(inGerman(restaurant)), "de");
    assert.equal(sttLanguageOf(inGerman(restaurant, { timezone: "Europe/Vienna", currency: "EUR" })), "de");
    assert.equal(sttLanguageOf(inGerman(salon, { timezone: "Europe/Zurich", currency: "CHF" })), "de-CH");
  });
});

await test("ElevenLabs is pinned to German on the fast models, and never sent the field where it is refused", () => {
  const flash = ttsRequest("Guten Tag.", { voiceId: "v1", format: "ulaw_8000", languageCode: "de" });
  assert.equal(flash.body.model_id, "eleven_flash_v2_5");
  assert.equal(flash.body.language_code, "de");
  assert.match(flash.url, /optimize_streaming_latency=3/);
  assert.equal(ttsRequest("Guten Tag.", { voiceId: "v1", format: "ulaw_8000", modelId: "eleven_turbo_v2_5", languageCode: "de" }).body.language_code, "de");
  assert.equal("language_code" in ttsRequest("Guten Tag.", { voiceId: "v1", format: "mp3_44100_128", modelId: "eleven_multilingual_v2", languageCode: "de" }).body, false);
  assert.equal("language_code" in ttsRequest("Guten Tag.", { voiceId: "v1", format: "ulaw_8000", modelId: "something-new", languageCode: "de" }).body, false);
  // English asks exactly what it did: no language field at all.
  const en = ttsRequest("Hello.", { voiceId: "v1", format: "ulaw_8000", previousText: "Hi" });
  assert.deepEqual(Object.keys(en.body), ["text", "model_id", "previous_text", "voice_settings"]);
});

await test("a German venue's voice parameters carry the language; the greeting clip is spoken German", async () => {
  await withGerman(() => {
    const venue = inGerman(restaurant);
    const params = voiceParams(venue, toSpoken("Um 14:30 Uhr.", "de"), "pcm_16000");
    assert.equal(params.languageCode, "de");
    assert.equal(params.text, "Um vierzehn Uhr dreißig.");
    assert.equal(params.speed, PACE.careful * ((venue.agent.voiceSpeed ?? 1.05) / 1.05));
    const clip = greetingClip(venue, "Guten Tag, Tisch für 2?", "ulaw_8000");
    assert.equal(clip.text, "Guten Tag, Tisch für zwei?");
    assert.equal(clip.languageCode, "de");
  });
});

await test("a German venue on the house voice speaks in the German voice named for the account", () => {
  const env = { ELEVENLABS_VOICE_ID_DE: "german_voice" };
  assert.equal(voiceIdFor({ voiceId: HOUSE_VOICE_ID }, "de", env), "german_voice");
  assert.equal(voiceIdFor({ voiceId: "owner_picked" }, "de", env), "owner_picked", "an owner's own choice was overridden");
  assert.equal(voiceIdFor({ voiceId: HOUSE_VOICE_ID }, "en", env), HOUSE_VOICE_ID);
  assert.equal(voiceIdFor({ voiceId: HOUSE_VOICE_ID }, "de", {}), HOUSE_VOICE_ID, "with no German voice configured, the voice is kept");
});

await test("Twilio reads German with a German voice Twilio lists, in de-DE", async () => {
  assert.deepEqual(SAY_VOICE.de, { voice: "Polly.Vicki-Neural", language: "de-DE" });
  assert.equal(sayTwiml("de", "Grüß Gott & servus"), `<Say voice="Polly.Vicki-Neural" language="de-DE">Grüß Gott &amp; servus</Say>`);
  await withGerman(() => {
    const twiml = voicemailTwiml(inGerman(restaurant));
    assert.match(twiml, /<Say voice="Polly\.Vicki-Neural" language="de-DE">Vielen Dank für Ihren Anruf bei /);
    assert.match(twiml, /<Record /);
  });
});

await test("every Twilio route that speaks to a customer chooses by the venue's language", () => {
  for (const file of ["src/app/api/twilio/voice/route.ts", "src/app/api/twilio/voicemail/route.ts", "src/app/api/twilio/transfer/route.ts"]) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.match(source, /answersIn/, `${file} never asks the venue's language`);
    assert.match(source, /sayTwiml\((?:"de"|language)/, `${file} has no German <Say>`);
  }
});

// ---------------------------------------------------------------------------
head("German read aloud: times, dates, prices, numbers, references");

const SPOKEN: [string, string][] = [
  // Times, on the twenty-four hour clock.
  ["Um 14:30 Uhr.", "Um vierzehn Uhr dreißig."],
  ["Um 14:30.", "Um vierzehn Uhr dreißig."],
  ["Ab 9 Uhr.", "Ab neun Uhr."],
  ["Um 1:00 Uhr.", "Um ein Uhr."],
  ["Um 0:15 Uhr.", "Um null Uhr fünfzehn."],
  ["Um 12:05.", "Um zwölf Uhr fünf."],
  ["Um 8.30 Uhr.", "Um acht Uhr dreißig."],
  ["Um 21:45 Uhr.", "Um einundzwanzig Uhr fünfundvierzig."],
  ["Bis 7:30 PM.", "Bis neunzehn Uhr dreißig."],
  ["Ab 9 AM.", "Ab neun Uhr."],
  ["Um 9 am Montag.", "Um neun am Montag."],
  // Dates, with the ending the words around them need.
  ["Donnerstag, 17. September.", "Donnerstag, siebzehnter September."],
  ["Am Donnerstag, 17. September.", "Am Donnerstag, dem siebzehnten September."],
  ["Am 1. Oktober.", "Am ersten Oktober."],
  ["Bis zum 3. März.", "Bis zum dritten März."],
  ["Der 7. Mai passt.", "Der siebte Mai passt."],
  ["Am 20.09.", "Am zwanzigsten September."],
  ["Am 31.12.2026.", "Am einunddreißigsten Dezember zweitausendsechsundzwanzig."],
  // Prices, in the venue's own money.
  ["Das kostet 69 €.", "Das kostet neunundsechzig Euro."],
  ["Das kostet €69,50.", "Das kostet neunundsechzig Euro fünfzig."],
  ["Das sind EUR 120.", "Das sind einhundertzwanzig Euro."],
  ["Der Schnitt kostet CHF 45.–.", "Der Schnitt kostet fünfundvierzig Franken."],
  ["Das kostet 45 CHF.", "Das kostet fünfundvierzig Franken."],
  ["Nur 1 €.", "Nur ein Euro."],
  ["Insgesamt 1.250,00 €.", "Insgesamt eintausendzweihundertfünfzig Euro."],
  ["Etwa 1'200 Franken.", "Etwa eintausendzweihundert Franken."],
  ["Das sind 21,05 Euro.", "Das sind einundzwanzig Euro fünf."],
  // Phone numbers, a digit at a time, "zwo" for two.
  ["Unter 030 1234567.", "Unter null drei null, eins zwo drei, vier fünf sechs sieben."],
  ["Rufen Sie +41 44 123 45 67 an.", "Rufen Sie plus vier eins vier, vier eins zwo, drei vier fünf, sechs sieben an."],
  ["Telefon 0171/2345678.", "Telefon null eins sieben, eins zwo drei, vier fünf sechs, sieben acht."],
  // Booking references, by German letter names.
  ["Ihre Referenz ist R7K2.", "Ihre Referenz ist Er, sieben, Ka, zwo."],
  ["Referenz: ACDE.", "Referenz: A, Ze, De, E."],
  ["Code X9Y4 notiert.", "Code Ix, neun, Ypsilon, vier notiert."],
  // Counts, durations and the words that shorten them.
  ["Ein Tisch für 4 Personen.", "Ein Tisch für vier Personen."],
  ["Für 1 Person.", "Für eine Person."],
  ["Das dauert 90 Min.", "Das dauert neunzig Minuten."],
  ["Etwa 2 Std. insgesamt.", "Etwa zwei Stunden insgesamt."],
  ["Bei Dr. Weber.", "Bei Doktor Weber."],
  ["Salon Haar & Bart.", "Salon Haar und Bart."],
  ["Z. B. am Montag.", "Zum Beispiel am Montag."],
  ["Das ist z. B. möglich.", "Das ist zum Beispiel möglich."],
  // Left alone: plain talk, postcodes, ordinary capitals.
  ["Wie kann ich Ihnen helfen?", "Wie kann ich Ihnen helfen?"],
  ["Hauptstraße 5, 10115 Berlin.", "Hauptstraße fünf, 10115 Berlin."],
  ["Die GmbH ist geschlossen.", "Die GmbH ist geschlossen."],
];

for (const [written, said] of SPOKEN) {
  await test(`"${written}"`, () => assert.equal(toSpoken(written, "de").text, said));
}

await test("German numbers from nought to the hundred thousands", () => {
  const cases: [number, string][] = [
    [0, "null"], [1, "eins"], [2, "zwei"], [11, "elf"], [16, "sechzehn"], [17, "siebzehn"], [20, "zwanzig"],
    [21, "einundzwanzig"], [30, "dreißig"], [99, "neunundneunzig"], [100, "einhundert"], [101, "einhunderteins"],
    [110, "einhundertzehn"], [365, "dreihundertfünfundsechzig"], [1000, "eintausend"], [2026, "zweitausendsechsundzwanzig"],
    [12345, "zwölftausenddreihundertfünfundvierzig"], [999999, "neunhundertneunundneunzigtausendneunhundertneunundneunzig"],
  ];
  for (const [n, words] of cases) assert.equal(germanNumber(n), words, String(n));
  assert.equal(germanNumber(1, "ein"), "ein");
  assert.equal(germanNumber(1, "eine"), "eine");
});

await test("a time, a price or a reference is said slowly; talk is not", () => {
  assert.equal(toSpoken("Um 14:30 Uhr.", "de").speed, PACE.careful);
  assert.equal(toSpoken("Das kostet 69 €.", "de").speed, PACE.careful);
  assert.equal(toSpoken("Referenz R7K2.", "de").speed, PACE.careful);
  assert.equal(toSpoken("Am Donnerstag?", "de").speed, PACE.careful);
  assert.equal(toSpoken("Wie kann ich Ihnen helfen?", "de").speed, PACE.talk);
});

await test("markdown never reaches a German voice", () => {
  assert.doesNotMatch(toSpoken("**Wichtig**: die _Anzahlung_ ist `fällig`.", "de").text, /[*_`]/);
});

await test("the written forms a German confirmation uses", () => {
  assert.equal(dateToGerman("2026-09-17"), "Donnerstag, 17. September");
  assert.equal(dateToGerman("2027-03-01"), "Montag, 1. März");
  assert.equal(minutesToGerman(870), "14:30 Uhr");
  assert.equal(minutesToGerman(540), "9 Uhr");
  assert.equal(minutesToGerman(5), "0:05 Uhr");
  // What the layer does with them, end to end.
  assert.equal(toSpoken(`${dateToGerman("2026-09-17")} um ${minutesToGerman(870)}.`, "de").text, "Donnerstag, siebzehnter September um vierzehn Uhr dreißig.");
});

await test("Swiss written German has no ß", () => {
  assert.equal(swissSpelling("Grüße aus der Straße, ẞ"), "Grüsse aus der Strasse, SS");
  const zurich = inGerman(salon, { timezone: "Europe/Zurich", currency: "CHF" });
  assert.equal(inHouseSpelling(zurich, "Straße"), "Straße", "Swiss spelling applied with the flag off");
  process.env.FLAG_LANGUAGE_DE = "on";
  try {
    assert.equal(inHouseSpelling(zurich, "Straße"), "Strasse");
    assert.equal(inHouseSpelling(inGerman(salon), "Straße"), "Straße");
  } finally {
    delete process.env.FLAG_LANGUAGE_DE;
  }
});

// ---------------------------------------------------------------------------
head("The prompt, in German");

await test("a German venue's prompt asks for German, formal Sie, and the same rules", async () => {
  await withGerman(() => {
    const venue = inGerman(restaurant);
    for (const channel of ["voice", "text"] as const) {
      const prompt = staticPrompt(venue, channel);
      assert.match(prompt, /# Language: German/);
      assert.match(prompt, /formal "Sie", never "du"/);
      assert.match(prompt, /AI assistant for .*"Ich bin die KI-Assistenz von /);
      assert.match(prompt, /Never claim to be a person/);
      assert.match(prompt, /Answer only from what this prompt says/);
      assert.match(prompt, /Never invent a price, a time, availability or a policy/);
      assert.match(prompt, /"Gebucht", "bestätigt", "reserviert", "eingetragen" and "bis dann"/);
      assert.match(prompt, /tool names and fields are not translated, dates are YYYY-MM-DD and times HH:MM/);
      // The English rules are all still there, untouched: German adds, it never replaces.
      assert.equal(prompt.replace(languageBlock(venue, channel), ""), staticPrompt(inEnglish(venue), channel));
    }
  });
});

await test("the spoken and written German rules differ where the media do", async () => {
  await withGerman(() => {
    const venue = inGerman(restaurant);
    const voice = languageBlock(venue, "voice");
    const text = languageBlock(venue, "text");
    assert.match(voice, /"14:30 Uhr", "9 Uhr"\. The voice reads them out properly/);
    assert.match(voice, /Never open with those/);
    assert.match(voice, /This line listens for German\. If a caller cannot carry on in German/);
    assert.match(text, /If someone writes to you in English, answer in English/);
    assert.doesNotMatch(text, /listens for German/);
  });
});

await test("a clinic is told 112, a Swiss venue is told to write ss", async () => {
  await withGerman(() => {
    assert.match(languageBlock(inGerman(clinic), "voice"), /emergency number in Germany, Austria and Switzerland is 112/);
    assert.doesNotMatch(languageBlock(inGerman(restaurant), "voice"), /112/);
    const zurich = languageBlock(inGerman(salon, { timezone: "Europe/Zurich", currency: "CHF" }), "text");
    assert.match(zurich, /Write "ss", never "ß"/);
    assert.doesNotMatch(languageBlock(inGerman(salon), "text"), /Switzerland/);
  });
});

await test("the tools a German venue's model is given are the English ones", async () => {
  const { toolsFor } = await import("../src/lib/agent/tools");
  const venue = inGerman(restaurant);
  const english = JSON.stringify(toolsFor(inEnglish(venue), "voice"));
  await withGerman(() => assert.equal(JSON.stringify(toolsFor(venue, "voice")), english));
});

// ---------------------------------------------------------------------------
head("Every system message a customer meets has its German");

await test("every line has English and German, the German is German, and the blanks match", () => {
  const keys = Object.keys(CUSTOMER_COPY) as (keyof typeof CUSTOMER_COPY)[];
  assert.ok(keys.length > 100, `only ${keys.length} lines`);
  const problems: string[] = [];
  for (const key of keys) {
    const line = CUSTOMER_COPY[key] as { en?: string; de?: string };
    if (!line.en?.trim()) problems.push(`${key}: no English`);
    if (!line.de?.trim()) problems.push(`${key}: no German`);
    if (line.en && line.de && line.en === line.de) problems.push(`${key}: the German is the English`);
    if (line.en && line.de && JSON.stringify(placeholdersOf(line.en)) !== JSON.stringify(placeholdersOf(line.de))) {
      problems.push(`${key}: blanks differ, ${placeholdersOf(line.en)} vs ${placeholdersOf(line.de)}`);
    }
    // German that reads as a template left in English.
    if (line.de && /\b(the|please|your|booking|call us|thank you)\b/i.test(line.de)) problems.push(`${key}: English words in the German`);
  }
  assert.deepEqual(problems, []);
});

await test("the lines handed to the chat box, the call button and the manage page all exist", () => {
  for (const key of [...CHAT_KEYS, ...CALL_KEYS, ...MANAGE_KEYS]) assert.ok(key in CUSTOMER_COPY, key);
});

await test("the German register is formal: no du, no dich, no dein", () => {
  const informal = Object.entries(CUSTOMER_COPY).filter(([, l]) => /\b(du|dich|dir|dein|deine|deinen)\b/i.test(l.de)).map(([k]) => k);
  assert.deepEqual(informal, []);
});

await test("every customer-facing module reads its words through the table and the venue's language", () => {
  const modules = [
    "src/lib/telephony/voicemail.ts",
    "src/app/api/twilio/voice/route.ts",
    "src/app/api/twilio/voicemail/route.ts",
    "src/app/api/twilio/transfer/route.ts",
    "src/lib/voice/session.ts",
    "src/lib/agent/runtime.ts",
    "src/lib/agent/honesty.ts",
    "src/lib/agent/authority.ts",
    "src/lib/billing/entitlement.ts",
    "src/lib/webchat.ts",
    "src/lib/webchat-turn.ts",
    "src/lib/embed.ts",
    "src/lib/chat-link.ts",
    "src/lib/reception/respond.ts",
    "src/lib/reminders.ts",
    "src/lib/booking/index.ts",
    "src/lib/booking/manage.ts",
    "src/lib/booking/policy.ts",
    "src/lib/billing/deposits.ts",
    "src/app/api/manage/route.ts",
    "src/app/api/call/status/route.ts",
    "src/app/b/[token]/page.tsx",
    "src/app/b/[token]/ManageBooking.tsx",
    "src/app/embed/[key]/page.tsx",
    "src/app/embed/[key]/chat/page.tsx",
    "src/app/embed/[key]/chat/Chat.tsx",
    "src/app/c/[key]/page.tsx",
    "src/app/(app)/test/Console.tsx",
  ];
  const missing = modules.filter((file) => !/customer-copy|lib\/language"|\.\.?\/language"/.test(fs.readFileSync(path.join(ROOT, file), "utf8")));
  assert.deepEqual(missing, []);
});

await test("the chat box, call button and manage page get German only from a German venue's page", () => {
  for (const file of ["src/app/embed/[key]/chat/page.tsx", "src/app/c/[key]/page.tsx", "src/app/embed/[key]/page.tsx"]) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.match(source, /answersIn\(location(?:, [A-Z_]+|, \{[^}]*\})?\)/, file);
    assert.match(source, /copyTable\(/, file);
  }
});

await test("German venues' texts, emails, calendar files and manage page speak German", async () => {
  await withGerman(() => {
    const venue = { ...inGerman(restaurant), businessPhone: "+4930123456", policy: { cancellationWindowHours: 24, lateCancelFee: 20 } } as Location;
    const booking = restaurantBooking(venue);
    const reminder = reminderMessage(venue, booking);
    assert.match(reminder, /Erinnerung an Ihre Buchung – Tisch für 2, Donnerstag, 17\. Juni um 19:30 Uhr\. Referenz R7K2\. Zum Ändern oder Stornieren rufen Sie bitte \+4930123456 an\./);
    assert.match(confirmationMessage(venue, booking), /Tisch für 2 bestätigt für Donnerstag, 17\. Juni um 19:30 Uhr\. Referenz R7K2\. Ändern oder stornieren: /);
    const email = bookingEmail(venue, booking, "confirmed");
    assert.match(email.subject, /^Bestätigt: Tisch für 2, Donnerstag, 17\. Juni um 19:30 Uhr – /);
    assert.match(email.text, /^Ihre Buchung ist bestätigt\.\n\nWas: Tisch für 2\nWann: /);
    assert.match(email.text, /Stornierungsfrist von 24 Stunden/);
    assert.match(email.html, /Ändern oder stornieren/);
    assert.match(email.html, /Im Auftrag von /);
    assert.match(bookingIcs(venue, booking), /DESCRIPTION:Referenz R7K2\. Ändern oder stornieren/);
    assert.equal(whatWasBooked(venue, { ...booking, vertical: "salon", serviceIds: [] }, "de"), "Termin");
    assert.equal(manageable(venue, { ...booking, status: "cancelled" }, Date.now(), "de").why, "Diese Buchung wurde storniert.");
    assert.match(lateCancelNotice(venue, "de")!, /EUR 20/);
    assert.match(ceilingMessage(venue), /^Weiter komme ich hier leider nicht\. Bitte rufen Sie uns unter \+4930123456 an/);
    assert.match(lineFor(venue, "phone.not_answering", { name: venue.name }), /^Vielen Dank für Ihren Anruf bei /);
  });
});

await test("a Swiss venue's texts are spelled the Swiss way", async () => {
  await withGerman(() => {
    const zurich = { ...inGerman(salon, { timezone: "Europe/Zurich", currency: "CHF" }), name: "Salon Grüße" } as Location;
    assert.match(lineFor(zurich, "embed.not_switched_on", { name: zurich.name }), /Salon Grüsse hat das noch nicht eingeschaltet\./);
  });
});

await test("a German venue on the default English opening line is greeted in German; an owner's own line is kept", async () => {
  await withGerman(() => {
    // Not on the demo line, whose disclosure opens every greeting.
    const venue = inGerman({ ...restaurant, demo: undefined, agent: { ...restaurant.agent, greeting: copy("en", "greeting.default", { name: restaurant.name }) } });
    assert.equal(greetingFor(venue), `Guten Tag, Sie sind verbunden mit ${restaurant.name}, hier spricht Belline. Wie kann ich Ihnen helfen?`);
    const own = inGerman({ ...restaurant, demo: undefined, agent: { ...restaurant.agent, greeting: "Grüß Gott, Azure am Apparat." } });
    assert.equal(greetingFor(own), "Grüß Gott, Azure am Apparat.");
    assert.deepEqual(acknowledgementsFor(venue), ["Gerne.", "Alles klar.", "Genau.", "Einen Moment."]);
  });
});

// ---------------------------------------------------------------------------
head("Turn-taking and the guards, in German");

await test("German listening noises do not interrupt; a German sentence does", () => {
  for (const noise of ["ähm", "mhm", "ja", "Ja, genau.", "genau", "alles klar", "ach so", "okay", "super"]) assert.ok(isBackchannel(noise, "de"), noise);
  for (const turn of ["ja, aber lieber um sieben", "genau, und für vier Personen", "nein"]) assert.ok(!isBackchannel(turn, "de"), turn);
});

await test("a German caller in an emergency is told 112, in German", async () => {
  await withGerman(() => {
    const result = assessAuthority(inGerman(clinic), "Mein Vater hat gerade Brustschmerzen und atmet schwer.");
    assert.equal(result?.rule.id, "medical-emergency");
    assert.match(result!.rule.say, /Notruf 112/);
  });
});

await test("German claims, offers and invented times are all caught", () => {
  assert.equal(checkRequestReply("Alles klar, Sie sind gebucht!", "de").ok, false);
  assert.equal(checkRequestReply("Ich habe Sie für Freitag eingetragen.", "de").ok, false);
  assert.equal(checkRequestReply("Das Team bestätigt Ihnen den Termin, sobald er eingetragen ist.", "de").ok, true);
  assert.equal(checkSlotOffers("Ich hätte um 18:30 Uhr noch etwas frei.", "de").ok, false);
  assert.equal(checkSlotOffers("Was halten Sie von 19 Uhr?", "de").ok, false);
  assert.equal(checkSlotOffers("Sie möchten also um 19 Uhr kommen – das gebe ich so weiter.", "de").ok, true);
  assert.equal(checkTimes("Da hätte ich 16 Uhr für Sie.", [], undefined, undefined, "de").ok, false);
  assert.deepEqual(timesIn("zwischen 10 und 12 Uhr", "de"), [720]);
});

// ---------------------------------------------------------------------------
head("The registry: languages as data, in waves");

const { LANGUAGE_REGISTRY, languageEntry, MAX_ALSO_LANGUAGES } = await import("../src/config/languages");
type LanguageCode = import("../src/config/languages").LanguageCode;
const {
  allowedLanguages,
  checkLanguages,
  defaultLanguageFor,
  detectLanguage,
  directionOf,
  languageNotice,
  languageUsable,
  languagesFor,
  selectableLanguages,
} = await import("../src/lib/language");
const { copyComplete } = await import("../src/lib/customer-copy");
const { guardsCover } = await import("../src/lib/agent/guard-phrases");
const { conversationLanguageNote } = await import("../src/lib/agent/prompt");
const { LanguagePick, askGreetingParts, languageNamed, sttLanguageFor } = await import("../src/lib/voice/language-pick");
const { widgetConfig } = await import("../src/lib/embed");
const { conversationLanguage } = await import("../src/lib/reception/respond");
const { VoiceSession } = await import("../src/lib/voice/session");

/** A venue answering in English and German, and how a call picks. */
function bilingual(base: Location, main: "en" | "de" = "en", pick: "auto" | "ask" = "auto"): Location {
  const also = main === "en" ? (["de"] as const) : (["en"] as const);
  return { ...base, demo: undefined, language: main, languages: { main, also: [...also], pick } };
}

await test("the tiers: English live in wave 1; German live and French and Spanish being localised in wave 2; the rest planned in wave 3", () => {
  const by = Object.fromEntries(LANGUAGE_REGISTRY.map((l) => [l.code, l]));
  assert.deepEqual(
    LANGUAGE_REGISTRY.map((l) => [l.code, l.wave, l.status]),
    [
      ["en", 1, "live"],
      ["de", 2, "live"],
      ["fr", 2, "localising"],
      ["es", 2, "localising"],
      ["ar", 3, "planned"],
      ["pt", 3, "planned"],
      ["it", 3, "planned"],
      ["nl", 3, "planned"],
      ["tr", 3, "planned"],
    ],
  );
  assert.equal(by.de.flag, "language.de");
  assert.equal(new Set(LANGUAGE_REGISTRY.map((l) => l.code)).size, LANGUAGE_REGISTRY.length, "a code is listed twice");
  for (const l of LANGUAGE_REGISTRY) assert.equal(l.fallback, "en", l.code);
});

await test("slots carry no content: no voice, prompt or Twilio voice for anything not live", () => {
  for (const l of LANGUAGE_REGISTRY.filter((x) => x.status !== "live")) {
    assert.equal(l.prompt, null, `${l.code} has a prompt`);
    assert.equal(l.tts, null, `${l.code} has a voice`);
    assert.equal(l.twilio, null, `${l.code} has a Twilio voice`);
    assert.equal(copyComplete(l.code), false, `${l.code} has every customer line`);
    assert.equal(guardsCover(l.code), false, `${l.code} has guard phrases`);
  }
  for (const l of LANGUAGE_REGISTRY.filter((x) => x.wave === 3)) assert.equal(l.stt, null, `${l.code} has a recogniser`);
});

await test("formality defaults and regional variants are data: Sie, vous, usted; de-CH, en-US, es-MX, pt-BR", () => {
  assert.deepEqual(languageEntry("de").formality, { default: "Sie", options: ["Sie", "du"] });
  assert.equal(languageEntry("fr").formality?.default, "vous");
  assert.equal(languageEntry("es").formality?.default, "usted");
  assert.deepEqual(languageEntry("en").variants.map((v) => v.tag), ["en-GB", "en-US"]);
  assert.deepEqual(languageEntry("es").variants.map((v) => v.tag), ["es-ES", "es-MX"]);
  assert.deepEqual(languageEntry("pt").variants.map((v) => v.tag), ["pt-PT", "pt-BR"]);
  assert.equal(languageEntry("de").variants.find((v) => v.tag === "de-CH")?.sttCode, "de-CH");
});

await test("only live, flagged-on, fully built languages can be chosen: English alone, then German with its flag", async () => {
  assert.deepEqual(selectableLanguages().map((l) => l.code), ["en"]);
  await withGerman(() => assert.deepEqual(selectableLanguages().map((l) => l.code), ["en", "de"]));
  // Arabic, French and the rest are never offered, whatever the environment.
  const everything = Object.fromEntries(LANGUAGE_REGISTRY.map((l) => [`FLAG_LANGUAGE_${l.code.toUpperCase()}`, "on"]));
  assert.deepEqual(selectableLanguages(everything).map((l) => l.code), ["en", "de"]);
  for (const code of ["fr", "es", "ar", "pt", "it", "nl", "tr"] as const) assert.equal(languageUsable(code, everything), false, code);
});

await test("a language without guards or without every customer line cannot be used", () => {
  assert.equal(guardsCover("en"), true);
  assert.equal(guardsCover("de"), true);
  assert.equal(copyComplete("de"), true);
  assert.equal(guardsCover("ar"), false);
  assert.equal(copyComplete("fr"), false);
});

await test("a missing line falls back to English and says so in the log", () => {
  const warned: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warned.push(args.map(String).join(" "));
  try {
    assert.equal(copy("fr", "chat.send"), "Send");
    assert.equal(copy("fr", "chat.send"), "Send");
  } finally {
    console.warn = original;
  }
  assert.equal(warned.length, 1, "logged more than once, or not at all");
  assert.match(warned[0], /"chat\.send" has no fr line/);
});

// ---------------------------------------------------------------------------
head("A business's languages: main, up to two more, auto or ask, per channel");

await test("validation: at most two more, never the main one, never twice, only selectable languages", () => {
  const four = ["en", "de", "fr", "es"] as const;
  assert.deepEqual(checkLanguages({ main: "en", also: ["de", "fr"], pick: "ask" }, four), {
    ok: true,
    value: { main: "en", also: ["de", "fr"], pick: "ask" },
  });
  assert.equal(MAX_ALSO_LANGUAGES, 2);
  const refused = (raw: unknown, field: string, selectable: readonly LanguageCode[] = four) => {
    const r = checkLanguages(raw, selectable);
    assert.equal(r.ok, false, JSON.stringify(raw));
    if (!r.ok) assert.equal(r.field, field, JSON.stringify(raw));
  };
  refused({ main: "en", also: ["de", "fr", "es"] }, "also");
  refused({ main: "de", also: ["de"] }, "also");
  refused({ main: "en", also: ["de", "de"] }, "also");
  refused({ main: "en", also: ["ar"] }, "also");
  refused({ main: "ar", also: [] }, "main");
  refused({ main: "en", also: "de" }, "also");
  refused({ main: "en", pick: "sometimes" }, "pick");
  refused({ main: "en", channels: { fax: "de" } }, "channels");
  refused({ main: "en", channels: { whatsapp: "ar" } }, "channels.whatsapp");
  refused({ main: "de", formality: { de: "Ihr" } }, "formality.de");
  refused(null, "main");
  // The deployment's own list: German is refused while its flag is off.
  refused({ main: "de" }, "main", selectableLanguages().map((l) => l.code));
});

await test("validation keeps per-channel languages and a non-default form of address, and drops the defaults", () => {
  const r = checkLanguages(
    { main: "en", also: ["de"], pick: "auto", channels: { whatsapp: "de", phone: "" }, formality: { de: "du" } },
    ["en", "de"],
  );
  assert.deepEqual(r, { ok: true, value: { main: "en", also: ["de"], pick: "auto", channels: { whatsapp: "de" }, formality: { de: "du" } } });
  const plain = checkLanguages({ main: "de", formality: { de: "Sie" } }, ["en", "de"]);
  assert.deepEqual(plain, { ok: true, value: { main: "de", also: [], pick: "auto" } });
});

await test("flag off: a business saved as German-and-English is English only, with no notice and the English prompt", () => {
  const venue = bilingual(restaurant, "de");
  assert.deepEqual(allowedLanguages(venue), ["en"]);
  assert.equal(languageNotice(venue), null);
  assert.equal(staticPrompt(venue, "voice"), staticPrompt(inEnglish(venue), "voice"));
  assert.equal(new LanguagePick(languagesFor(venue)).locked, true, "a one-language call had something to decide");
});

await test("a channel can have its own main language; the business's main stays reachable there", async () => {
  const venue: Location = { ...inEnglish(restaurant), languages: { main: "en", also: [], pick: "auto", channels: { whatsapp: "de" } } };
  assert.equal(answersIn(venue, { channel: "whatsapp" }), "en", "German without its flag");
  await withGerman(() => {
    assert.equal(answersIn(venue, { channel: "whatsapp" }), "de");
    assert.deepEqual(allowedLanguages(venue, { channel: "whatsapp" }), ["de", "en"]);
    assert.equal(answersIn(venue, { channel: "phone" }), "en");
    assert.deepEqual(allowedLanguages(venue, { channel: "phone" }), ["en"]);
    assert.match(lineFor(venue, "messages.not_answering", {}, { channel: "whatsapp" }), /^Wir können hier gerade nicht antworten/);
  });
});

await test("the conversation's language counts only where the business speaks it", async () => {
  await withGerman(() => {
    const venue = bilingual(restaurant);
    assert.equal(answersIn(venue, { current: "de" }), "de");
    assert.equal(answersIn(venue, { current: "fr" }), "en");
    assert.equal(answersIn(inEnglish(restaurant), { current: "de" }), "en");
  });
});

await test("a business starts in its country's language: German in Germany, Austria and Switzerland, English elsewhere", () => {
  assert.equal(defaultLanguageFor({ market: "DE" }), "de");
  assert.equal(defaultLanguageFor({ market: "AT" }), "de");
  assert.equal(defaultLanguageFor({ subscription: { market: "CH" } }), "de");
  assert.equal(defaultLanguageFor({ market: "AE" }), "en");
  assert.equal(defaultLanguageFor({ market: "GB" }), "en");
  assert.equal(defaultLanguageFor({ currency: "CHF", timezone: "Europe/Zurich" }), "de");
  assert.equal(defaultLanguageFor({}), "en");
  const berlin = blankVenue({ businessName: "Café Sonne", email: "owner@sonne.test", password: "x", market: "DE" } as never, "ten_x", "biz_x");
  assert.deepEqual(berlin.languages, { main: "de", also: [], pick: "auto" });
  assert.equal(answersIn(berlin), "en", "answered in German with its flag off");
});

// ---------------------------------------------------------------------------
head("The prompt, for a business speaking more than one language");

await test("the agent is told the main language, the others, and the switching rule, per channel and pick", async () => {
  await withGerman(() => {
    const auto = bilingual(restaurant);
    const voice = languageBlock(auto, "voice");
    assert.match(voice, /^\n\n# Languages\n/);
    assert.match(voice, /answers in English, and also in German\./);
    assert.match(voice, /The greeting was in English\. The moment the caller speaks German, answer in that language, and stay in it/);
    assert.match(voice, /carry on in English and say once, in one short sentence, that you can speak English, Deutsch/);
    assert.match(voice, /## When answering in German\n- Always the formal "Sie"/);
    assert.doesNotMatch(voice, /Everyone who gets in touch/);
    assert.doesNotMatch(voice, /This line listens for German/);
    assert.match(languageBlock(bilingual(restaurant, "en", "ask"), "voice"), /The greeting offered English and German\. Carry on in whichever the caller chooses/);
    const text = languageBlock(auto, "text");
    assert.match(text, /Answer in the language of the guest's latest message when it is English and German, and switch the moment they switch/);
    assert.doesNotMatch(text, /The greeting/);
    // German first: the same rules, the other way round.
    assert.match(languageBlock(bilingual(restaurant, "de"), "voice"), /answers in German, and also in English\./);
    // The rules above it are the English prompt's, untouched.
    for (const channel of ["voice", "text"] as const) {
      assert.equal(staticPrompt(auto, channel).replace(languageBlock(auto, channel), ""), staticPrompt(inEnglish(auto), channel));
    }
  });
});

await test("the form of address is the business's choice: du where it chose du", async () => {
  await withGerman(() => {
    const du: Location = { ...inGerman(restaurant), languages: { main: "de", also: [], pick: "auto", formality: { de: "du" } } };
    const block = languageBlock(du, "text");
    assert.match(block, /Always the informal "du", never "Sie"/);
    assert.doesNotMatch(block, /Always the formal "Sie"/);
  });
});

await test("once a call settles on a language the model is told, in the volatile half of the prompt", async () => {
  await withGerman(() => {
    const venue = bilingual(restaurant);
    assert.equal(conversationLanguageNote(venue, "de"), "This call has settled on German: answer in German from now on.");
    assert.equal(conversationLanguageNote(venue, "de", undefined, "text"), "The latest message is in German: answer it in German.");
    assert.equal(conversationLanguageNote(venue, null), "");
    assert.equal(conversationLanguageNote(inGerman(restaurant), "de"), "", "a one-language business was told");
  });
});

// ---------------------------------------------------------------------------
head("A call in more than one language: the recogniser, auto and ask");

await test("the recogniser: one language's own code, multi for English and German together, the main language where multi cannot cover", () => {
  assert.equal(sttLanguageFor(restaurant, { main: "en", also: [] }), "en");
  assert.equal(sttLanguageFor(restaurant, { main: "de", also: [] }), "de");
  assert.equal(sttLanguageFor({ timezone: "Europe/Zurich", currency: "CHF" }, { main: "de", also: [] }), "de-CH");
  assert.equal(sttLanguageFor(restaurant, { main: "en", also: ["de"] }), "multi");
  assert.equal(sttLanguageFor(restaurant, { main: "de", also: ["en"] }), "multi");
  // Arabic is outside nova-3's multilingual mode and has no recogniser yet: the main language is listened for.
  assert.equal(sttLanguageFor(restaurant, { main: "en", also: ["ar"] }), "en");
  const multi = novaStreamParams({ encoding: "mulaw", sampleRate: 8000, language: "multi" });
  assert.equal(multi.get("language"), "multi");
  assert.equal(sttEngine("multi"), "nova-3");
});

await test("auto: a listening noise decides nothing; the first real utterance settles the call and locks it", () => {
  const pick = new LanguagePick({ main: "en", also: ["de"], pick: "auto" });
  assert.equal(pick.asks, false);
  assert.deepEqual(pick.hear("mhm"), { language: "en", changed: false, locked: false });
  assert.deepEqual(pick.hear("Guten Tag, ich möchte für morgen einen Tisch reservieren."), { language: "de", changed: true, locked: true });
  assert.deepEqual(pick.hear("Actually, can we do this in English?"), { language: "de", changed: false, locked: true });
  const stays = new LanguagePick({ main: "en", also: ["de"], pick: "auto" });
  assert.deepEqual(stays.hear("Hi, can I book a table for four tomorrow?"), { language: "en", changed: false, locked: true });
});

await test("auto: what the recogniser heard wins over the words; neither leaves the main language", () => {
  assert.equal(new LanguagePick({ main: "en", also: ["de"], pick: "auto" }).hear("Termin", ["de"]).language, "de");
  assert.equal(new LanguagePick({ main: "de", also: ["en"], pick: "auto" }).hear("19:30", []).language, "de");
  assert.equal(new LanguagePick({ main: "en", also: ["de"], pick: "auto" }).hear("Bonjour", ["fr"]).language, "en");
});

await test("ask: the greeting offers each language in its own words, and naming one chooses it", async () => {
  await withGerman(() => {
    const venue = bilingual(restaurant, "en", "ask");
    const pick = new LanguagePick(languagesFor(venue));
    assert.equal(pick.asks, true);
    assert.deepEqual(askGreetingParts(venue, "Thank you for calling Azure.", pick), [
      { language: "en", text: "Thank you for calling Azure." },
      { language: "de", text: "Sie können auch gern Deutsch mit mir sprechen." },
    ]);
    assert.deepEqual(pick.hear("Deutsch, bitte"), { language: "de", changed: true, locked: true });
    assert.equal(languageNamed("English please", ["de", "en"]), "en");
    assert.equal(languageNamed("Englisch", ["de", "en"]), "en");
    assert.equal(languageNamed("I would like to book a table for two on Friday evening please", ["en", "de"]), null);
    // A one-language business never asks.
    assert.equal(new LanguagePick(languagesFor(inEnglish(restaurant))).asks, false);
  });
});

/** A call with no line: records what the session sends and nothing else. No keys are set, so nothing leaves. */
function fakeTransport() {
  const events: Record<string, unknown>[] = [];
  return {
    events,
    transport: {
      input: { encoding: "linear16" as const, sampleRate: 16000 },
      output: "pcm_16000" as const,
      screen: false,
      sendAudio() {},
      sendEvent(e: Record<string, unknown>) {
        events.push(e);
      },
      clearAudio() {},
      close() {},
    },
  };
}

await test("a live session, stubbed: ask mode opens with every language; the caller's German settles the call", async () => {
  await withGerman(async () => {
    const venue = bilingual(getLocation(restaurant.id)!, "en", "ask");
    const call = { ...startCall(venue, "browser", "check"), isTest: true };
    const { events, transport } = fakeTransport();
    const session = new VoiceSession(venue, call, transport);
    await session.start();
    const greeting = events.find((e) => e.type === "transcript" && e.role === "agent")?.text as string;
    assert.match(greeting, /Sie können auch gern Deutsch mit mir sprechen\.$/);
    await session.onText("Guten Tag, ich hätte gern einen Tisch für zwei Personen.");
    assert.deepEqual(events.filter((e) => e.type === "language"), [{ type: "language", language: "de" }]);
    await session.end("answered_question");
  });
});

await test("a live session, stubbed: auto mode greets in the main language only and stays there for an English caller", async () => {
  await withGerman(async () => {
    const venue = bilingual(getLocation(restaurant.id)!, "en", "auto");
    const call = { ...startCall(venue, "browser", "check"), isTest: true };
    const { events, transport } = fakeTransport();
    const session = new VoiceSession(venue, call, transport);
    await session.start();
    const greeting = events.find((e) => e.type === "transcript" && e.role === "agent")?.text as string;
    assert.doesNotMatch(greeting, /Deutsch/);
    await session.onText("Hello, do you have a table for two tonight?");
    assert.deepEqual(events.filter((e) => e.type === "language"), []);
    await session.end("answered_question");
  });
});

await test("the voice follows the language of each fragment: German pinned, English sent as before", async () => {
  await withGerman(() => {
    const venue = bilingual(restaurant);
    assert.equal(voiceParams(venue, toSpoken("Gerne.", "de"), "ulaw_8000", "de").languageCode, "de");
    assert.equal("languageCode" in voiceParams(venue, toSpoken("Sure."), "ulaw_8000", "en"), false);
    assert.deepEqual(acknowledgementsFor(venue, "de"), ["Gerne.", "Alles klar.", "Genau.", "Einen Moment."]);
    assert.deepEqual(acknowledgementsFor(venue, "en"), ACKNOWLEDGEMENTS);
  });
});

// ---------------------------------------------------------------------------
head("Guards, chat and messages across a business's languages");

await test("a business speaking English and German is guarded in both, and its repairs speak the reply's language", () => {
  const both = ["en", "de"] as const;
  assert.equal(checkRequestReply("Perfekt, Sie sind für Freitag gebucht.", both).ok, false);
  assert.equal(checkRequestReply("You're booked for Friday.", both).ok, false);
  assert.equal(checkSlotOffers("Ich hätte um 18:30 Uhr noch etwas frei.", both).ok, false);
  assert.equal(checkTimes("Da hätte ich 16 Uhr für Sie.", [], undefined, undefined, both).ok, false);
  assert.match(repairReply("Ich hätte 16 Uhr.", checkTimes("Ich hätte 16 Uhr.", [], undefined, undefined, both), { language: ["de", "en"] }), /Soll ich an einem anderen Tag/);
  assert.match(repairReply("I have 4 PM.", checkTimes("I have 4 PM.", [], undefined, undefined, both), { language: ["en", "de"] }), /Would you like me to look at another day/);
  assert.ok(isBackchannel("ja genau", both));
  assert.ok(isBackchannel("mm-hmm", both));
  assert.ok(!isBackchannel("ja, aber lieber um sieben", both));
  // An English-only business reads no German, exactly as before.
  assert.equal(checkRequestReply("Sie sind gebucht.", "en").ok, true);
});

await test("authority reads every language the business speaks and answers in the conversation's", async () => {
  await withGerman(() => {
    const venue = bilingual(clinic);
    const german = assessAuthority(venue, "Ich habe gerade starke Brustschmerzen.", "de");
    assert.equal(german?.rule.id, "medical-emergency");
    assert.match(german!.rule.say, /Notruf 112/);
    assert.match(assessAuthority(venue, "Ich habe gerade starke Brustschmerzen.")!.rule.say, /call 998/, "said in German before the call settled on it");
    assert.match(assessAuthority(venue, "I have chest pain right now.", "de")!.rule.say, /Notruf 112/);
  });
});

await test("chat follows the customer's written language, and stays put when a message does not tell", async () => {
  assert.equal(detectLanguage("Hallo, haben Sie morgen noch einen Tisch frei?", ["en", "de"]), "de");
  assert.equal(detectLanguage("Hi, do you have a table tomorrow?", ["en", "de"]), "en");
  assert.equal(detectLanguage("Grüße", ["en", "de"]), "de");
  assert.equal(detectLanguage("ok", ["en", "de"]), null);
  assert.equal(detectLanguage("19:30", ["en", "de"]), null);
  assert.equal(detectLanguage("Hallo, haben Sie morgen frei?", ["en"]), null, "a one-language business detected something");
  await withGerman(() => {
    const venue = bilingual(restaurant);
    const history = [
      { role: "user" as const, content: "Guten Tag, ich möchte einen Termin." },
      { role: "assistant" as const, content: "Gern, für wann?" },
    ];
    assert.equal(conversationLanguage(venue, "web_chat", "19:30", history), "de");
    assert.equal(conversationLanguage(venue, "web_chat", "Sorry, can we switch to English?", history), "en");
    assert.equal(conversationLanguage(inEnglish(restaurant), "web_chat", "Guten Tag", history), null);
  });
});

await test("a booking made in the business's other language is confirmed and reminded in it", async () => {
  await withGerman(() => {
    const venue = { ...bilingual(restaurant), businessPhone: "+4930123456" } as Location;
    const booking = { ...restaurantBooking(venue), language: "de" as const };
    assert.match(confirmationMessage(venue, booking), /Tisch für 2 bestätigt für Donnerstag, 17\. Juni um 19:30 Uhr/);
    assert.match(reminderMessage(venue, booking), /Erinnerung an Ihre Buchung/);
    assert.match(bookingEmail(venue, booking, "confirmed").subject, /^Bestätigt:/);
    assert.match(confirmationMessage(venue, restaurantBooking(venue)), /table for 2 confirmed for/);
  });
  const venue = bilingual(restaurant);
  assert.match(confirmationMessage(venue, { ...restaurantBooking(venue), language: "de" }), /table for 2 confirmed for/, "German with its flag off");
});

await test("every customer line exists in every language an owner can choose", () => {
  const live = LANGUAGE_REGISTRY.filter((l) => l.status === "live").map((l) => l.code);
  const missing: string[] = [];
  for (const [key, line] of Object.entries(CUSTOMER_COPY)) {
    for (const code of live) if (!(line as Record<string, string | undefined>)[code]?.trim()) missing.push(`${key}: ${code}`);
  }
  assert.deepEqual(missing, []);
});

// ---------------------------------------------------------------------------
head("The notice customers see, and the settings screen");

await test("'Also speaks', in the main language, only where there is another language, with each name as its speakers write it", async () => {
  assert.equal(languageNotice(bilingual(restaurant)), null, "German without its flag");
  await withGerman(() => {
    assert.equal(languageNotice(bilingual(restaurant)), "Also speaks Deutsch");
    assert.equal(languageNotice(bilingual(restaurant, "de")), "Spricht auch English");
    assert.equal(languageNotice(inEnglish(restaurant)), null);
    assert.equal(languageNotice(inGerman(restaurant)), null);
  });
});

await test("the widget config carries the notice only where there is one; a one-language widget's config is unchanged", async () => {
  const embed = { key: "be_test", mode: "chat" } as never;
  const plain = widgetConfig(embed, null, "en", null);
  assert.equal("notice" in plain || "strings" in plain || "dir" in plain, false);
  await withGerman(() => {
    const venue = bilingual(restaurant);
    const withNotice = widgetConfig(embed, null, "en", languageNotice(venue));
    assert.equal(withNotice.notice, "Also speaks Deutsch");
    assert.equal(withNotice.dir, "ltr");
    assert.equal(widgetConfig(embed, null, "de", null).strings?.closeChat, "Chat schließen");
  });
  assert.equal(directionOf("ar"), "rtl");
  assert.equal(directionOf("de"), "ltr");
});

await test("the widget script shows the notice and takes its words from the config; the chat box shows the notice right to left where needed", () => {
  const embedJs = fs.readFileSync(path.join(ROOT, "public/embed.js"), "utf8");
  assert.match(embedJs, /belline-notice/);
  assert.match(embedJs, /notice\.dir = cfg\.dir === "rtl" \? "rtl" : "auto"/);
  assert.match(embedJs, /STRINGS\.closeChat/);
  const chat = fs.readFileSync(path.join(ROOT, "src/app/embed/[key]/chat/Chat.tsx"), "utf8");
  assert.match(chat, /className="bl-languages" dir="auto"/);
  assert.match(chat, /dir=\{languageEntry\(language\)\.dir === "rtl" \? "rtl" : undefined\}/);
  for (const page of ["src/app/embed/[key]/chat/page.tsx", "src/app/c/[key]/page.tsx"]) {
    assert.match(fs.readFileSync(path.join(ROOT, page), "utf8"), /notice=\{languageNotice\(location, CHAT\)/, page);
  }
});

await test("the settings screen is one component with its own save, offering only selectable languages", () => {
  const component = fs.readFileSync(path.join(ROOT, "src/app/(app)/agents/LanguageSettings.tsx"), "utf8");
  for (const words of [
    "Main language",
    "Also speaks (up to",
    "How Belle picks the language",
    "Switch automatically (recommended)",
    "Ask callers first (phone only)",
    "Belle&rsquo;s safety checks only cover these languages, so only these can be chosen.",
    'fetch("/api/languages"',
  ]) {
    assert.ok(component.includes(words), words);
  }
  const route = fs.readFileSync(path.join(ROOT, "src/app/api/languages/route.ts"), "utf8");
  assert.match(route, /checkLanguages\(body\.languages\)/);
  assert.match(route, /canEditAgent/);
  const page = fs.readFileSync(path.join(ROOT, "src/app/(app)/agents/page.tsx"), "utf8");
  assert.match(page, /options=\{selectableLanguages\(\)/);
  const editor = fs.readFileSync(path.join(ROOT, "src/app/(app)/agents/AgentEditor.tsx"), "utf8");
  assert.doesNotMatch(editor, /Language customers are answered in/);
});

// ---------------------------------------------------------------------------
head("A German chat turn, end to end, with a scripted model");

await test("the real prompt, tools and guards run in German, and an invented time is repaired in German", async () => {
  await withGerman(async () => {
    const venue = { ...inGerman(getLocation(restaurant.id)!), timezone: restaurant.timezone };
    upsertLocation(venue);
    // A day the diary has something on, so the tool has times to return.
    const day = Array.from({ length: 14 }, (_, i) => new Date(Date.now() + (i + 1) * 86_400_000).toISOString().slice(0, 10)).find(
      (date) => findAvailability(venue, { locationId: venue.id, date, partySize: 2 }).length > 0,
    );
    assert.ok(day, "no open day in the next fortnight to test against");

    const seen: string[] = [];
    let offered: string[] = [];
    // First reply: the tool. Second: German, with one time the tool returned and one it did not.
    const model = async (params: { system?: unknown; messages: { role: string; content: unknown }[] }) => {
      seen.push(JSON.stringify(params.system));
      const last = params.messages[params.messages.length - 1];
      if (typeof last.content === "string") {
        return { content: [{ type: "tool_use", id: "toolu_de_1", name: "check_availability", input: { date: day, time: "19:00", party_size: 2 } }] };
      }
      offered = [...new Set(JSON.stringify(last.content).match(/\b\d{2}:\d{2}\b/g) ?? [])];
      return { content: [{ type: "text", text: `Gern! Ich hätte ${offered[0]} Uhr oder 23:55 Uhr für Sie frei. Welche Uhrzeit passt Ihnen?` }] };
    };

    const call = { ...startCall(venue, "webchat", "Setup check"), isTest: true };
    const run = await converse(venue, call, "Haben Sie morgen Abend einen Tisch für zwei um 19 Uhr?", model as never);

    assert.match(seen[0], /# Language: German/, "the model was not told to answer in German");
    assert.equal(run.traces[0]?.name, "check_availability");
    assert.ok(offered.length > 0, "the tool returned no times");
    assert.match(run.reply, /^Gern!/);

    // What respond.ts does with a reply before it is sent.
    const verdict = checkTimes(run.reply, run.traces, publishedTimes(venue), new Set(timesIn("um 19 Uhr", "de")), "de");
    assert.equal(verdict.ok, false, "23:55 was not caught");
    assert.deepEqual(verdict.invented, [23 * 60 + 55]);
    const sent = inHouseSpelling(venue, repairReply(run.reply, verdict, { language: "de" }));
    assert.doesNotMatch(sent, /23:55/);
    assert.match(sent, /Frei ist .*Uhr/);
    assert.match(sent, /Passt Ihnen davon etwas\?$/);
  });
});

fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });

console.log(
  failed === 0 ? `\n\x1b[32m✓ ${passed} passed, 0 failed\x1b[0m\n` : `\n\x1b[31m✗ ${passed} passed, ${failed} failed\x1b[0m\n`,
);
if (failed > 0) process.exitCode = 1;

// ---------------------------------------------------------------------------

/** A dinner for two at half past seven on Thursday 17 June 2027: far enough off never to be "today" or "tomorrow". */
function restaurantBooking(location: Location) {
  return {
    id: "bk_german",
    ref: "R7K2",
    locationId: location.id,
    vertical: "restaurant",
    date: "2027-06-17",
    startMin: 19 * 60 + 30,
    endMin: 21 * 60,
    partySize: 2,
    guestName: "Lena Weber",
    guestPhone: "+491701234567",
    status: "confirmed",
    createdAt: "2026-09-01T08:00:00.000Z",
  } as never as Parameters<typeof reminderMessage>[1];
}
