// Đồng bộ helpdesk một lần từ máy local (cùng logic với workflow n8n helpdesk-sync): chỉ bài published,
// chỉ tải lại bài đã đổi, xoá bài không còn trong danh sách. Dùng để seed lần đầu hoặc khi n8n chưa import.
// Chạy: node --env-file=.env scripts/helpdesk-sync.mjs <website_id> [locale]
const [websiteId, locale = "en"] = process.argv.slice(2);
const { CRISP_IDENTIFIER, CRISP_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!websiteId || !CRISP_IDENTIFIER || !CRISP_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Cần website_id và CRISP_IDENTIFIER, CRISP_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY trong .env");
}
const crispHeaders = {
  authorization: "Basic " + Buffer.from(`${CRISP_IDENTIFIER}:${CRISP_KEY}`).toString("base64"),
  "x-crisp-tier": "plugin",
};
const crisp = async (path) => {
  const r = await fetch(`https://api.crisp.chat/v1/website/${websiteId}/helpdesk/locale/${locale}${path}`, { headers: crispHeaders });
  if (!r.ok && r.status !== 206) throw new Error(`Crisp ${path} → ${r.status}`);
  return (await r.json()).data;
};
const rpc = async (fn, body) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${fn} → ${r.status} ${await r.text()}`);
  return r.json();
};

const meta = {};
const list = [];
for (let page = 1; page <= 50; page++) {
  const data = await crisp(`/articles/${page}`);
  if (!Array.isArray(data) || !data.length) break;
  for (const a of data) {
    if (a.status !== "published" || meta[a.article_id]) continue;
    meta[a.article_id] = { title: a.title || "", url: a.url || "", category: a.category?.name ?? null };
    list.push({ article_id: a.article_id, updated_at: a.updated_at || 0 });
  }
}
console.log(`published: ${list.length}`);
const stale = await rpc("helpdesk_stale_articles", { p_website_id: websiteId, p_locale: locale, p_list: list });
console.log(`changed: ${stale.length}`);

const articles = [];
for (const id of stale) {
  try {
    const a = await crisp(`/article/${id}`);
    if (a?.status !== "published") continue;
    articles.push({ article_id: id, title: a.title || meta[id].title, url: a.url || meta[id].url, category: meta[id].category, content: a.content || "", updated_at: a.updated_at || 0 });
  } catch (e) {
    console.warn(`skip ${id}: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 200));
}
for (let i = 0; i < articles.length; i += 50) {
  const n = await rpc("upsert_helpdesk_articles", { p_website_id: websiteId, p_locale: locale, p_articles: articles.slice(i, i + 50) });
  console.log(`upserted ${i + n}/${articles.length}`);
}
