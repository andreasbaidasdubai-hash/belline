import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth-server";
import { addTeammate, removeTeammate, updateTeammate } from "@/lib/team";
import type { Role } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Managing who can sign in.
 *
 * Thin on purpose. Everything that decides anything — whose tenant, which
 * role, whether that would remove the last owner — is in `lib/team.ts`, where
 * it can be tested without a session. This file turns a request into a call
 * and a result into a status code, and nothing else.
 */

function reply(result: { ok: true } | { ok: false; error: string; status: number }) {
  return result.ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: result.error }, { status: result.status });
}

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    name?: string;
    password?: string;
    role?: Role;
    locationIds?: string[];
  };
  return reply(addTeammate(auth.user, body));
}

export async function PATCH(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const body = (await request.json().catch(() => ({}))) as {
    userId?: string;
    role?: Role;
    locationIds?: string[];
    disabled?: boolean;
    password?: string;
  };
  return reply(updateTeammate(auth.user, body));
}

export async function DELETE(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;

  const { searchParams } = new URL(request.url);
  return reply(removeTeammate(auth.user, searchParams.get("userId") ?? undefined));
}
