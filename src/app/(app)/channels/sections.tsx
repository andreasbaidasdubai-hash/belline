import Link from "next/link";
import type { Location } from "@/lib/types";
import { getBusiness, listCalls } from "@/lib/store";
import { dateIn, todayIn } from "@/lib/time";
import { WEBCHAT_DEFAULTS } from "@/lib/webchat";
import { EMBED_DEFAULTS, embedSnippet, suggestedOrigins } from "@/lib/embed";
import { BUILDER_TABS } from "@/lib/onboarding/platform";
import { appOrigin } from "@/lib/origin";
import { venueWhatsApp, whatsappStatus } from "@/lib/whatsapp";
import { whatsappCard } from "@/lib/whatsapp-selfserve";
import { raiseException } from "@/lib/errors/customer";
import { openException } from "@/lib/exceptions";
import { ownerNotice } from "@/lib/billing/entitlement";
import { raisePacksHeldIfPaymentsClosed, raiseTrialCapIfPaymentsClosed } from "@/lib/billing/trial-end";
import { bellineNumberOf } from "@/lib/telephony/number";
import { flag } from "@/lib/flags";
import { CODES_EXPLAINED, DIAGNOSIS, PBX_NOTE, PHONE_OPTIONAL, UNVERIFIED_NOTE, forwardingCodes, uaeCarriers } from "@/lib/telephony/forwarding";
import { verificationState } from "@/lib/telephony/verify";
import { chatLinkUrl } from "@/lib/chat-link";
import { videoOffered, videoSettable } from "@/lib/video/availability";
import { VIDEO_VOICE_MINUTE_RATIO } from "@/lib/billing/plans";
import { isActivated } from "@/lib/onboarding/journey";
import { logoUrlFor } from "@/lib/logo";
import WidgetEditor from "../website/WidgetEditor";
import PhoneSetup from "../golive/PhoneSetup";
import WhatsAppCard from "../integrations/WhatsAppCard";
import ChatLinkCard from "./ChatLinkCard";

/**
 * The four ways in, each as one section that two places render.
 *
 * Setup used to link out to /website, /golive and /integrations with
 * ?from=setup and a "Back to setup" bar, so adding the chat to a website meant
 * leaving the step, finding a dashboard the owner had never seen, and finding
 * the way back. The founder's test said it plainly: it belongs in the step.
 *
 * So the section is the unit, not the page. The Channels screens and the setup
 * steps render the same section from the same saved venue: one implementation
 * of each flow, so the two can never disagree about what is connected.
 */

/** The website chat: what it offers, how it looks, where it may appear, the line to paste. */
export async function WebsiteSection({ location }: { location: Location }) {
  const embed = location.embed;
  const today = todayIn(location.timezone);
  const calls = listCalls(location.id).filter((c) => dateIn(c.startedAt, location.timezone) === today);
  // Counted here rather than taken from the gates, because the gates answer
  // "may another one start" and this answers "what has it done today".
  const used = {
    voice: calls.filter((c) => c.channel === "embed").length,
    chat: calls.filter((c) => c.channel === "webchat").length,
  };
  const whatsapp = await venueWhatsApp(location).catch(() => null);

  return (
    <WidgetEditor
      locationId={location.id}
      enabled={Boolean(embed?.enabled)}
      mode={embed?.mode ?? "both"}
      origins={suggestedOrigins(location, getBusiness(location.tenantId, location.businessId)?.website)}
      snippet={embed?.enabled ? embedSnippet(location, appOrigin()) : ""}
      builderTabs={BUILDER_TABS}
      used={used}
      limits={{
        voice: embed?.maxCallsPerDay ?? EMBED_DEFAULTS.maxCallsPerDay,
        chat: embed?.maxChatsPerDay ?? WEBCHAT_DEFAULTS.maxChatsPerDay,
      }}
      minutesCount={Boolean(location.subscription)}
      appearance={embed?.appearance ?? {}}
      whatsappNumber={whatsapp?.phoneE164 ?? null}
      detectedAt={location.onboarding?.channels.web?.detectedAt ?? null}
      logoUrl={logoUrlFor(location)}
      // Whether the spoken button is a face or a voice, asked the way the
      // widget itself asks it, so the screen cannot sell video where the
      // visitor would get a voice (founder, f6).
      video={videoOffered(location)}
      videoRatio={VIDEO_VOICE_MINUTE_RATIO}
      // "Where can I change the face of the Agent?" (founder, f6). It is on
      // Your business → Agent, and this is where somebody setting up the
      // website looks for it. The same condition that decides whether the
      // picker renders there ((app)/agents/page.tsx), not a near-enough one:
      // a link to a control that is not on the page is worse than no link.
      facePicker={videoSettable(location)}
      // The same chat, for the places that are not a website.
      chatLink={chatLinkUrl(location)}
      chatLinkLive={isActivated(location)}
    />
  );
}

/**
 * The phone: a Belline number, forwarding to it, and a test call that proves it.
 *
 * `skipHref` is where "Skip the phone for now" goes: the next setup step, or
 * the website chat on the Channels screen.
 */
export function PhoneSection({ location, skipHref }: { location: Location; skipHref: string }) {
  // Belline's number only, never the business's own phone saved on review.
  const number = bellineNumberOf(location);
  const dial = number.replace(/[^\d+]/g, "");
  const abroad = Boolean(dial) && !/^\+?971/.test(dial);
  const today = todayIn(location.timezone);
  raiseTrialCapIfPaymentsClosed(location, today);
  raisePacksHeldIfPaymentsClosed(location, today);
  const notice = ownerNotice(location, today);
  const poolOn = flag("numbers.pool");
  const verify = verificationState(location);

  // With the pool off, numbers are assigned by the Belline team. Said as it
  // is, and the team is told, instead of a mailto the owner has to remember to
  // send. With it on, the owner presses "Get my number" and the ticket is only
  // opened if the pool turns out to be empty.
  if (!number && !poolOn) {
    raiseException(`numbers:unassigned:${location.id}`, `venue ${location.id} opened the phone setup without a number`);
    // One open row per venue: opening this page again only counts it.
    openException({
      tenantId: location.tenantId,
      locationId: location.id,
      kind: "pool_empty",
      reason: "Opened the phone setup without a Belline number. Numbers are assigned by hand until the pool is switched on.",
      source: "system",
    });
  }

  return (
    <>
      {notice && (
        <div className="panel" style={{ padding: "15px 18px", marginBottom: 14, borderColor: "var(--bad)", background: "var(--bad-soft)" }}>
          <strong style={{ color: "var(--bad)", fontSize: 13.5 }}>{notice.sentence}</strong>{" "}
          {notice.choosePlan && (
            <Link href="/checkout" style={{ fontSize: 13 }}>
              Choose a plan
            </Link>
          )}
        </div>
      )}
      <div className="panel" style={{ padding: "16px 18px", fontSize: 13.5, lineHeight: 1.6, marginBottom: 14 }}>
        <PhoneSetup
          locationId={location.id}
          number={number}
          poolOn={poolOn}
          carriers={uaeCarriers(number).map((c) => ({ id: c.id, name: c.name, verified: c.verified, landline: c.landline }))}
          codes={forwardingCodes(number).map(({ when, meaning, dial: code, tel }) => ({ when, meaning, dial: code, tel }))}
          pbxNote={PBX_NOTE}
          diagnosis={DIAGNOSIS}
          unverifiedNote={UNVERIFIED_NOTE}
          codesExplained={CODES_EXPLAINED}
          phoneOptional={PHONE_OPTIONAL}
          skipHref={skipHref}
          verify={verify}
        />
        {abroad && (
          <p style={{ margin: "10px 0 0", color: "var(--warn)" }}>
            This number is outside the UAE. Your phone provider charges a forwarded call like a call you make to that country,
            so check their rate before you switch forwarding on.
          </p>
        )}
      </div>
    </>
  );
}

/** The chat link: a chat with Belline that needs no website. */
export function LinkSection({ location, live }: { location: Location; live: boolean }) {
  return (
    <section className="panel" style={{ marginBottom: 14 }} data-testid="channel-link">
      <div className="panel-head">Your chat link</div>
      <div style={{ padding: "16px 18px", fontSize: 13.5, lineHeight: 1.6 }}>
        <p style={{ margin: 0, maxWidth: "70ch" }}>
          A link that opens a chat with Belline, with no website needed: put it in your Instagram bio, your Google Business
          Profile or your WhatsApp status.
        </p>
        <ChatLinkCard locationId={location.id} url={chatLinkUrl(location)} live={live} />
      </div>
    </section>
  );
}

/** WhatsApp on a second number, one honest state at a time. */
export async function WhatsAppSection({ location, skipHref }: { location: Location; skipHref?: string }) {
  const whatsapp = await whatsappStatus(location);
  const account = whatsapp.state === "connected" ? whatsapp.account : null;
  return (
    <section className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-head">WhatsApp</div>
      <div style={{ padding: 18 }}>
        <WhatsAppCard
          locationId={location.id}
          venueName={location.name}
          card={location.demo?.enabled && !account ? { state: "soon" } : whatsappCard(location, whatsapp)}
          pendingName={location.whatsappPending?.displayName ?? null}
          notifyRequested={Boolean(location.onboarding?.integrationRequests?.includes("whatsapp"))}
          skipHref={skipHref}
        />
      </div>
    </section>
  );
}
