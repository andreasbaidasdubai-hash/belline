import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth-server";
import { isBellineStaff } from "@/lib/auth";
import { PageHeader } from "@/components/LocationTabs";
import Builder from "./Builder";

export const dynamic = "force-dynamic";

export default async function ProspectsPage() {
  // A selling tool of ours, not a feature of theirs. Owner-only was not enough
  // once every signup became an owner.
  const user = await requireUser();
  if (!isBellineStaff(user)) notFound();

  return (
    <>
      <PageHeader
        title="Personalised demos"
        subtitle="Paste a prospect's website and send them a link that answers as their own business. The fastest way to end an argument about whether this is any good."
      />
      <Builder />
    </>
  );
}
