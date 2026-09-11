import { isConfigured, query } from "@/lib/sales/db/client";
import Brand from "@/components/Brand";
import DemoPlayer, { type Clip } from "./DemoPlayer";
import PlayReporter from "./PlayReporter";

/**
 * The personalised demo landing page.
 *
 * This is what the outbound email links to, and the only page in the system a
 * prospect sees before deciding whether Belline is worth five minutes. It has
 * one job above the fold: play the recording.
 *
 * It carries a real business's name, so — as with the live prospect demo — it
 * says three times and without being asked that it is a simulation assembled
 * from a public web page, and it expires.
 */

export interface RecordedDemo {
  id: number;
  leadId: number;
  company: string;
  city: string | null;
  scenario: string | null;
  seconds: number | null;
  scriptHint: string;
  expiresAt: Date;
  clips: Clip[];
  disclosure: string;
}

export async function findRecordedDemo(slug: string): Promise<RecordedDemo | null> {
  if (!isConfigured()) return null;
  try {
    const rows = await query<{
      id: number;
      lead_id: number;
      company: string;
      city: string | null;
      scenario: string | null;
      seconds: number | null;
      script_hint: string;
      expires_at: Date;
      script: { clips?: Clip[]; disclosure?: string };
    }>(
      `select d.id, d.lead_id, c.name as company, c.city, d.scenario, d.seconds,
              d.script_hint, d.expires_at, d.script
         from sales.demo d
         join sales.lead l on l.id = d.lead_id
         join sales.company c on c.id = l.company_id
        where d.location_slug = $1 and d.kind = 'recording' and d.expires_at > now()
        order by d.issued_at desc limit 1`,
      [slug],
    );

    const row = rows[0];
    // A row whose clips never made it (an older build, or a failed render) is
    // treated as absent rather than rendered as a player with nothing in it.
    if (!row?.script?.clips?.length) return null;

    return {
      id: row.id,
      leadId: row.lead_id,
      company: row.company,
      city: row.city,
      scenario: row.scenario,
      seconds: row.seconds,
      scriptHint: row.script_hint,
      expiresAt: row.expires_at,
      clips: row.script.clips,
      disclosure: row.script.disclosure ?? "",
    };
  } catch {
    // The sales database being unreachable must not take down the live
    // prospect demos, which run entirely off the JSON store.
    return null;
  }
}

export function RecordedDemoPage({ demo }: { demo: RecordedDemo }) {
  return (
    <div className="prospect">
      <style>{CSS}</style>

      <header className="prospect-top">
        <Brand size={22} />
        <span className="prospect-badge">Demonstration</span>
      </header>

      <main className="prospect-main">
        <p className="prospect-eyebrow">{demo.company} × Belline</p>
        <h1>This is how your phone could be answered.</h1>
        <p className="prospect-lead">
          {demo.scenario
            ? `${demo.scenario} — built from your own website, in about two minutes.`
            : "Built from your own website, in about two minutes."}
        </p>

        <PlayReporter demoId={demo.id}>
          <DemoPlayer clips={demo.clips} business={demo.company} />
        </PlayReporter>

        <div className="prospect-note">
          <strong>Nothing here is real.</strong> This call was written and voiced
          automatically from {demo.company}&apos;s public website, so some of it will be
          wrong. No one from {demo.company} took part, nothing in it was booked, and it is
          not connected to your phone line or your diary. The page disappears on{" "}
          {demo.expiresAt.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}.
        </div>

        <section className="prospect-try">
          <h2>Now try it yourself</h2>
          <p style={{ margin: "0 0 14px" }}>{demo.scriptHint}</p>
          <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>
            The recording above is scripted. The live line is not — it answers whatever you
            actually say.
          </p>
        </section>

        <section className="prospect-cta">
          <h2>Want this on your real number?</h2>
          <p>
            The version you just heard knows what a web page could tell it. The real one
            knows your diary, your team and your rules — and it answers the number your
            {demo.city ? ` ${demo.city} ` : " "}patients already call.
          </p>
          <a
            className="prospect-btn"
            href={`mailto:hello@belline.ai?subject=${encodeURIComponent(`Belline for ${demo.company}`)}`}
          >
            Activate Belline for my business
          </a>
        </section>
      </main>

      <footer className="prospect-foot">
        Belline · AI reception · This demonstration is unaffiliated with and unverified by{" "}
        {demo.company}.
      </footer>
    </div>
  );
}

/**
 * Scoped to this page rather than added to globals.css, which the customer
 * dashboard and the marketing site both depend on.
 */
const CSS = `
.demo-player { margin: 26px 0 30px; }
.demo-player-bar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.demo-play {
  display: inline-flex; align-items: center; gap: 11px;
  padding: 14px 24px; border-radius: 11px; cursor: pointer;
  background: var(--gold, #C9A227); color: var(--navy, #0B1F33);
  border: none; font-size: 15px; font-weight: 700; font-family: inherit;
  transition: filter 0.14s ease;
}
.demo-play:hover { filter: brightness(1.06); }
.demo-play:focus-visible { outline: 2px solid var(--navy, #0B1F33); outline-offset: 3px; }
.demo-live { display: flex; align-items: center; gap: 3px; height: 20px; }
.demo-live i {
  display: block; width: 3px; height: 5px; border-radius: 2px;
  background: var(--gold, #C9A227); opacity: 0.5;
}
.demo-live[data-speaking="true"] i { animation: demobar 900ms ease-in-out infinite; opacity: 1; }
.demo-live[data-speaking="true"] i:nth-child(2) { animation-delay: 120ms; }
.demo-live[data-speaking="true"] i:nth-child(3) { animation-delay: 240ms; }
.demo-live[data-speaking="true"] i:nth-child(4) { animation-delay: 120ms; }
@keyframes demobar { 0%, 100% { height: 5px; } 50% { height: 19px; } }
.demo-failed { margin-top: 12px; font-size: 13.5px; color: #B4472E; }
.demo-transcript {
  margin-top: 20px; display: flex; flex-direction: column; gap: 10px;
  max-height: 340px; overflow-y: auto; padding-right: 6px;
}
.demo-turn {
  display: grid; grid-template-columns: 76px 1fr; gap: 12px;
  font-size: 14.5px; line-height: 1.5; opacity: 0.45;
  transition: opacity 0.2s ease;
}
.demo-turn[data-on="true"] { opacity: 1; }
.demo-who {
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.09em;
  text-transform: uppercase; padding-top: 3px;
}
.demo-agent .demo-who { color: var(--gold, #C9A227); }
.demo-caller .demo-who { color: #7D93A8; }
@media (prefers-reduced-motion: reduce) {
  .demo-live[data-speaking="true"] i { animation: none; height: 12px; }
  .demo-transcript { scroll-behavior: auto; }
}
@media (max-width: 560px) {
  .demo-turn { grid-template-columns: 1fr; gap: 2px; }
  .demo-play { width: 100%; justify-content: center; }
}
`;
