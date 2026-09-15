/**
 * Which version of the legal documents somebody agreed to.
 *
 * Recorded on the tenant at signup (`Tenant.onboarding.terms`), so "what did
 * this customer accept, and when" has an answer the day it is asked.
 *
 * PLACEHOLDERS. The Terms, the DPA and the acceptable use policy are with a
 * lawyer (plan checklist 2.1, 2.2, 2.6). When a reviewed version is published,
 * change the constant here in the same commit; accounts keep the version they
 * accepted, which is the point of recording it.
 */

export const TOS_VERSION = "2026-09-placeholder";
export const DPA_VERSION = "2026-09-placeholder";
