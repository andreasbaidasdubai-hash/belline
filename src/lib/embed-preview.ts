import { currentUser } from "./auth-server";
import { canEditAgent } from "./auth";
import { isActivated } from "./onboarding/journey";
import type { Location } from "./types";

/**
 * May the website widget open for whoever is asking?
 *
 * For everybody once the venue has gone live. Before that, only for somebody
 * signed in who can edit the venue, so an owner can preview it on Belline
 * while strangers on the website see nothing. The install ping (embed.js ->
 * /seen) is not gated: detecting the widget is one of the things Go live waits
 * for.
 */
export async function widgetOpenFor(location: Location): Promise<boolean> {
  if (isActivated(location)) return true;
  const user = await currentUser().catch(() => null);
  return Boolean(user && canEditAgent(user, location.id));
}
