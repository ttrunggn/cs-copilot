import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { authorize, HttpError, sha256Hex } from "../_shared/auth.ts";
import type { Db } from "../_shared/db.ts";
import type { Workspace } from "../_shared/types.ts";

const WS: Workspace = { website_id: "ws1", name: "App A", topics: [], default_profile: {} };
const TOKEN = "tok-lan";

async function fakeDb(member = true): Promise<Db> {
  const lanHash = await sha256Hex(TOKEN);
  return {
    getWorkspace: (id) => Promise.resolve(id === "ws1" ? WS : null),
    getOperatorIdByTokenHash: (h) => Promise.resolve(h === lanHash ? "op-lan" : null),
    isOperatorMember: () => Promise.resolve(member),
    getConversation: () => Promise.resolve(null),
    getMessages: () => Promise.resolve([]),
    getProfiles: () => Promise.resolve([]),
    getOperator: () => Promise.resolve(null),
  };
}

async function status(p: Promise<unknown>): Promise<number> {
  const e = await assertRejects(() => p, HttpError);
  return (e as HttpError).status;
}

Deno.test("sha256Hex matches known vector", async () => {
  assertEquals(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

Deno.test("missing token -> 401", async () => {
  assertEquals(await status(authorize(await fakeDb(), { website_id: "ws1", token: "" })), 401);
});

Deno.test("missing website_id -> 400", async () => {
  assertEquals(await status(authorize(await fakeDb(), { website_id: "", token: TOKEN })), 400);
});

Deno.test("unknown token -> 401", async () => {
  assertEquals(await status(authorize(await fakeDb(), { website_id: "ws1", token: "stolen?" })), 401);
});

Deno.test("unknown workspace -> 404", async () => {
  assertEquals(await status(authorize(await fakeDb(), { website_id: "nope", token: TOKEN })), 404);
});

Deno.test("operator not in workspace -> 403", async () => {
  assertEquals(await status(authorize(await fakeDb(false), { website_id: "ws1", token: TOKEN })), 403);
});

Deno.test("valid token returns workspace and operator", async () => {
  assertEquals(await authorize(await fakeDb(), { website_id: "ws1", token: TOKEN }), { workspace: WS, operatorId: "op-lan" });
});
