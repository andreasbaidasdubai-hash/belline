/**
 * Every line the system itself says or writes to a venue's customers.
 *
 * Not what the model says — that is the prompt's job, in whatever language the
 * venue answers in. These are the lines no model is asked for: the voicemail
 * greeting, "we can't reply here just now", the reminder text, the chat box's
 * placeholder, the page behind "Change or cancel". Each one is written here
 * once per language, and nothing customer-facing keeps its own copy, so a
 * German caller cannot reach an English sentence by a path nobody thought of.
 *
 * `check:german` reads this table: every key has both languages, the German
 * is not the English, and the two carry the same `{placeholders}`. Adding an
 * English line without its German fails that check and the type check both.
 *
 * Pure data and one pure function, with no imports: the chat box and the
 * booking page are browser components and read it directly. The venue's
 * language is decided in language.ts `answersIn`, never here.
 *
 * The English is byte-for-byte what these places said before the table
 * existed. Change it here and it changes everywhere, deliberately.
 */

export type CopyLanguage = "en" | "de";

/** The languages an owner can choose from, as the agent page lists them. */
export const LANGUAGES: readonly { id: CopyLanguage; label: string }[] = [
  { id: "en", label: "English" },
  { id: "de", label: "German (Deutsch)" },
];

interface Line {
  en: string;
  de: string;
}

export const CUSTOMER_COPY = {
  // --- The telephone -------------------------------------------------------
  "phone.not_answering": {
    en: "Thank you for calling {name}. Nobody is able to take your call just now. Please try again a little later.",
    de: "Vielen Dank für Ihren Anruf bei {name}. Leider kann gerade niemand Ihren Anruf entgegennehmen. Bitte versuchen Sie es etwas später noch einmal.",
  },
  "phone.not_answering_short": {
    en: "Nobody is able to take your call just now.",
    de: "Leider kann gerade niemand Ihren Anruf entgegennehmen.",
  },
  "voicemail.greeting": {
    en: "Thanks for calling {name}. Please leave your name and number after the tone, and the team will call you back.",
    de: "Vielen Dank für Ihren Anruf bei {name}. Bitte hinterlassen Sie nach dem Signalton Ihren Namen und Ihre Telefonnummer, dann rufen wir Sie zurück.",
  },
  "voicemail.thanks": {
    en: "Thank you. The team will call you back.",
    de: "Vielen Dank. Wir rufen Sie zurück.",
  },
  "transfer.no_answer": {
    en: "I'm sorry, nobody could get to the phone just now. The team has your number and what you told me, and they will call you back as soon as they can.",
    de: "Es tut mir leid, gerade konnte niemand ans Telefon gehen. Das Team hat Ihre Nummer und Ihr Anliegen und ruft Sie so bald wie möglich zurück.",
  },
  "transfer.failed": {
    en: "I'm sorry, I couldn't put you through just now. The team has your number and what you told me, and they'll call you back.",
    de: "Es tut mir leid, ich konnte Sie gerade nicht durchstellen. Das Team hat Ihre Nummer und Ihr Anliegen und ruft Sie zurück.",
  },
  /** What a caller hears while the answer is being worked out. See voice/session.ts ACKNOWLEDGEMENTS. */
  "voice.ack.0": { en: "Sure.", de: "Gerne." },
  "voice.ack.1": { en: "Okay.", de: "Alles klar." },
  "voice.ack.2": { en: "Right.", de: "Genau." },
  "voice.ack.3": { en: "Let me see.", de: "Einen Moment." },
  "agent.refusal": {
    en: "I'm sorry, I can't help with that one. Let me take a message for the team.",
    de: "Dabei kann ich Ihnen leider nicht helfen. Ich nehme gern eine Nachricht für das Team auf.",
  },
  "agent.dropped": {
    en: "I'm sorry, our system just dropped out. Let me take your number and the team will ring you back.",
    de: "Entschuldigung, unser System ist gerade kurz ausgefallen. Ich notiere gern Ihre Nummer, und das Team ruft Sie zurück.",
  },
  /** The opening line every new venue starts with (onboarding/index.ts). */
  "greeting.default": {
    en: "Thank you for calling {name}, this is Belline. How can I help?",
    de: "Guten Tag, Sie sind verbunden mit {name}, hier spricht Belline. Wie kann ich Ihnen helfen?",
  },

  // --- Website, chat and WhatsApp -----------------------------------------
  "web_voice.not_answering": {
    en: "Nobody can take a call through the website just now. Please try again a little later.",
    de: "Über die Website kann gerade niemand Ihren Anruf entgegennehmen. Bitte versuchen Sie es etwas später noch einmal.",
  },
  "messages.not_answering_ring": {
    en: "We can't reply here just now. Please ring us on {phone}.",
    de: "Wir können hier gerade nicht antworten. Bitte rufen Sie uns unter {phone} an.",
  },
  "messages.not_answering": {
    en: "We can't reply here just now. Please try again a little later.",
    de: "Wir können hier gerade nicht antworten. Bitte versuchen Sie es etwas später noch einmal.",
  },
  "webchat.busy": {
    en: "We've had a lot of messages through the website today. Please ring us instead — we'd rather not keep you waiting.",
    de: "Heute sind sehr viele Nachrichten über die Website eingegangen. Bitte rufen Sie uns stattdessen an – wir möchten Sie nicht warten lassen.",
  },
  "webchat.ceiling_ring": {
    en: "I've taken this as far as I can here. Please give us a ring on {phone} and someone will pick it up from where we left off.",
    de: "Weiter komme ich hier leider nicht. Bitte rufen Sie uns unter {phone} an, dann macht jemand genau an dieser Stelle weiter.",
  },
  "webchat.ceiling": {
    en: "I've taken this as far as I can here. Please give us a ring and someone will pick it up from where we left off.",
    de: "Weiter komme ich hier leider nicht. Bitte rufen Sie uns an, dann macht jemand genau an dieser Stelle weiter.",
  },
  "embed.voice_off": {
    en: "Calling isn't switched on for this website. Send a message instead and we'll reply.",
    de: "Anrufe sind auf dieser Website nicht eingeschaltet. Schreiben Sie uns gern eine Nachricht, wir antworten Ihnen.",
  },
  "embed.voice_busy": {
    en: "We've had a lot of calls through the website today. Please ring us instead — we'd rather not keep you waiting.",
    de: "Heute sind sehr viele Anrufe über die Website eingegangen. Bitte rufen Sie uns stattdessen direkt an – wir möchten Sie nicht warten lassen.",
  },
  "embed.unavailable": { en: "Not available just now.", de: "Gerade nicht verfügbar." },
  /** The button on a venue's own website, where the owner has not written their own. */
  "embed.voice_label": { en: "Talk to us", de: "Mit uns sprechen" },
  "embed.chat_label": { en: "Chat with us", de: "Chat mit uns" },
  "embed.whatsapp_label": { en: "WhatsApp us", de: "Per WhatsApp schreiben" },
  "embed.not_switched_on": { en: "{name} has not switched this on yet.", de: "{name} hat das noch nicht eingeschaltet." },
  "embed.chat_off": { en: "Chat isn't switched on for this website yet.", de: "Der Chat ist für diese Website noch nicht eingeschaltet." },
  "embed.wrong_site": {
    en: "This page can only be opened from the website it belongs to.",
    de: "Diese Seite lässt sich nur über die Website öffnen, zu der sie gehört.",
  },
  "chatlink.not_live": {
    en: "This chat isn't available yet. Please check back soon.",
    de: "Dieser Chat ist noch nicht verfügbar. Bitte schauen Sie bald wieder vorbei.",
  },
  "chatlink.unavailable": {
    en: "Not available just now. Please try again later.",
    de: "Gerade nicht verfügbar. Bitte versuchen Sie es später noch einmal.",
  },
  "messages.voice_note": {
    en: "I can't listen to voice notes just yet — could you type it instead?",
    de: "Sprachnachrichten kann ich leider noch nicht anhören – könnten Sie mir Ihr Anliegen schreiben?",
  },
  "messages.attachment": {
    en: "I can't open that here. Could you tell me in a message what you need?",
    de: "Das kann ich hier leider nicht öffnen. Könnten Sie mir in einer Nachricht schreiben, worum es geht?",
  },
  "messages.handed_over_unanswered": {
    en: "Handed to the team: the agent could not answer",
    de: "An das Team übergeben – jemand aus dem Team meldet sich bei Ihnen.",
  },

  // --- The chat box (embed/[key]/chat/Chat.tsx) ---------------------------
  "chat.timed_out": {
    en: "This conversation timed out. Reload the page to start again.",
    de: "Diese Unterhaltung ist abgelaufen. Laden Sie die Seite neu, um neu zu beginnen.",
  },
  "chat.send_failed": {
    en: "That didn't send. Try again in a moment.",
    de: "Das wurde nicht gesendet. Bitte versuchen Sie es gleich noch einmal.",
  },
  "chat.mic_unavailable": {
    en: "The microphone isn't available here — you can type instead.",
    de: "Das Mikrofon ist hier nicht verfügbar – Sie können stattdessen schreiben.",
  },
  "chat.hold_to_record": {
    en: "Hold the microphone to record a voice note.",
    de: "Halten Sie das Mikrofon gedrückt, um eine Sprachnachricht aufzunehmen.",
  },
  "chat.note_too_long": {
    en: "That note was too long to send. Keep it under a minute, or type it.",
    de: "Die Sprachnachricht war zu lang. Bitte bleiben Sie unter einer Minute, oder schreiben Sie es.",
  },
  "chat.note_unclear": {
    en: "I couldn't make that out — try again a little closer to the microphone, or type it.",
    de: "Das konnte ich nicht verstehen – versuchen Sie es etwas näher am Mikrofon, oder schreiben Sie es.",
  },
  "chat.note_failed": {
    en: "I couldn't hear that just now. Could you type it instead?",
    de: "Das konnte ich gerade nicht hören. Könnten Sie es stattdessen schreiben?",
  },
  "chat.with_team": { en: "You're talking to the team", de: "Sie schreiben mit dem Team" },
  "chat.passing": { en: "Passing you to the team", de: "Sie werden an das Team weitergegeben" },
  "chat.replies": { en: "{agent} · replies in seconds", de: "{agent} · antwortet in Sekunden" },
  "chat.rather_talk": { en: "Rather talk?", de: "Lieber sprechen?" },
  "chat.opener": {
    en: "Hi — I'm {agent} at {venue}. Ask me anything, or tell me what you'd like to book.",
    de: "Guten Tag – ich bin {agent} von {venue}. Fragen Sie mich gern, oder sagen Sie mir, was Sie buchen möchten.",
  },
  "chat.note_listening": { en: "Voice note · listening…", de: "Sprachnachricht · hört zu…" },
  "chat.note_time": { en: "Voice note · {time}", de: "Sprachnachricht · {time}" },
  "chat.typing": { en: "typing", de: "schreibt" },
  "chat.team_joining": {
    en: "Someone from the team is picking this up. Anything you add here will reach them.",
    de: "Jemand aus dem Team übernimmt jetzt. Alles, was Sie hier noch schreiben, kommt dort an.",
  },
  "chat.release_to_send": { en: "Release to send · slide off to cancel", de: "Loslassen zum Senden · wegziehen zum Abbrechen" },
  "chat.placeholder": { en: "Type your message", de: "Ihre Nachricht" },
  "chat.message_label": { en: "Your message", de: "Nachricht eingeben" },
  "chat.recording_label": { en: "Recording — release to send", de: "Aufnahme – zum Senden loslassen" },
  "chat.hold_label": { en: "Hold to record a voice note", de: "Gedrückt halten für eine Sprachnachricht" },
  "chat.send": { en: "Send", de: "Senden" },

  // --- The call button on a venue's website (test/Console.tsx, minimal) ---
  // The English stays inline in Console.tsx, which is also the owner's own
  // test console; these English values are what it says, for the record.
  "call.audio_blocked": {
    en: "Your browser blocked audio. Click anywhere on the page, then start the call again.",
    de: "Ihr Browser hat den Ton blockiert. Klicken Sie irgendwo auf die Seite und starten Sie den Anruf erneut.",
  },
  "call.voice_unavailable": {
    en: "Belline's voice isn't available right now. Please try again later, or write to Belle on the website.",
    de: "Die Stimme ist gerade nicht verfügbar. Bitte versuchen Sie es später noch einmal oder schreiben Sie uns eine Nachricht.",
  },
  "call.cant_hear": {
    en: "Belline can't hear you right now. Please try again in a moment.",
    de: "Wir können Sie gerade nicht hören. Bitte versuchen Sie es gleich noch einmal.",
  },
  "call.went_wrong": {
    en: "Something went wrong on our side. Please try again in a moment.",
    de: "Bei uns ist etwas schiefgelaufen. Bitte versuchen Sie es gleich noch einmal.",
  },
  "call.connection_failed": { en: "Connection failed.", de: "Die Verbindung ist fehlgeschlagen." },
  "call.unreachable": {
    en: "We could not reach Belline just now. Try again in a moment.",
    de: "Der Anruf konnte gerade nicht verbunden werden. Bitte versuchen Sie es gleich noch einmal.",
  },
  "call.not_taking": { en: "This line is not taking calls.", de: "Über diese Leitung sind gerade keine Anrufe möglich." },
  "call.idle": { en: "Ask it anything, or book a call with us", de: "Fragen Sie einfach, oder buchen Sie einen Termin" },
  "call.connecting": { en: "Connecting…", de: "Verbindung wird hergestellt…" },
  "call.tap_for_sound": { en: "Tap to turn sound on", de: "Tippen, um den Ton einzuschalten" },
  "call.speaking": { en: "Belline is speaking", de: "Belline spricht" },
  "call.listening": { en: "Listening — go ahead", de: "Ich höre zu – bitte sprechen Sie" },
  "call.mic_off": { en: "Microphone off", de: "Mikrofon aus" },
  "call.start": { en: "Talk to Belline", de: "Mit Belline sprechen" },
  "call.sound_on": { en: "Turn on sound", de: "Ton einschalten" },
  "call.end_label": { en: "End the call", de: "Anruf beenden" },
  "call.end": { en: "End", de: "Beenden" },
  "call.rather_type": { en: "Rather type? Send a message", de: "Lieber schreiben? Nachricht senden" },
  "call.choose_day": { en: "Choose a day", de: "Tag auswählen" },
  "call.free": { en: "{n} free", de: "{n} frei" },
  "call.today": { en: "Today", de: "Heute" },
  "call.tomorrow": { en: "Tomorrow", de: "Morgen" },
  "call.slot_with": { en: "with {who}", de: "bei {who}" },
  "call.slot_on": { en: "on {day}", de: "am {day}" },
  "call.slot_please": { en: "{choice}, please.", de: "{choice}, bitte." },

  // --- The honesty guards (agent/honesty.ts) ------------------------------
  "guard.request_handover": {
    en: "Your request is with the team, and they'll get back to you to confirm.",
    de: "Ihre Anfrage liegt beim Team, und man meldet sich zur Bestätigung bei Ihnen.",
  },
  "guard.request_no_slot": {
    en: "I can't hold a time here, but tell me when suits you and I'll pass it to the team to confirm.",
    de: "Eine Uhrzeit kann ich hier nicht fest zusagen, aber sagen Sie mir gern, wann es Ihnen passt – ich gebe es zur Bestätigung an das Team weiter.",
  },
  "guard.nothing_free": {
    en: "I haven't got anything free there, I'm afraid. Would you like me to look at another day?",
    de: "Da ist leider nichts frei. Soll ich an einem anderen Tag für Sie nachsehen?",
  },
  "guard.actually_free": {
    en: "Sorry — let me be accurate about that. What I actually have is {times}. Would any of those work?",
    de: "Entschuldigung – damit es stimmt: Frei ist {times}. Passt Ihnen davon etwas?",
  },
  "guard.or": { en: "{rest} or {last}", de: "{rest} oder {last}" },
  "guard.which_day": {
    en: "I'll tell you exactly what's free — which day would suit you?",
    de: "Ich sage Ihnen gern genau, was frei ist – welcher Tag würde Ihnen passen?",
  },

  // --- The authority rules (agent/authority.ts) ---------------------------
  "authority.emergency": {
    en: "That needs proper medical attention now, not an appointment. Please call 998 for an ambulance, or go to the nearest emergency department. I'm not the right place for this.",
    // 112 reaches emergency services in Germany, Austria and Switzerland alike.
    de: "Das braucht jetzt sofort ärztliche Hilfe, keinen Termin. Bitte rufen Sie den Notruf 112 an oder gehen Sie in die nächste Notaufnahme. Hier sind Sie dafür leider nicht richtig.",
  },
  "authority.clinical": {
    en: "I'm not able to advise on that, and I'm not going to guess at it. Let me take your number and exactly what you've told me — the clinical team will ring you back, and I'm marking it urgent.",
    de: "Dazu kann ich Sie nicht beraten, und ich möchte auch nicht raten. Ich notiere Ihre Nummer und genau das, was Sie mir gesagt haben – das Praxisteam ruft Sie zurück, und ich markiere es als dringend.",
  },
  "authority.reaction": {
    en: "That needs someone to look at it properly, not me. I'm putting you through to the team now.",
    de: "Das sollte sich jemand genau ansehen, nicht ich. Ich verbinde Sie jetzt mit dem Team.",
  },
  "authority.reaction_no_transfer": {
    en: "That needs someone to look at it properly, not me. Let me take your number and exactly what happened — the team will ring you back, and I'm marking it urgent.",
    de: "Das sollte sich jemand genau ansehen, nicht ich. Ich notiere Ihre Nummer und genau, was passiert ist – das Team ruft Sie zurück, und ich markiere es als dringend.",
  },

  // --- Bookings: texts, email, calendar file, the manage page -------------
  "booking.when": { en: "{date} at {time}", de: "{date} um {time}" },
  "booking.table": { en: "table for {n}", de: "Tisch für {n}" },
  "booking.table_title": { en: "Table for {n}", de: "Tisch für {n}" },
  "booking.appointment": { en: "appointment", de: "Termin" },
  "booking.appointment_title": { en: "Appointment", de: "Termin" },
  "booking.confirmation_text": {
    en: "{name}: {what} confirmed for {when}. Reference {ref}. Change or cancel: {link}",
    de: "{name}: {what} bestätigt für {when}. Referenz {ref}. Ändern oder stornieren: {link}",
  },
  "booking.reminder_text": {
    en: "{name}: a reminder of your {what} {when}. Reference {ref}.{change}{deposit}",
    de: "{name}: Erinnerung an Ihre Buchung – {what}, {when}. Referenz {ref}.{change}{deposit}",
  },
  "booking.reminder_change": { en: " To change or cancel, call {phone}.", de: " Zum Ändern oder Stornieren rufen Sie bitte {phone} an." },
  "booking.reminder_deposit": {
    en: " The {currency} {amount} deposit is still open: {link}",
    de: " Die Anzahlung von {currency} {amount} ist noch offen: {link}",
  },
  "booking.deposit_text": {
    en: "{name}: to hold booking {ref}, please pay the {currency} {amount} deposit here: {link}",
    de: "{name}: Damit wir Ihre Buchung {ref} halten können, zahlen Sie bitte die Anzahlung von {currency} {amount} hier: {link}",
  },
  "booking.deposit_item": { en: "Deposit — {name}", de: "Anzahlung – {name}" },
  "booking.deposit_item_detail": { en: "Booking {ref}", de: "Buchung {ref}" },
  "booking.label_what": { en: "What", de: "Was" },
  "booking.label_with": { en: "With", de: "Bei" },
  "booking.label_when": { en: "When", de: "Wann" },
  "booking.label_where": { en: "Where", de: "Wo" },
  "booking.label_reference": { en: "Reference", de: "Referenz" },
  "booking.cancelled_already": { en: "This booking has been cancelled.", de: "Diese Buchung wurde storniert." },
  "booking.taken_place": { en: "This booking has already taken place.", de: "Dieser Termin hat bereits stattgefunden." },
  "booking.started": { en: "This booking has already started.", de: "Dieser Termin hat bereits begonnen." },
  "booking.ics_description": {
    en: "Reference {ref}{with}. Change or cancel: {link}",
    de: "Referenz {ref}{with}. Ändern oder stornieren: {link}",
  },
  "booking.ics_with": { en: " with {who}", de: " bei {who}" },
  "booking.email_confirmed": { en: "Your booking is confirmed", de: "Ihre Buchung ist bestätigt" },
  "booking.email_changed": { en: "Your booking has changed", de: "Ihre Buchung wurde geändert" },
  "booking.email_cancelled": { en: "Your booking is cancelled", de: "Ihre Buchung ist storniert" },
  "booking.subject_confirmed": { en: "Confirmed: {what}, {when} — {name}", de: "Bestätigt: {what}, {when} – {name}" },
  "booking.subject_changed": { en: "Changed: {what}, {when} — {name}", de: "Geändert: {what}, {when} – {name}" },
  "booking.subject_cancelled": { en: "Cancelled: {what}, {when} — {name}", de: "Storniert: {what}, {when} – {name}" },
  "booking.deposit_due_email": {
    en: "A {currency} {amount} deposit is due on this booking.{pay}",
    de: "Für diese Buchung ist eine Anzahlung von {currency} {amount} fällig.{pay}",
  },
  "booking.deposit_pay_here": { en: " Pay it here: {link}", de: " Hier bezahlen: {link}" },
  "booking.change_or_cancel_link": { en: "Change or cancel: {link}", de: "Ändern oder stornieren: {link}" },
  "booking.add_to_calendar_link": { en: "Add to your calendar: {link}", de: "In Ihren Kalender eintragen: {link}" },
  "booking.questions": { en: "Questions? Call {name} on {phone}.", de: "Fragen? Rufen Sie {name} unter {phone} an." },
  "booking.change_or_cancel": { en: "Change or cancel", de: "Ändern oder stornieren" },
  "booking.add_to_calendar": { en: "Add to calendar", de: "Zum Kalender hinzufügen" },
  "booking.sent_by": { en: "Sent for {name} by Belline.", de: "Im Auftrag von {name} versendet von Belline." },
  "booking.late_cancel_fee": {
    en: "That is inside our {hours}-hour cancellation window, so a {currency} {fee} charge may apply. I have cancelled it and noted the time you called.",
    de: "Das liegt innerhalb unserer Stornierungsfrist von {hours} Stunden, daher kann eine Gebühr von {currency} {fee} anfallen. Die Buchung ist storniert, und der Zeitpunkt ist vermerkt.",
  },
  "booking.late_cancel": {
    en: "That is inside our {hours}-hour cancellation window. I have cancelled it and let the team know.",
    de: "Das liegt innerhalb unserer Stornierungsfrist von {hours} Stunden. Die Buchung ist storniert, und das Team ist informiert.",
  },
  "manage.page_title": { en: "Your booking", de: "Ihre Buchung" },
  "manage.bad_link": { en: "This link does not work.", de: "Dieser Link funktioniert nicht." },
  "manage.bad_link_help": {
    en: "Check you opened the whole link from your confirmation, or call the venue.",
    de: "Bitte prüfen Sie, ob Sie den vollständigen Link aus Ihrer Bestätigung geöffnet haben, oder rufen Sie uns an.",
  },
  "manage.is_cancelled": { en: "This booking is cancelled.", de: "Diese Buchung ist storniert." },
  "manage.heading": { en: "Your booking", de: "Ihre Buchung" },
  "manage.deposit_due": { en: "A {currency} {amount} deposit is due.", de: "Eine Anzahlung von {currency} {amount} ist fällig." },
  "manage.pay_now": { en: "Pay it now", de: "Jetzt bezahlen" },
  "manage.anything_else": { en: "For anything else, call {name} on {phone}.", de: "Für alles Weitere rufen Sie {name} unter {phone} an." },
  "manage.didnt_work": { en: "That didn't work.", de: "Das hat nicht geklappt." },
  "manage.moved": {
    en: "Moved to {day} at {time}. A new confirmation is on its way.",
    de: "Verschoben auf {day} um {time}. Eine neue Bestätigung ist unterwegs.",
  },
  "manage.cancelled": { en: "Cancelled.{notice}", de: "Storniert.{notice}" },
  "manage.change_time": { en: "Change time", de: "Uhrzeit ändern" },
  "manage.cancel_booking": { en: "Cancel booking", de: "Buchung stornieren" },
  "manage.pick_time": {
    en: "Pick a new time. Your current one stays until you do.",
    de: "Wählen Sie eine neue Uhrzeit. Ihr bisheriger Termin bleibt bestehen, bis Sie das tun.",
  },
  "manage.finding": { en: "Finding free times…", de: "Freie Zeiten werden gesucht…" },
  "manage.nothing_free": { en: "Nothing free in the next two weeks online.", de: "In den nächsten zwei Wochen ist online nichts frei." },
  "manage.call_us": { en: "Call {name} on {phone}.", de: "Rufen Sie {name} unter {phone} an." },
  "manage.keep_time": { en: "Keep my time", de: "Termin behalten" },
  "manage.confirm_cancel": { en: "Cancel this booking?", de: "Diese Buchung stornieren?" },
  "manage.cancelling": { en: "Cancelling…", de: "Wird storniert…" },
  "manage.yes_cancel": { en: "Yes, cancel it", de: "Ja, stornieren" },
  "manage.keep_it": { en: "Keep it", de: "Behalten" },
  "manage.link_invalid": { en: "This link is not valid.", de: "Dieser Link ist ungültig." },
  "manage.too_many": { en: "Too many attempts. Try again shortly.", de: "Zu viele Versuche. Bitte versuchen Sie es gleich noch einmal." },
  "manage.call_to_change": { en: "Please call {name} to change this booking.", de: "Bitte rufen Sie {name} an, um diese Buchung zu ändern." },
  "manage.choose_time": { en: "Choose a new time.", de: "Bitte wählen Sie eine neue Uhrzeit." },
  "manage.no_longer_free": { en: "That time is no longer free.", de: "Diese Uhrzeit ist nicht mehr frei." },
  "manage.unknown_action": { en: "Unknown action.", de: "Unbekannte Aktion." },
} satisfies Record<string, Line>;

export type CopyKey = keyof typeof CUSTOMER_COPY;

/**
 * The lines each browser component is handed. Kept here, not beside the
 * components: a value exported from a "use client" file reaches a server
 * component as a reference, not as the array.
 */
export const MANAGE_KEYS = [
  "manage.didnt_work",
  "manage.moved",
  "manage.cancelled",
  "manage.change_time",
  "booking.add_to_calendar",
  "manage.cancel_booking",
  "manage.pick_time",
  "manage.finding",
  "manage.nothing_free",
  "manage.call_us",
  "manage.keep_time",
  "manage.confirm_cancel",
  "manage.cancelling",
  "manage.yes_cancel",
  "manage.keep_it",
] as const satisfies readonly CopyKey[];

export const CHAT_KEYS = [
  "chat.timed_out",
  "chat.send_failed",
  "chat.mic_unavailable",
  "chat.hold_to_record",
  "chat.note_too_long",
  "chat.note_unclear",
  "chat.note_failed",
  "chat.with_team",
  "chat.passing",
  "chat.replies",
  "chat.rather_talk",
  "chat.opener",
  "chat.note_listening",
  "chat.note_time",
  "chat.typing",
  "chat.team_joining",
  "chat.release_to_send",
  "chat.placeholder",
  "chat.message_label",
  "chat.recording_label",
  "chat.hold_label",
  "chat.send",
] as const satisfies readonly CopyKey[];

export const CALL_KEYS = [
  "call.audio_blocked",
  "call.voice_unavailable",
  "call.cant_hear",
  "call.went_wrong",
  "call.connection_failed",
  "call.unreachable",
  "call.idle",
  "call.connecting",
  "call.tap_for_sound",
  "call.speaking",
  "call.listening",
  "call.mic_off",
  "call.start",
  "call.sound_on",
  "call.end_label",
  "call.end",
  "call.rather_type",
  "call.choose_day",
  "call.free",
  "call.today",
  "call.tomorrow",
  "call.slot_with",
  "call.slot_on",
  "call.slot_please",
] as const satisfies readonly CopyKey[];

/** Fill a line a browser component was handed. The same single pass as `copy`. */
export function fill(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** The `{placeholders}` in a line, sorted — the table check compares them across languages. */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

/**
 * One line, in one language, with its blanks filled.
 *
 * A single pass, so a value that itself contains braces (an owner's greeting
 * with "{name}" in it) is inserted as written rather than filled again.
 */
export function copy(language: CopyLanguage, key: CopyKey, vars: Record<string, string | number> = {}): string {
  const line: Line = CUSTOMER_COPY[key];
  return fill(line[language] ?? line.en, vars);
}

/** A whole language's lines for the keys a browser component needs, so only those are sent. */
export function copyTable<K extends CopyKey>(language: CopyLanguage, keys: readonly K[]): Record<K, string> {
  return Object.fromEntries(keys.map((k) => [k, CUSTOMER_COPY[k][language]])) as Record<K, string>;
}
