import { assertEquals } from "jsr:@std/assert@1";
import { FRESH_MS, loadConversationFast } from "../copilot/load.ts";
import { CONV, makeDeps } from "./fakes.ts";

const NOW = Date.parse("2026-10-15T03:10:00+00:00");

function depsWith(convUpdatedAt: string | null, background?: (p: Promise<unknown>) => void) {
  let refreshes = 0;
  const { deps } = makeDeps({
    db: { getConversation: () => Promise.resolve({ ...CONV, updated_at: convUpdatedAt }) },
  });
  deps.n8n.refreshConversation = () => {
    refreshes++;
    return Promise.resolve({ stale: false });
  };
  return { deps: { ...deps, background, now: () => NOW }, refreshes: () => refreshes };
}

Deno.test("fast path: bản ghi còn tươi thì không refresh, stale=false", async () => {
  const fresh = new Date(NOW - FRESH_MS / 2).toISOString();
  const { deps, refreshes } = depsWith(fresh, () => {});
  const r = await loadConversationFast(deps, "ws1", "session_1");
  assertEquals(r.stale, false);
  assertEquals(refreshes(), 0);
  assertEquals(r.conv.session_id, "session_1");
});

Deno.test("fast path: bản ghi cũ thì trả ngay kèm stale=true và refresh chạy nền", async () => {
  const old = new Date(NOW - FRESH_MS * 10).toISOString();
  const bg: Promise<unknown>[] = [];
  const { deps, refreshes } = depsWith(old, (p) => bg.push(p));
  const r = await loadConversationFast(deps, "ws1", "session_1");
  assertEquals(r.stale, true);
  assertEquals(bg.length, 1);
  await bg[0];
  assertEquals(refreshes(), 1);
});

Deno.test("fast path: chưa có bản ghi thì refresh đồng bộ như cũ", async () => {
  const { deps } = makeDeps({ db: { getConversation: () => Promise.resolve(null) } });
  let refreshes = 0;
  deps.n8n.refreshConversation = () => {
    refreshes++;
    return Promise.resolve({ stale: false });
  };
  // Sau refresh vẫn không có bản ghi → 404 như hành vi cũ.
  let status = 0;
  try {
    await loadConversationFast({ ...deps, now: () => NOW }, "ws1", "session_1");
  } catch (e) {
    status = (e as { status?: number }).status ?? 0;
  }
  assertEquals(refreshes, 1);
  assertEquals(status, 404);
});
