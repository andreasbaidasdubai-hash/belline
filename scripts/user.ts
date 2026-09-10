/**
 * Account recovery from the command line.
 *
 * The dashboard can add people, but if the only owner forgets their password
 * there is no way back in through the browser — so this exists, and it has to
 * be run with access to the server. That is the point: shell access is the
 * root of trust here.
 *
 *   npm run user -- list
 *   npm run user -- add owner@example.com "a good long password" owner
 *   npm run user -- reset owner@example.com "a new long password"
 *   npm run user -- disable someone@example.com
 */

import { createUser, setPassword } from "../src/lib/auth";
import { findUserByEmail, listUsers, saveUser } from "../src/lib/store";
import { seedIfEmpty } from "../src/lib/seed";
import type { Role } from "../src/lib/types";

seedIfEmpty();

const [command, email, password, role] = process.argv.slice(2);

function bail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

switch (command) {
  case "list": {
    const users = listUsers();
    if (users.length === 0) {
      console.log("\n  Nobody yet. The first visit to /login creates the owner.\n");
      break;
    }
    console.log("");
    for (const u of users) {
      const venues = u.role === "owner" ? "all venues" : `${u.locationIds.length} venue(s)`;
      console.log(
        `  ${u.disabled ? "·" : "✓"} ${u.email.padEnd(32)} ${u.role.padEnd(8)} ${venues}`,
      );
    }
    console.log("");
    break;
  }

  case "add": {
    if (!email || !password) bail("Usage: npm run user -- add <email> <password> [role]");
    const result = createUser({
      email,
      name: email.split("@")[0],
      password,
      role: (role as Role) ?? "staff",
// An account added from the shell gets no venues unless it is an owner;
      // assign them in the dashboard.
      locationIds: [],
    });
    if (!result.ok) bail(result.error);
    console.log(`\n  Added ${result.user.email} as ${result.user.role}.\n`);
    break;
  }

  case "reset": {
    if (!email || !password) bail("Usage: npm run user -- reset <email> <password>");
    const user = findUserByEmail(email);
    if (!user) bail(`No account for ${email}.`);
    const result = setPassword(user, password);
    if (!result.ok) bail(result.error ?? "Could not set that password.");
    console.log(`\n  Password changed for ${email}. Every other session was signed out.\n`);
    break;
  }

  case "disable":
  case "enable": {
    if (!email) bail(`Usage: npm run user -- ${command} <email>`);
    const user = findUserByEmail(email);
    if (!user) bail(`No account for ${email}.`);
    saveUser({ ...user, disabled: command === "disable" });
    console.log(`\n  ${email} is now ${command}d.\n`);
    break;
  }

  default:
    console.log(`
  npm run user -- list
  npm run user -- add <email> <password> [owner|manager|staff]
  npm run user -- reset <email> <password>
  npm run user -- disable <email>
  npm run user -- enable <email>
`);
}
