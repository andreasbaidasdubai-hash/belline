/**
 * Staff actions on the outreach engine.
 *
 * Every mutation the console can make, behind one door, gated on staff and
 * audited. The two that matter:
 *
 *  - `approve` is the only thing in the codebase that makes a message
 *    sendable. It records who pressed it, and `dispatch.ts` refuses any item
 *    whose batch has no name against it.
 *  - `country` can switch a country on. It cannot loosen that country's
 *    spacing, step cap or identity requirement — those come from the rule
 *    table in code, and a settings screen is not the place to edit a statute.
 */

import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { staffAudit, cleanReason } from "@/lib/staff/audit";
import { sendingStore } from "@/lib/sales/sending/store";
import { buildBatch, saveBatch } from "@/lib/sales/sending/batch";
import { pipelineSource } from "@/lib/sales/sending/candidates";
import { ruleFor } from "@/lib/sales/sending/countries";
import { receiveReply, suppressCompany } from "@/lib/sales/sending/replies";
import { halt, blankState } from "@/lib/sales/sending/sequence";
import { watchHealth } from "@/lib/sales/sending/watch";

export const dynamic = "force-dynamic";

function origin(): string {
  const value = (process.env.PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "");
  return value || "https://app.belline.ai";
}

const bad = (error: string, status = 422) => NextResponse.json({ error }, { status });

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!isBellineStaff(auth.user)) return NextResponse.json({ error: "Belline staff only." }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";
  const who = `user:${auth.user.id}`;
  const actor = auth.user;
  const store = sendingStore();

  switch (action) {
    // ---- batches ---------------------------------------------------------
    case "build": {
      const limit = Number(body.limit ?? 25);
      if (!Number.isInteger(limit) || limit < 1 || limit > 300) return bad("Choose between 1 and 300 leads.");
      const built = await buildBatch({
        source: pipelineSource({ origin: origin(), store }),
        limit,
        includeFollowUps: body.followUps === true,
        origin: origin(),
      });
      if (built.sendable.length === 0) {
        return bad(
          built.blocked.length > 0
            ? `Nothing is sendable. The first reason is: ${built.blocked[0].blocks[0]?.reason}`
            : "There is nothing waiting with a prepared demo.",
        );
      }
      const { batch } = await saveBatch({
        built,
        createdBy: who,
        origin: origin(),
        notes: typeof body.notes === "string" ? body.notes.slice(0, 500) : null,
        store,
      });
      await staffAudit({
        actor,
        action: "outreach.batch.build",
        entity: "send_batch",
        entityId: String(batch.id),
        after: batch.planned as unknown as Record<string, unknown>,
      });
      return NextResponse.json({ ok: true, batchId: batch.id, next: `/sales/outreach/batches/${batch.id}` });
    }

    case "approve": {
      const id = Number(body.batchId);
      if (!Number.isInteger(id)) return bad("Which batch?");
      const before = await store.getBatch(id);
      if (!before) return bad("That batch no longer exists.", 404);
      if (before.status !== "draft") return bad(`That batch is already ${before.status}.`);
      const approved = await store.approveBatch(id, who);
      if (!approved) return bad("Somebody approved that batch a moment ago.", 409);
      // Queue everything the plan placed. The scheduled minute decides when
      // each actually leaves; this only marks them as ready to be picked up.
      for (const item of await store.listItems({ batchId: id, status: ["planned"] })) {
        await store.updateItem(item.id, { status: "queued" });
      }
      await staffAudit({
        actor,
        action: "outreach.batch.approve",
        entity: "send_batch",
        entityId: String(id),
        before: { status: before.status },
        after: { status: "approved", leads: approved.planned.leads },
      });
      return NextResponse.json({ ok: true });
    }

    case "cancel": {
      const id = Number(body.batchId);
      if (!Number.isInteger(id)) return bad("Which batch?");
      const cancelled = await store.cancelBatch(id, who);
      if (!cancelled) return bad("That batch could not be cancelled.", 409);
      await staffAudit({ actor, action: "outreach.batch.cancel", entity: "send_batch", entityId: String(id) });
      return NextResponse.json({ ok: true });
    }

    // ---- domains and mailboxes ------------------------------------------
    case "domain.add": {
      const domain = String(body.domain ?? "").trim().toLowerCase();
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return bad("That does not look like a domain.");
      if (/(^|\.)belline\.ai$/.test(domain)) {
        return bad(
          "belline.ai carries customers' transactional email. It must never send cold mail — use a separate lookalike domain.",
        );
      }
      const added = await store.addDomain({
        domain,
        provider: "ses",
        purpose: "cold",
        status: "warming",
        dailyCap: Math.max(1, Math.min(Number(body.dailyCap ?? 120), 400)),
        dns: {},
        notes: null,
        pausedReason: null,
        pausedAt: null,
      });
      await staffAudit({ actor, action: "outreach.domain.add", entity: "sending_domain", entityId: String(added.id), after: { domain } });
      return NextResponse.json({ ok: true });
    }

    case "domain.pause":
    case "domain.resume": {
      const id = Number(body.domainId);
      if (!Number.isInteger(id)) return bad("Which domain?");
      const pausing = action === "domain.pause";
      const reason = cleanReason(body.reason);
      if (pausing && reason.length < 3) return bad("Say why, in a few words. It goes in the audit log.");
      const updated = await store.updateDomain(id, {
        status: pausing ? "paused" : "active",
        pausedReason: pausing ? reason : null,
        pausedAt: pausing ? new Date().toISOString() : null,
      });
      if (!updated) return bad("That domain no longer exists.", 404);
      await staffAudit({ actor, action: `outreach.${action}`, entity: "sending_domain", entityId: String(id), reason: pausing ? reason : undefined });
      return NextResponse.json({ ok: true });
    }

    case "mailbox.add": {
      const domainId = Number(body.domainId);
      const address = String(body.address ?? "").trim().toLowerCase();
      const displayName = String(body.displayName ?? "").trim();
      if (!Number.isInteger(domainId)) return bad("Which domain?");
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(address)) return bad("That does not look like an address.");
      if (!displayName) return bad("A mailbox needs a name a recipient will see.");
      const domains = await store.listDomains();
      const domain = domains.find((d) => d.id === domainId);
      if (!domain) return bad("That domain no longer exists.", 404);
      if (!address.endsWith(`@${domain.domain}`)) return bad(`That address is not on ${domain.domain}.`);
      const added = await store.addMailbox({
        domainId,
        address,
        displayName,
        replyTo: typeof body.replyTo === "string" && body.replyTo.trim() ? body.replyTo.trim() : null,
        dailyCap: Math.max(1, Math.min(Number(body.dailyCap ?? 30), 50)),
        warmupStartedOn: null,
        status: "warming",
        pausedReason: null,
        pausedAt: null,
      });
      await staffAudit({ actor, action: "outreach.mailbox.add", entity: "sending_mailbox", entityId: String(added.id), after: { address } });
      return NextResponse.json({ ok: true });
    }

    case "mailbox.warmup": {
      const id = Number(body.mailboxId);
      if (!Number.isInteger(id)) return bad("Which mailbox?");
      const updated = await store.updateMailbox(id, {
        warmupStartedOn: new Date().toISOString().slice(0, 10),
        status: "warming",
      });
      if (!updated) return bad("That mailbox no longer exists.", 404);
      await staffAudit({ actor, action: "outreach.mailbox.warmup", entity: "sending_mailbox", entityId: String(id) });
      return NextResponse.json({ ok: true });
    }

    case "mailbox.pause":
    case "mailbox.resume": {
      const id = Number(body.mailboxId);
      if (!Number.isInteger(id)) return bad("Which mailbox?");
      const pausing = action === "mailbox.pause";
      const reason = cleanReason(body.reason);
      if (pausing && reason.length < 3) return bad("Say why, in a few words. It goes in the audit log.");
      const updated = await store.updateMailbox(id, {
        status: pausing ? "paused" : "active",
        pausedReason: pausing ? reason : null,
        pausedAt: pausing ? new Date().toISOString() : null,
      });
      if (!updated) return bad("That mailbox no longer exists.", 404);
      await staffAudit({ actor, action: `outreach.${action}`, entity: "sending_mailbox", entityId: String(id), reason: pausing ? reason : undefined });
      return NextResponse.json({ ok: true });
    }

    // ---- countries -------------------------------------------------------
    case "country": {
      const code = String(body.code ?? "").trim().toUpperCase();
      const rule = ruleFor(code);
      if (rule.code === "*") return bad(`No sending rule has been written for ${code || "that country"}.`);
      const enabled = body.enabled === true || body.enabled === "true";
      const reason = cleanReason(body.reason);
      if (enabled && reason.length < 3) {
        return bad("Turning a country on is a legal decision. Say on what basis; it goes in the audit log.");
      }
      const asked = body.dailyCap === undefined || body.dailyCap === "" ? null : Number(body.dailyCap);
      if (asked !== null && (!Number.isInteger(asked) || asked < 0)) return bad("The daily number must be a whole number.");
      await store.setCountryOverride({
        code,
        enabled,
        // Clamped by `effectiveRule`; stored as asked so the intent is visible.
        dailyCap: asked,
        updatedBy: who,
      });
      await staffAudit({
        actor,
        action: "outreach.country",
        entity: "outreach_country",
        entityId: code,
        reason: reason || undefined,
        after: { enabled, dailyCap: asked },
      });
      return NextResponse.json({ ok: true });
    }

    // ---- replies and sequences ------------------------------------------
    case "reply.record": {
      // Used while no inbound connector is wired: staff paste what arrived in
      // the shared mailbox so the lead's sequence stops and the record exists.
      const from = String(body.from ?? "").trim();
      const text = String(body.body ?? "").trim();
      if (!from.includes("@")) return bad("Whose reply?");
      if (text.length < 2) return bad("Paste what they wrote.");
      const result = await receiveReply({
        fromAddress: from,
        subject: typeof body.subject === "string" ? body.subject.slice(0, 300) : null,
        body: text,
        leadId: body.leadId === undefined ? null : Number(body.leadId),
        itemId: body.itemId === undefined ? null : Number(body.itemId),
      });
      await staffAudit({ actor, action: "outreach.reply.record", entity: "inbound_reply", entityId: String(result.reply.id) });
      return NextResponse.json({ ok: true, stopped: result.stopped, optOut: result.optOut });
    }

    /**
     * A person deciding what an ambiguous message meant.
     *
     * The classifier refuses to guess between "not interested" and "not
     * interested right now", so it flags and stops there. This is where the
     * guess becomes a decision, with a name against it: yes suppresses the
     * company for good, no clears the flag and leaves the sequence stopped —
     * because whatever they meant, they did reply.
     */
    case "reply.optout": {
      const id = Number(body.replyId);
      if (!Number.isInteger(id)) return bad("Which message?");
      const optOut = body.optOut === true || body.optOut === "true";
      const replies = await store.listReplies({ limit: 500 });
      const reply = replies.find((r) => r.id === id);
      if (!reply) return bad("That message no longer exists.", 404);
      await store.resolveReview(id, { isOptOut: optOut, needsReview: false, handledBy: who });
      if (optOut) {
        await suppressCompany(
          { email: reply.fromAddress, companyId: null, reason: "opt_out", by: who },
          store,
        );
        if (reply.leadId !== null) {
          const state = (await store.getSequence(reply.leadId)) ?? blankState(reply.leadId, null, null);
          await store.upsertSequence(halt(state, "unsubscribed", new Date()));
          for (const item of await store.listItems({ leadId: reply.leadId, status: ["planned", "queued"] })) {
            await store.updateItem(item.id, { status: "cancelled", blockedReason: "stopped: they asked to stop" });
          }
        }
      }
      await staffAudit({
        actor,
        action: "outreach.reply.optout",
        entity: "inbound_reply",
        entityId: String(id),
        after: { optOut, from: reply.fromAddress },
      });
      return NextResponse.json({ ok: true });
    }

    case "reply.handled": {
      const id = Number(body.replyId);
      if (!Number.isInteger(id)) return bad("Which reply?");
      const marked = await store.markReplyHandled(id, who);
      if (!marked) return bad("That reply no longer exists.", 404);
      return NextResponse.json({ ok: true });
    }

    case "sequence.stop": {
      const leadId = Number(body.leadId);
      if (!Number.isInteger(leadId)) return bad("Which lead?");
      const reason = cleanReason(body.reason);
      if (reason.length < 3) return bad("Say why, in a few words.");
      const state = (await store.getSequence(leadId)) ?? blankState(leadId, null, null);
      await store.upsertSequence(halt(state, "staff", new Date()));
      for (const item of await store.listItems({ leadId, status: ["planned", "queued"] })) {
        await store.updateItem(item.id, { status: "cancelled", blockedReason: `stopped by staff: ${reason}` });
      }
      await staffAudit({ actor, action: "outreach.sequence.stop", entity: "sequence_state", entityId: String(leadId), reason });
      return NextResponse.json({ ok: true });
    }

    case "suppress": {
      const email = typeof body.email === "string" ? body.email.trim() : null;
      const companyId = body.companyId === undefined ? null : Number(body.companyId);
      if (!email && companyId === null) return bad("Suppress whom?");
      await suppressCompany({ email, companyId, reason: "manual", by: who }, store);
      await staffAudit({ actor, action: "outreach.suppress", entity: "suppression", entityId: email ?? String(companyId), after: { email, companyId } });
      return NextResponse.json({ ok: true });
    }

    case "health.check": {
      const result = await watchHealth({ store });
      return NextResponse.json({ ok: true, paused: result.paused.length, tickets: result.tickets.length });
    }

    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}
