// Worker のエントリ（fetch / scheduled）
import { Hono } from "hono";
import type { Env } from "./env";
import { api } from "./api";
import { runCron } from "./cron";
import { handleInteraction } from "./discord/interactions";
import { verifyDiscordRequest } from "./discord/verify";
import { AppError, isQuotaError, nowSec, QUOTA_MESSAGE, randomToken } from "./lib";

/** すべての応答に付けるセキュリティヘッダー（docs/security-design.md §4.2） */
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'; upgrade-insecure-requests",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  const res = new Response(c.res.body, c.res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  c.res = res;
});

app.onError((err, c) => {
  if (err instanceof AppError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
  if (isQuotaError(err)) return c.json({ error: { code: "free_tier_exceeded", message: QUOTA_MESSAGE } }, 503);
  const ref = randomToken(6);
  console.error(JSON.stringify({ event: "unhandled_error", ref, error: err instanceof Error ? err.message : "unknown" }));
  return c.json({ error: { code: "internal", message: `エラーが発生しました。時間をおいてもう一度お試しください（参照番号: ${ref}）。` } }, 500);
});

app.post("/discord/interactions", async (c) => {
  const body = await verifyDiscordRequest(c.req.raw, c.env.DISCORD_PUBLIC_KEY, nowSec());
  if (body === null) return c.text("invalid request signature", 401);
  const interaction = JSON.parse(body);
  return handleInteraction(c.env, c.executionCtx, interaction, new URL(c.req.url).origin);
});

app.route("/api", api);

// Web 画面（S1〜S5・S7）は 1 つの HTML から表示する
async function appShell(c: { env: Env; req: { url: string } }): Promise<Response> {
  const res = await c.env.ASSETS.fetch(new Request(new URL("/app/", c.req.url)));
  return new Response(res.body, { status: res.ok ? 200 : 500, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
app.get("/l", (c) => appShell(c));
app.get("/p/:id", (c) => appShell(c));
app.get("/p/:id/:page{(edit|answer|done)}", (c) => appShell(c));

app.notFound((c) => c.text("Not Found", 404));

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
