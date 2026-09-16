import { flag } from "../flags";

/**
 * How to forward a UAE line to Belline, per carrier.
 *
 * The same data renders on the Go live page and is what the setup assistant
 * reads, so the two cannot disagree. UAE first; other countries are added
 * here as rows when their markets open.
 *
 * What is stated is what is safe to state. du, e& and Virgin Mobile run GSM
 * mobile networks, so the standard conditional-forwarding codes apply on their
 * mobile lines. Landlines and office phone systems are set up by the provider
 * or whoever runs the system — so for those this says who to call, rather
 * than printing a code that may do nothing.
 *
 * Never a placeholder. Until the venue has a Belline number there are no codes
 * at all, and the page says the number is being prepared: a code with
 * "<your Belline number>" in it gets dialled exactly as printed.
 */

export interface ForwardingCode {
  mode: "noanswer" | "busy" | "unreachable" | "off";
  when: string;
  /**
   * What dialling it does, in plain words. "**61*" means nothing to an owner,
   * and an unexplained code reads as something Belline has already switched on.
   */
  meaning: string;
  dial: string;
  /** The same code as a link a phone dials when tapped. `#` has to be escaped in a URI. */
  tel: string;
}

export interface Carrier {
  id: "du" | "eand" | "virgin";
  name: string;
  /**
   * Codes confirmed by a real test call on this carrier (checklist 5.5). None
   * are yet, so every row says "should work" and the verification call is
   * what proves it for the owner's own line.
   */
  verified: boolean;
  mobile: ForwardingCode[];
  /** Null for a carrier with no landlines. */
  landline: string | null;
}

export const UNVERIFIED_NOTE = "These codes should work. The test call below confirms it on your line.";

/**
 * Said wherever codes appear: what they are, who dials them, and that nothing
 * is switched on until the owner does.
 */
export const CODES_EXPLAINED =
  "These are standard phone codes, not something Belline switches on. You dial them yourself on your own mobile, like a phone number, and nothing is forwarded until you do. **61* forwards the calls you do not answer, **67* forwards calls when you are busy on another call, and **62* forwards calls when your phone is off or has no signal. ##004# switches all of them off again.";

/** The phone is one way in, not a requirement: the website chat alone is enough to go live. */
export const PHONE_OPTIONAL =
  "The phone is optional. Belline can go live on the chat on your website alone, and you can forward your calls any time later.";

/** The digits and plus of a number, or "" when there is no usable number. */
export function dialTarget(number: string): string {
  const to = number.replace(/[^\d+]/g, "");
  return /^\+?\d{8,15}$/.test(to) ? to : "";
}

export function telLink(dial: string): string {
  return `tel:${dial.replace(/#/g, "%23")}`;
}

/** The codes for a real number. Empty when there is none: never a placeholder. */
export function forwardingCodes(target: string): ForwardingCode[] {
  const to = dialTarget(target);
  if (!to) return [];
  const row = (mode: ForwardingCode["mode"], when: string, meaning: string, dial: string): ForwardingCode => ({ mode, when, meaning, dial, tel: telLink(dial) });
  return [
    row("noanswer", "Nobody answers", "Calls you do not pick up go to Belline.", `**61*${to}#`),
    row("busy", "The line is busy", "Calls that arrive while you are on another call go to Belline.", `**67*${to}#`),
    row("unreachable", "The phone is off or out of signal", "Calls go to Belline while your phone is off or has no signal.", `**62*${to}#`),
    row("off", "Switch all forwarding off again", "Your phone rings as it did before. Nothing goes to Belline.", "##004#"),
  ];
}

export function uaeCarriers(target: string, opts: { virgin?: boolean } = {}): Carrier[] {
  const codes = forwardingCodes(target);
  const virgin = opts.virgin ?? flag("forwarding.carrier.virgin");
  return [
    {
      id: "du",
      name: "du",
      verified: false,
      mobile: codes,
      landline:
        "For a du landline or business line, call du on 155 and ask for conditional call forwarding — on no answer and on busy — to your Belline number.",
    },
    {
      id: "eand",
      name: "e& (Etisalat)",
      verified: false,
      mobile: codes,
      landline:
        "For an e& landline or business line, call e& on 101 and ask for conditional call forwarding — on no answer and on busy — to your Belline number.",
    },
    // Virgin Mobile runs on du's network and should take the same codes, but
    // nobody has dialled them on a Virgin SIM yet, so the row waits for its flag.
    ...(virgin
      ? [{ id: "virgin", name: "Virgin Mobile", verified: false, mobile: codes, landline: null } satisfies Carrier]
      : []),
  ];
}

export const PBX_NOTE =
  "An office phone system (PBX) forwards from its own settings. Ask whoever maintains it to forward unanswered and busy calls to your Belline number.";

/**
 * What to check when the test call never arrived, most likely first. The page
 * and Belle show the same list.
 */
export const DIAGNOSIS: { cause: string; check: string }[] = [
  {
    cause: "The code did not take",
    check: "Dial the code again from the phone whose calls you want covered. Your phone should show a message saying forwarding is on.",
  },
  {
    cause: "It is a landline or business line",
    check: "Codes only work on mobiles. Call du on 155 or e& on 101 and ask for conditional call forwarding to your Belline number.",
  },
  {
    cause: "An office phone system answers first",
    check: PBX_NOTE,
  },
  {
    cause: "The test call was answered, or came from the same phone",
    check: "Ring from a different phone and let it ring out without anyone picking up.",
  },
];
