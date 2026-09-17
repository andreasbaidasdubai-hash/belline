import type { UnifiedLead } from "@/lib/staff/leads";

/**
 * The slot for the personalised video demo on a lead's page.
 *
 * Deliberately renders nothing today: the video demo (a /demo/v/<token> page,
 * a "Create video demo" action, its email draft and its tracking) is being
 * built separately, and an empty panel that promises it would be fake UI.
 * When it lands, it renders here, in the lead page's "Video demo" section, and
 * reports what happens to the demo into the lead's timeline through
 * `recordLeadEvent` in lib/staff/leads.ts. An event of type `demo_watched`
 * also marks the lead hot, which puts it on Today.
 */
export default function VideoDemoSlot(props: { lead: UnifiedLead }): React.ReactNode {
  void props;
  return null;
}
