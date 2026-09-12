import type { Role, User } from "./types";
import { createUser, setPassword } from "./auth";
import { deleteSessions, deleteUser, getUser, listUsersFor, saveUser } from "./store";

/**
 * Who can open a tenant's dashboard, and what one owner may do to another.
 *
 * Every function here takes the acting user first and refuses to touch anyone
 * outside that user's tenant. That is the whole reason the file exists: the
 * route it replaces resolved a `userId` from the request body with a global
 * lookup and never asked whose it was — so any self-serve owner could list
 * every other tenant's owners from the Team page, take an id, and reset that
 * person's password. Not a theoretical chain; three requests.
 *
 * A library rather than route logic so it can be tested without a session
 * cookie. The two invariants the old route enforced survive, now per tenant:
 * there is always at least one enabled owner, and you cannot disable or
 * delete yourself.
 */

export const ROLES: Role[] = ["owner", "manager", "staff"];

export type TeamResult = { ok: true } | { ok: false; error: string; status: number };

/** The people in the actor's tenant, without password hashes. */
export function teamFor(actor: User) {
  return listUsersFor(actor.tenantId).map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    locationIds: u.locationIds,
    disabled: Boolean(u.disabled),
    lastSeenAt: u.lastSeenAt ?? null,
  }));
}

/** A user in the actor's tenant, or nothing — never somebody else's. */
function colleague(actor: User, userId: string | undefined): User | undefined {
  if (!userId) return undefined;
  const user = getUser(userId);
  return user && user.tenantId === actor.tenantId ? user : undefined;
}

function lastEnabledOwner(actor: User, userId: string): boolean {
  const owners = listUsersFor(actor.tenantId).filter((u) => u.role === "owner" && !u.disabled);
  return owners.length <= 1 && owners[0]?.id === userId;
}

export function addTeammate(
  actor: User,
  input: { email?: string; name?: string; password?: string; role?: Role; locationIds?: string[] },
): TeamResult {
  if (actor.role !== "owner") return { ok: false, error: "Owners only.", status: 403 };
  if (!input.email || !input.password) {
    return { ok: false, error: "Email and password are required.", status: 400 };
  }
  const role = ROLES.includes(input.role as Role) ? (input.role as Role) : "staff";

  const created = createUser({
    email: input.email,
    name: input.name ?? "",
    password: input.password,
    role,
    locationIds: input.locationIds ?? [],
    // Theirs, not the default. Left out, every teammate a self-serve owner
    // added landed in the migration tenant, signed in, and was told no venues
    // were assigned to their account.
    tenantId: actor.tenantId,
  });
  return created.ok ? { ok: true } : { ok: false, error: created.error, status: 400 };
}

export function updateTeammate(
  actor: User,
  input: {
    userId?: string;
    role?: Role;
    locationIds?: string[];
    disabled?: boolean;
    password?: string;
  },
): TeamResult {
  if (actor.role !== "owner") return { ok: false, error: "Owners only.", status: 403 };

  const user = colleague(actor, input.userId);
  // 404 for a foreign id as much as for a mistyped one. Saying "not yours"
  // would confirm the id exists, which is information the caller should not
  // have had in the first place.
  if (!user) return { ok: false, error: "No such person.", status: 404 };

  const losingOwnership = (input.role && input.role !== "owner") || input.disabled === true;
  if (losingOwnership && lastEnabledOwner(actor, user.id)) {
    return {
      ok: false,
      error: "There has to be one owner who can still sign in.",
      status: 409,
    };
  }
  if (input.disabled === true && user.id === actor.id) {
    return { ok: false, error: "You cannot disable yourself.", status: 409 };
  }

  if (input.password) {
    const result = setPassword(user, input.password);
    if (!result.ok) return { ok: false, error: result.error ?? "Bad password.", status: 400 };
  }

  const role = ROLES.includes(input.role as Role) ? (input.role as Role) : user.role;
  saveUser({
    ...getUser(user.id)!,
    role,
    locationIds: role === "owner" ? [] : (input.locationIds ?? user.locationIds),
    disabled: input.disabled ?? user.disabled,
  });

  // A disabled account should stop working now, not in a fortnight.
  if (input.disabled === true) deleteSessions({ userId: user.id });
  return { ok: true };
}

export function removeTeammate(actor: User, userId: string | undefined): TeamResult {
  if (actor.role !== "owner") return { ok: false, error: "Owners only.", status: 403 };

  const user = colleague(actor, userId);
  if (!user) return { ok: false, error: "No such person.", status: 404 };
  if (user.id === actor.id) return { ok: false, error: "You cannot remove yourself.", status: 409 };
  if (lastEnabledOwner(actor, user.id)) {
    return {
      ok: false,
      error: "There has to be one owner who can still sign in.",
      status: 409,
    };
  }

  deleteUser(user.id);
  return { ok: true };
}
