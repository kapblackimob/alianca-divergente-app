-- Aliança Divergente App — esquema do banco de dados
-- Uma única tabela genérica (chave/valor) guarda todos os módulos do app,
-- isolada por usuário através de Row Level Security.

create table if not exists public.user_data (
  user_id uuid references auth.users(id) on delete cascade not null,
  data_key text not null,
  data_value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, data_key)
);

alter table public.user_data enable row level security;

create policy "select_own_data"
  on public.user_data for select
  using (auth.uid() = user_id);

create policy "insert_own_data"
  on public.user_data for insert
  with check (auth.uid() = user_id);

create policy "update_own_data"
  on public.user_data for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "delete_own_data"
  on public.user_data for delete
  using (auth.uid() = user_id);

-- Controle de uso diário do Coach IA (chave de API centralizada, paga pelo dono do app).
-- Só a Edge Function (service_role) lê/escreve aqui; usuários não têm acesso direto.
create table if not exists public.chat_usage (
  user_id uuid references auth.users(id) on delete cascade not null,
  day date not null,
  count int not null default 0,
  primary key (user_id, day)
);

alter table public.chat_usage enable row level security;
-- Nenhuma policy criada de propósito: RLS ativo bloqueia todo acesso via chave anon/pública;
-- a Edge Function usa a service_role key, que ignora RLS.
