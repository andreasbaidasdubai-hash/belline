import { publicBelle } from "@/lib/belle/identity";
import BelleLauncher, { type LauncherPage } from "./BelleLauncher";

/**
 * Belle on one of Belline's own public pages, in sales mode, when Belline's
 * website chat can open. Server-rendered: whether video is offered and her
 * face are decided here, never in the browser.
 */
export default function BelleForVisitors({ page, plan }: { page: LauncherPage; plan?: string }) {
  const belle = publicBelle();
  if (!belle) return null;
  return <BelleLauncher page={page} plan={plan} video={belle.video} faceUrl={belle.faceUrl} />;
}
