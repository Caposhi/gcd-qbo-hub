import { consoleAuthorized, recentEvents, subscribe, type ConsoleEvent } from "@/lib/console/contract";

// SSE needs the Node runtime and no static optimization.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!consoleAuthorized(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const program = url.searchParams.get("program");
  const since = Number(url.searchParams.get("since") ?? 0) || 0;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const write = (e: ConsoleEvent) => {
        if (program && e.program !== program) return;
        controller.enqueue(encoder.encode(`id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`));
      };
      controller.enqueue(encoder.encode(": connected\n\n"));
      for (const e of recentEvents(since)) write(e);

      const unsub = subscribe(write);
      const ping = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 20000);
      const close = () => {
        clearInterval(ping);
        unsub();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*",
    },
  });
}
