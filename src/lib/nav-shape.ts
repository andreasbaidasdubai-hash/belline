/**
 * The navigation's shape, and nothing that needs the server.
 *
 * Kept apart from nav.ts because the sidebar and the phone menu are client
 * components, and nav.ts decides with the store and the account's permissions,
 * neither of which belongs in a browser bundle.
 */

export interface NavItem {
  href: string;
  label: string;
  badge?: number;
  quiet?: boolean;
  /**
   * Other paths that belong to this destination, so the item is marked as the
   * page you are on from any of its tabs: Inbox from /conversations, Settings
   * from /billing.
   */
  match?: string[];
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

/** Is `item` the destination for this path? */
export function navItemOn(item: Pick<NavItem, "href" | "match">, pathname: string): boolean {
  const under = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  return under(item.href) || (item.match ?? []).some(under);
}
