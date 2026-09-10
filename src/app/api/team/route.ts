import { NextResponse } from "next/server";
import { canManageUsers, createUser, setPassword } from "@/lib/auth";
import { requireApiUser } from "@/lib/auth-server";
import { deleteSessions, deleteUser, getUser, listUsers, saveUser } from "@/lib/store";
import type { Role } from "@/lib/types";

export const dynamic = "force-dynamic";

const ROLES: Role[] = ["owner", "manager", "staff"];

/**
 * Team management. Owners only.
 *
 * Two invariants are enforced on every path, because breaking either one
 * locks everybody out of a live system: there is always at least one enabled
 * owner, and you cannot disable or delete yourself.
 */

function lastEnabledOwner(userId: string): boolean {
  const owners = listUsers().filter((u) => u.role === "owner" && !u.disabled);
  return owners.length <= 1 && owners[0]?.id === userId;
}

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!canManageUsers(auth.user)) {
    return NextResponse.json({ error: "Owners only." }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    name?: string;
    password?: string;
    role?: Role;
    locationIds?: string[];
  };

  if (!body.email || !body.password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }
  const role = ROLES.includes(body.role as Role) ? (body.role as Role) : "staff";

  const created = createUser({
    email: body.email,
    name: body.name ?? "",
    password: body.password,
    role,
    locationIds: body.locationIds ?? [],
  });
  if (!created.ok) return NextResponse.json({ error: created.error }, { status: 400 });

  return NextResponse.json({ ok: true });
}

export async function PATCH(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!canManageUsers(auth.user)) {
    return NextResponse.json({ error: "Owners only." }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    userId?: string;
    role?: Role;
    locationIds?: string[];
    disabled?: boolean;
    password?: string;
  };

  const user = body.userId ? getUser(body.userId) : undefined;
  if (!user) return NextResponse.json({ error: "No such person." }, { status: 404 });

  const losingOwnership =
    (body.role && body.role !== "owner") || body.disabled === true;
  if (losingOwnership && lastEnabledOwner(user.id)) {
    return NextResponse.json(
      { error: "There has to be one owner who can still sign in." },
      { status: 409 },
    );
  }
  if (body.disabled === true && user.id === auth.user.id) {
    return NextResponse.json({ error: "You cannot disable yourself." }, { status: 409 });
  }

  if (body.password) {
    const result = setPassword(user, body.password);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  }

  const role = ROLES.includes(body.role as Role) ? (body.role as Role) : user.role;
  saveUser({
    ...getUser(user.id)!,
    role,
    locationIds: role === "owner" ? [] : (body.locationIds ?? user.locationIds),
    disabled: body.disabled ?? user.disabled,
  });

  // A disabled account should stop working now, not in a fortnight.
  if (body.disabled === true) deleteSessions({ userId: user.id });

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!canManageUsers(auth.user)) {
    return NextResponse.json({ error: "Owners only." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId") ?? "";
  const user = getUser(userId);
  if (!user) return NextResponse.json({ error: "No such person." }, { status: 404 });
  if (user.id === auth.user.id) {
    return NextResponse.json({ error: "You cannot remove yourself." }, { status: 409 });
  }
  if (lastEnabledOwner(user.id)) {
    return NextResponse.json(
      { error: "There has to be one owner who can still sign in." },
      { status: 409 },
    );
  }

  deleteUser(user.id);
  return NextResponse.json({ ok: true });
}
