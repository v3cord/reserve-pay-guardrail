import { subscribeToUpdates } from '@/lib/events';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const stream = new ReadableStream({
    start(controller) {
      const listener = () => {
        try {
          controller.enqueue('data: update\n\n');
        } catch {
          // ignore
        }
      };

      const unsubscribe = subscribeToUpdates(listener);

      // Keep-alive heartbeat
      const interval = setInterval(() => {
        try {
          controller.enqueue(': keep-alive\n\n');
        } catch {
          clearInterval(interval);
        }
      }, 15000);

      req.signal.addEventListener('abort', () => {
        unsubscribe();
        clearInterval(interval);
      });
    },
  });

  return new Response(stream.pipeThrough(new TextEncoderStream()), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
