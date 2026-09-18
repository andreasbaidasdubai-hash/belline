"use client";

import VideoPanel from "@/app/embed/[key]/video/VideoPanel";

/**
 * Belle's video call, as Ask Belle frames it.
 *
 * The panel lives in an iframe and the chat lives in the dashboard around it,
 * so "Continue in chat" cannot be a navigation or a call into a sibling
 * component: it is a message to the dock, which switches its own view back and
 * carries the call's turns into the conversation.
 *
 * Without this the owner met the worst version of an early end — a frame that
 * said the call had ended and offered only Start again, with the way back to
 * chat a button in a header outside the frame that nothing pointed at.
 */

/** What the dock listens for (setup/BelleDock.tsx). */
export const BELLE_VIDEO_MESSAGE = "belline.belle.video";

export default function BelleVideoFrame(props: React.ComponentProps<typeof VideoPanel>) {
  return (
    <VideoPanel
      {...props}
      onChat={(recap) => {
        // Same-origin by construction: /embed is framed by our own pages only
        // (frame-ancestors 'self'), and the dock checks the origin again.
        window.parent?.postMessage({ type: BELLE_VIDEO_MESSAGE, action: "chat", recap }, window.location.origin);
      }}
    />
  );
}
