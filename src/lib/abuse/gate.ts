import type { Location, User } from "../types";
import { needsEmailVerification, verifyMode } from "../email-verify";
import { screenTrial, trialSuspended, type AbuseRefusal } from "./review";

/**
 * The one check in front of everything that costs Belline money before a
 * business pays: reading a website or documents with a model, Belle, the test
 * console, the automatic checks, voice previews and a Belline number.
 *
 * Refused, in this order, while:
 *
 *   the signed-in owner has not confirmed their email (email-verify.ts)
 *   staff have suspended the account's trial (abuse review)
 *   the business already has another account's trial or plan, by the website
 *   or phone about to be used (abuse/review.ts) — only where one is given
 *
 * Every refusal names the page that fixes it. Accounts that predate signup
 * screening pass untouched.
 */

export const VERIFY_PAGE = "/verify";

export function verifyRefusal(user: Pick<User, "emailVerification" | "emailVerifiedAt"> | null | undefined): AbuseRefusal | null {
  if (!needsEmailVerification(user)) return null;
  return {
    status: 403,
    code: "email_unverified",
    fix: VERIFY_PAGE,
    error:
      verifyMode() === "email"
        ? "Confirm your email address first: enter the 6-digit code we emailed you. Setting up by hand works in the meantime."
        : "Your email address is being confirmed by the Belline team. Setting up by hand works in the meantime.",
  };
}

export function paidWorkRefusal(
  user: Pick<User, "emailVerification" | "emailVerifiedAt"> | null | undefined,
  location: Location | undefined,
  opts: { stage?: string; website?: string; phone?: string } = {},
): AbuseRefusal | null {
  const unverified = verifyRefusal(user);
  if (unverified) return unverified;
  if (location && trialSuspended(location.tenantId) && location.subscription?.status === "trialing") {
    return {
      status: 403,
      code: "trial_suspended",
      fix: "/account-exists?why=paused",
      error: "The free trial on this account is paused. Contact us and we'll sort it out.",
    };
  }
  if (location && (opts.website || opts.phone)) {
    return screenTrial(location, opts.stage ?? "setup", { website: opts.website, phone: opts.phone });
  }
  return null;
}
