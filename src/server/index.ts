import { port } from "./config";
import { AuthService } from "./auth";
import { createApi } from "./api";
import { Scheduler } from "./scheduler";
import { BookingExecutor } from "./booking";

const auth = new AuthService();
const scheduler = new Scheduler(auth, new BookingExecutor(auth.client));
const api = createApi(auth, scheduler);
scheduler.start();
void auth.restore();

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
      const relative = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(`dist/web${relative}`);
      if (await file.exists()) return new Response(file);
      const shell = Bun.file("dist/web/index.html");
      if (await shell.exists()) return new Response(shell);
    }
    if (request.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS" } });
    let response: Response;
    try {
      response = await api(request);
    } catch (error) {
      console.error(error);
      response = Response.json({ detail: error instanceof Error ? error.message : "内部服务错误" }, { status: 502 });
    }
    response.headers.set("Access-Control-Allow-Origin", "*");
    return response;
  },
});

console.log(`HDU Library Sniper server listening on ${server.url}`);
