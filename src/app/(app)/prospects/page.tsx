import { requireUser } from "@/lib/auth-server";
import { PageHeader } from "@/components/LocationTabs";
import Builder from "./Builder";

export const dynamic = "force-dynamic";

export default async function ProspectsPage() {
  await requireUser();

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
