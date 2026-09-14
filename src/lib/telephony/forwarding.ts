/**
 * How to forward a UAE line to Belline, per carrier.
 *
 * The same data renders on the Go live page and is what the setup assistant
 * would read, so the two cannot disagree. UAE first; other countries are added
 * here as rows when their markets open.
 *
 * What is stated is what is safe to state. du and e& run GSM mobile networks,
 * so the standard conditional-forwarding codes apply on their mobile lines.
 * Landlines and office phone systems are set up by the provider or whoever
 * runs the system — so for those this says who to call, rather than printing
 * a code that may do nothing.
 */

export interface ForwardingCode {
  when: string;
  dial: string;
}

export interface Carrier {
  id: "du" | "eand";
  name: string;
  mobile: ForwardingCode[];
  landline: string;
}

export function forwardingCodes(target: string): ForwardingCode[] {
  const to = target.replace(/[^\d+]/g, "") || "<your Belline number>";
  return [
    { when: "Nobody answers", dial: `**61*${to}#` },
    { when: "The line is busy", dial: `**67*${to}#` },
    { when: "The phone is off or out of signal", dial: `**62*${to}#` },
    { when: "Switch all forwarding off again", dial: "##004#" },
  ];
}

export function uaeCarriers(target: string): Carrier[] {
  const codes = forwardingCodes(target);
  return [
    {
      id: "du",
      name: "du",
      mobile: codes,
      landline:
        "For a du landline or business line, call du on 155 and ask for conditional call forwarding — on no answer and on busy — to your Belline number.",
    },
    {
      id: "eand",
      name: "e& (Etisalat)",
      mobile: codes,
      landline:
        "For an e& landline or business line, call e& on 101 and ask for conditional call forwarding — on no answer and on busy — to your Belline number.",
    },
  ];
}

export const PBX_NOTE =
  "An office phone system (PBX) forwards from its own settings. Ask whoever maintains it to forward unanswered and busy calls to your Belline number.";
