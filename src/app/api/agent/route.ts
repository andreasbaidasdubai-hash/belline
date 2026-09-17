import { NextResponse } from "next/server";
import { getLocation, upsertLocation } from "@/lib/store";
import { canEditAgent } from "@/lib/auth";
import { requireApiUser } from "@/lib/auth-server";
import type { AgentConfig } from "@/lib/types";
import { publish } from "@/lib/brain";
import { requireE164 } from "@/lib/phone";
import { checkTransferNumber, venueMarket } from "@/lib/onboarding/rules";
import { languageChoiceOpen, languageUsable, parseLanguage, savedLanguages } from "@/lib/language";

export const dynamic = "force-dynamic";

/**
 * Agent configuration.
 *
 * Everything a venue can change about how the agent behaves lives in this
 * object — no redeploy, no prompt engineering by the operator. The next call
 * picks up the change because the system prompt is rebuilt per call.
 */
export async function PATCH(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json()) as {
    locationId?: string;
    agent?: Partial<AgentConfig>;
    /** The main language, from before the languages panel. Only a language selectable on this deployment. */
    language?: unknown;
    /** One line on what changed, kept with the version in the history. */
    note?: string;
  };

  const location = body.locationId ? getLocation(body.locationId) : undefined;
  if (!location) {
    return NextResponse.json({ error: "Unknown location" }, { status: 404 });
  }
  if (!canEditAgent(auth.user, location.id)) {
    return NextResponse.json(
      { error: "You cannot change the agent at this venue." },
      { status: 403 },
    );
  }
  if (!body.agent) {
    return NextResponse.json({ error: "No agent payload" }, { status: 400 });
  }

  // A transfer number that changed is stored E.164, in the venue's own country
  // (the toll-fraud rule on the rules step). One left as it was stays as it was,
  // so an older number saved before country codes were required keeps working.
  let transferNumber = location.agent.transferNumber;
  if (body.agent.transferNumber !== undefined && String(body.agent.transferNumber ?? "").trim() !== (location.agent.transferNumber ?? "").trim()) {
    const raw = String(body.agent.transferNumber ?? "").trim();
    if (raw) {
      const strict = requireE164(raw);
      if (!strict.ok) return NextResponse.json({ error: strict.reason, field: "transferNumber" }, { status: 422 });
      const local = checkTransferNumber(strict.e164, venueMarket(location));
      if (!local.ok) return NextResponse.json({ error: local.reason, field: "transferNumber" }, { status: 422 });
      transferNumber = local.e164;
    } else {
      transferNumber = "";
    }
  }

  const next: AgentConfig = {
    ...location.agent,
    ...body.agent,
    transferNumber,
    // Guard the numeric fields — a blank input arrives as NaN and a zero-second
    // call limit would hang up on every caller mid-greeting.
    maxCallSeconds:
      Number(body.agent.maxCallSeconds) > 0
        ? Number(body.agent.maxCallSeconds)
        : location.agent.maxCallSeconds,
    bookingHorizonDays:
      Number(body.agent.bookingHorizonDays) > 0
        ? Number(body.agent.bookingHorizonDays)
        : location.agent.bookingHorizonDays,
    policies: (body.agent.policies ?? location.agent.policies).filter((p) => p.trim()),
    faqs: (body.agent.faqs ?? location.agent.faqs).filter((f) => f.q.trim() && f.a.trim()),
  };

  // A language is a choice only where the flag offers one. Sent while it is
  // off, anything but English is refused rather than stored for later: a venue
  // that silently becomes German the day the flag is switched on is a surprise
  // for an owner who tried it once.
  let language = location.language;
  if (body.language !== undefined) {
    const chosen = parseLanguage(body.language);
    if (!chosen) return NextResponse.json({ error: "Choose a language from the list.", field: "language" }, { status: 422 });
    if (chosen !== "en" && (!languageChoiceOpen() || !languageUsable(chosen))) {
      return NextResponse.json({ error: "That language is not available yet.", field: "language" }, { status: 422 });
    }
    language = chosen;
  }
  const saved = savedLanguages(location);
  const languages =
    body.language !== undefined && language
      ? { ...saved, main: language, also: saved.also.filter((l) => l !== language) }
      : location.languages;

  upsertLocation({ ...location, agent: next, ...(language ? { language } : {}), ...(languages ? { languages } : {}) });

  // Record the change. Publishing after the save rather than instead of it
  // keeps the live venue as the single source of truth for the next call,
  // while the history answers who changed what, when, and why.
  const published = publish(
    location.id,
    { id: auth.user.id, name: auth.user.name },
    typeof body.note === "string" ? body.note : "Updated the agent",
  );

  return NextResponse.json({
    ok: true,
    agent: next,
    language: language ?? "en",
    version: published?.version.number,
    changed: published?.changed ?? false,
  });
}
