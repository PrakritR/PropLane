import { buildLlmsTxt, LLMS_CACHE_CONTROL, llmsOrigin } from "@/lib/seo/llms";
import { BLOG_POSTS } from "@/lib/blog/posts";
import { liveRoomOccupancy } from "@/lib/marketing/track-record-live.server";

export const revalidate = 3600;

export async function GET() {
  return new Response(buildLlmsTxt(llmsOrigin(), BLOG_POSTS, await liveRoomOccupancy()), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": LLMS_CACHE_CONTROL,
    },
  });
}
