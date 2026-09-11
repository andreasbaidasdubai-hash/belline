import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * The old signup URL.
 *
 * Signup and checkout were two pages: a form with no price on it, and a price
 * behind a login that nobody ever saw. They are one page now — see
 * /checkout — and this stays so that links already in the wild, in an email
 * or on somebody's phone, still land somewhere useful.
 */
export default function StartPage() {
  redirect("/checkout");
}
