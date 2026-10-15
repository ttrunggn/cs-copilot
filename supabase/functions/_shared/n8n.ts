export interface N8n {
  refreshConversation(websiteId: string, sessionId: string): Promise<{ stale: boolean }>;
  postNote(websiteId: string, sessionId: string, content: string): Promise<boolean>;
}

const BOT_MARK = "🤖";

/** n8n trả 200 body rỗng khi workflow lỗi trước node Respond, nên chỉ tin body {"ok": true}. */
async function confirmed(res: Response): Promise<boolean> {
  if (!res.ok) {
    await res.body?.cancel();
    return false;
  }
  try {
    return (await res.json())?.ok === true;
  } catch {
    return false;
  }
}

export function createN8n(opts: {
  baseUrl: string;
  secret: string;
  fetch?: typeof fetch;
  refreshTimeoutMs?: number;
}): N8n {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.refreshTimeoutMs ?? 3000;

  function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return doFetch(`${opts.baseUrl}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-copilot-secret": opts.secret },
      body: JSON.stringify(body),
      signal,
    });
  }

  return {
    async refreshConversation(websiteId, sessionId) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await post("copilot-refresh", { website_id: websiteId, session_id: sessionId }, ctrl.signal);
        return { stale: !(await confirmed(res)) };
      } catch {
        return { stale: true };
      } finally {
        clearTimeout(timer);
      }
    },

    async postNote(websiteId, sessionId, content) {
      const text = content.startsWith(BOT_MARK) ? content : `${BOT_MARK} ${content}`;
      try {
        const res = await post("copilot-post-note", { website_id: websiteId, session_id: sessionId, content: text });
        return await confirmed(res);
      } catch {
        return false;
      }
    },
  };
}
