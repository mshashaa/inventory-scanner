alter table public.inventory_items
  add column if not exists brand text not null default '',
  add column if not exists description text not null default '',
  add column if not exists category text not null default '',
  add column if not exists size text not null default '',
  add column if not exists ai_analyzed_at timestamptz,
  add column if not exists ai_status text not null default '';

grant select, insert, update on public.inventory_items to anon;
