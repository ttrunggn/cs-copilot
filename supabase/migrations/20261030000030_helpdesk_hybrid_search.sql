-- Hybrid search cho helpdesk (Ethan chốt 2026-10-27, thay tầng ILIKE của
-- ask): vector (pgvector) + full-text search (tsvector 'english' — có
-- stemming, xếp hạng) gộp hạng bằng Reciprocal Rank Fusion (k=60).
-- ILIKE cũ không stemming/không hạng/chỉ chạy khi vector trượt hẳn nên câu
-- hỏi đời thường (từ đồng nghĩa, khác dạng từ) trượt cả hai đường.

-- Cột fts là GENERATED: chunk ghi mới qua replace_helpdesk_chunks tự có
-- giá trị, khỏi sửa đường ingest/embed; dữ liệu sẵn có được Postgres tính
-- ngay khi thêm cột.
alter table public.helpdesk_chunks
  add column fts tsvector generated always as (to_tsvector('english', text)) stored;

create index helpdesk_chunks_fts_idx on public.helpdesk_chunks using gin (fts);

-- similarity = cosine của phía vector (0 khi đoạn chỉ khớp FTS nhưng nằm
-- ngoài top vector); fts_rank null = đoạn không khớp full-text. score là
-- điểm RRF đã gộp, chỉ để xếp hạng ứng viên đưa cho AI phán quyết.
create function public.hybrid_match_helpdesk(
  p_website_id text,
  p_query text,
  p_embedding extensions.vector(768),
  p_k int,
  p_candidates int default 24
)
returns table (title text, url text, text text, similarity float, score float, fts_rank int)
language sql stable security definer set search_path = public, extensions as $$
  with vec as (
    select c.article_pk, c.chunk_idx, 1 - (c.embedding <=> p_embedding) as sim,
           row_number() over (order by c.embedding <=> p_embedding) as rk
    from public.helpdesk_chunks c
    join public.helpdesk_articles a on a.id = c.article_pk
    where a.website_id = p_website_id
    order by c.embedding <=> p_embedding
    limit p_candidates
  ),
  fts as (
    select c.article_pk, c.chunk_idx,
           row_number() over (order by ts_rank(c.fts, q.query) desc) as rk
    from public.helpdesk_chunks c
    join public.helpdesk_articles a on a.id = c.article_pk
    cross join (select websearch_to_tsquery('english', coalesce(p_query, '')) as query) q
    where a.website_id = p_website_id and c.fts @@ q.query
    order by ts_rank(c.fts, q.query) desc
    limit p_candidates
  ),
  fused as (
    select coalesce(v.article_pk, f.article_pk) as article_pk,
           coalesce(v.chunk_idx, f.chunk_idx) as chunk_idx,
           coalesce(v.sim, 0) as sim,
           (coalesce(1.0 / (60 + v.rk), 0) + coalesce(1.0 / (60 + f.rk), 0))::float as rrf,
           f.rk as fts_rk
    from vec v
    full outer join fts f on f.article_pk = v.article_pk and f.chunk_idx = v.chunk_idx
  )
  select a.title, a.url, c.text, fused.sim::float, fused.rrf, fused.fts_rk
  from fused
  join public.helpdesk_chunks c on c.article_pk = fused.article_pk and c.chunk_idx = fused.chunk_idx
  join public.helpdesk_articles a on a.id = c.article_pk
  order by fused.rrf desc
  limit p_k
$$;

revoke execute on function public.hybrid_match_helpdesk(text, text, extensions.vector, int, int) from public, anon, authenticated;
