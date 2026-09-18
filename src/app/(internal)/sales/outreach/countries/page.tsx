import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { seedIfEmpty } from "@/lib/seed";
import { engineStatus } from "@/lib/sales/sending/engine";
import { describeIdentityGaps, missingIdentityFields } from "@/lib/legal/identity";
import { ConsoleHeader, KeyValues, Pill } from "../../ui";
import Action from "../../Actions";
import OutreachTabs from "../OutreachTabs";

export const dynamic = "force-dynamic";

/**
 * Which countries are open, and what each one costs us in obligations.
 *
 * Staff can turn a country on and turn its daily number down. They cannot
 * widen its spacing, raise its message cap or waive the sender identity it
 * requires — those come from the rule table in code, because they are the
 * parts that carry the liability and the parts a busy person on a slow week
 * would be most tempted to loosen.
 *
 * Germany, Austria and Switzerland are off until the company exists. Their law
 * requires a named sending entity with an address, a representative and a
 * register entry, and no setting on this page can conjure one.
 */
export default async function Countries() {
  seedIfEmpty();
  const user = await requireUser();
  if (!isBellineStaff(user)) return <p className="muted">Belline staff only.</p>;

  const status = await engineStatus();

  return (
    <>
      <ConsoleHeader
        title="Countries"
        subtitle="A lead's country decides its cap, its spacing, its language and whether it may be written to at all."
      />
      <OutreachTabs active="/sales/outreach/countries" />

      <div className="panel staff-section">
        <div className="panel-head">
          <h2>Our sender identity</h2>
        </div>
        <div className="staff-body">
          <KeyValues
            rows={[
              ["Entity", status.identity.entity || <span className="muted">not filled in</span>],
              ["Address", status.identity.address || <span className="muted">not filled in</span>],
              ["Represented by", status.identity.managingDirector || <span className="muted">not filled in</span>],
              ["Register", status.identity.registration || <span className="muted">not filled in</span>],
              ["VAT", status.identity.vatNumber || <span className="muted">not filled in</span>],
              ["Contact", status.identity.email || <span className="muted">not filled in</span>],
            ]}
          />
          <p className="staff-note">
            One block, in <code>src/lib/legal/identity.ts</code>, shared with the privacy and terms pages.
            Filling it there fills the website and every email footer at once.
          </p>
        </div>
      </div>

      {status.countries.map((country) => {
        const gaps = missingIdentityFields(status.identity, country.requiresIdentity);
        const blockedByIdentity = gaps.length > 0;
        return (
          <div className="panel staff-section" key={country.code}>
            <div className="panel-head">
              <h2>{country.label}</h2>
              <Pill tone={country.enabled && !blockedByIdentity ? "ok" : country.enabled ? "warn" : undefined}>
                {country.enabled ? (blockedByIdentity ? "On, but refused" : "On") : "Off"}
              </Pill>
            </div>
            <div className="staff-body">
              {country.caution && <p className="staff-note">{country.caution}</p>}
              {blockedByIdentity && (
                <p className="staff-note">
                  Even switched on, every send to {country.label} is refused: its law requires the sender to
                  be identified and we are missing {describeIdentityGaps(gaps)}.
                </p>
              )}
              <KeyValues
                rows={[
                  ["Most per day", country.enabled ? String(country.effectiveDailyCap) : "0"],
                  ["Days between touches", String(country.minDaysBetweenTouches)],
                  ["Messages in a sequence", `${country.maxSequenceSteps} (first email plus ${country.maxSequenceSteps - 1} follow-ups)`],
                  ["Messages to one company in 90 days", String(country.companyTouchCap90d)],
                  ["Language of the footer", country.language.toUpperCase()],
                  ["Basis recorded on every send", country.basis],
                ]}
              />
              <div className="staff-row-actions">
                <Action
                  endpoint="/api/sales/outreach"
                  body={{ action: "country", code: country.code }}
                  label={country.enabled ? "Change" : "Turn on"}
                  small
                  tone={country.enabled ? "plain" : "primary"}
                  fields={[
                    {
                      name: "enabled",
                      label: "Cold email here",
                      type: "select",
                      defaultValue: country.enabled ? "true" : "false",
                      options: [
                        { value: "true", label: "On" },
                        { value: "false", label: "Off" },
                      ],
                    },
                    {
                      name: "dailyCap",
                      label: `Most per day (the rule caps this at ${country.dailyCap})`,
                      type: "number",
                      defaultValue: String(country.effectiveDailyCap || country.dailyCap),
                      min: 0,
                      max: country.dailyCap,
                    },
                    {
                      name: "reason",
                      label: "On what basis? Needed to turn a country on; it goes in the audit log.",
                      type: "textarea",
                    },
                  ]}
                  submitLabel="Save"
                />
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}
