import { closedConnector } from "./closed";
import { PARTNERS } from "./registry";

/**
 * Doctolib. The hardest door on the list, and the one the German launch wanted.
 *
 * Clinics in France and Germany, dominant in both, and nothing technical is
 * public. `developers.doctolib.com` resolves and answers 401;
 * `developers.doctolib.fr` does not exist; `doctolib.de/api` and
 * `doctolib.fr/api` are 404; `partners.doctolib.fr` redirects to the consumer
 * site; and the partner portal is a Salesforce login wall that asks for a
 * company custom domain, so it is reachable only once a commercial
 * relationship already exists. No API reference, no base URL, no auth model,
 * no sandbox.
 *
 * The partner routes that exist all lead to lead-capture forms rather than to
 * an API, and their shape is the finding. The German one is framed around
 * partner discounts — a reseller and consultancy channel. The French taxonomy
 * lists télésecrétariat, IT consultants, equipment makers and distributors,
 * training bodies and "other": there is no category for a software vendor and
 * none a voice agent would fit. Doctolib Connect does expose a SCIM API, which
 * provisions users and has nothing to do with appointments.
 *
 * Every integration Doctolib names publicly is with a practice-management
 * software vendor — PRO MEDISOFT, zollsoft's tomedo — and every one runs the
 * *other* direction: Doctolib's calendar syncing into the practice's own
 * software to stop double entry. Doctolib publishes no third-party booking API,
 * no book-on-behalf-of-a-patient flow, and no patient authorisation model.
 *
 * ## The obstacle is not the API
 *
 * This is the one on the list where the integration question is the smaller
 * half. Appointment data here is health data. Doctolib holds HDS certification
 * in France — the regulated regime for hosting health data — and its public
 * position is that patient data is reachable only by authorised healthcare
 * providers. Germany adds medical confidentiality under §203 StGB on top of
 * GDPR Article 9. A voice agent booking on a patient's behalf is a
 * non-clinical third party handling regulated health data, and that is an
 * argument to have with lawyers before it is one to have with an API team.
 *
 * Doctolib does not publish a prohibition on third-party booking. It does not
 * address it at all — and reading permission into that silence would be exactly
 * the mistake this file exists to prevent. Absence of a refusal is not consent.
 *
 * ## What this means for the German-speaking launch
 *
 * Plan for Doctolib not being connected. Not "not yet" — not connected. A
 * clinic on Doctolib is one where Belline answers the phone, takes the request
 * with the patient's name, number and the time they want, and the practice
 * confirms. That is a product to design deliberately rather than a gap to be
 * left open while an application is pending, because there is no application to
 * be pending.
 *
 * **What the founder would have to do:** the German partnership form, which is
 * a commercial-reseller conversation rather than a technical one, and expect
 * the health-data question rather than the endpoint question. It is worth one
 * email to learn whether an ISV route exists at all that their published
 * taxonomies do not mention. It is not worth holding the launch for.
 */
export const doctolibConnector = closedConnector(PARTNERS.doctolib);
