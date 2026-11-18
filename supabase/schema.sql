-- GapFinder AI schema. Run in the Supabase SQL editor as project owner.
create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.study_materials (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  name text not null, mime_type text not null, size_bytes bigint not null check(size_bytes > 0),
  storage_path text not null unique, status text not null default 'processing' check(status in ('processing','ready','failed')),
  processing_error text, created_at timestamptz not null default now()
);
-- Also upgrades projects that ran an earlier version of this schema.
alter table public.study_materials add column if not exists processing_error text;
create table if not exists public.topics (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  material_id uuid not null references public.study_materials(id) on delete cascade, name text not null,
  section text, created_at timestamptz not null default now(), unique(material_id,name)
);
create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  material_id uuid not null references public.study_materials(id) on delete cascade, chunk_index integer not null,
  content text not null, section text, embedding extensions.vector(1536) not null,
  created_at timestamptz not null default now(), unique(material_id,chunk_index)
);
create table if not exists public.quiz_attempts (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  score integer check(score between 0 and 100), total_questions integer not null default 0,
  status text not null default 'in_progress' check(status in ('in_progress','completed')),
  created_at timestamptz not null default now(), completed_at timestamptz
);
create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(), attempt_id uuid not null references public.quiz_attempts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, topic_id uuid not null references public.topics(id) on delete cascade,
  kind text not null check(kind in ('mcq','true_false','short')), prompt text not null,
  options jsonb not null default '[]'::jsonb, correct_answer text not null, explanation text not null, source text,
  created_at timestamptz not null default now()
);
create table if not exists public.student_answers (
  id uuid primary key default gen_random_uuid(), attempt_id uuid not null references public.quiz_attempts(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, answer_text text not null default '',
  score numeric(3,2) not null check(score between 0 and 1), feedback text not null, created_at timestamptz not null default now(),
  unique(attempt_id,question_id)
);
create table if not exists public.topic_performance (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade, score integer not null check(score between 0 and 100),
  classification text not null check(classification in ('weak','medium','strong')), correct_answers integer not null default 0,
  incorrect_answers integer not null default 0, reason text not null, updated_at timestamptz not null default now(), unique(user_id,topic_id)
);
create table if not exists public.revision_plans (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  available_minutes integer not null default 60, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.revision_tasks (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid references public.revision_plans(id) on delete cascade, topic_id uuid not null references public.topics(id) on delete cascade,
  title text not null, duration_minutes integer not null default 25, completed boolean not null default false,
  created_at timestamptz not null default now(), completed_at timestamptz
);
create table if not exists public.progress_history (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade, score integer not null check(score between 0 and 100),
  recorded_at timestamptz not null default now()
);

create index if not exists chunks_user_idx on public.document_chunks(user_id);
create index if not exists chunks_material_idx on public.document_chunks(material_id);
create index if not exists chunks_embedding_idx on public.document_chunks using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists topics_user_idx on public.topics(user_id);
create index if not exists attempts_user_date_idx on public.quiz_attempts(user_id,created_at desc);
create index if not exists progress_user_date_idx on public.progress_history(user_id,recorded_at desc);
create index if not exists tasks_user_idx on public.revision_tasks(user_id,completed);

create or replace function public.match_document_chunks(query_embedding extensions.vector(1536), match_threshold float, match_count int, filter_user_id uuid)
returns table(id uuid, material_id uuid, content text, section text, source_name text, similarity float)
language sql stable security invoker set search_path=public,extensions as $$
  select c.id,c.material_id,c.content,c.section,m.name,
    1-(c.embedding <=> query_embedding) as similarity
  from public.document_chunks c join public.study_materials m on m.id=c.material_id
  where c.user_id=filter_user_id and c.user_id=auth.uid()
    and 1-(c.embedding <=> query_embedding)>=match_threshold
  order by c.embedding <=> query_embedding limit least(match_count,20);
$$;

alter table public.profiles enable row level security;
alter table public.study_materials enable row level security;
alter table public.topics enable row level security;
alter table public.document_chunks enable row level security;
alter table public.quiz_attempts enable row level security;
alter table public.questions enable row level security;
alter table public.student_answers enable row level security;
alter table public.topic_performance enable row level security;
alter table public.revision_plans enable row level security;
alter table public.revision_tasks enable row level security;
alter table public.progress_history enable row level security;

do $$ declare t text; begin
  foreach t in array array['study_materials','topics','document_chunks','quiz_attempts','questions','student_answers','topic_performance','revision_plans','revision_tasks','progress_history'] loop
    execute format('drop policy if exists owner_all on public.%I',t);
    execute format('create policy owner_all on public.%I for all using (auth.uid()=user_id) with check (auth.uid()=user_id)',t);
  end loop;
end $$;
drop policy if exists profile_owner on public.profiles;
create policy profile_owner on public.profiles for all using(auth.uid()=id) with check(auth.uid()=id);

-- Keep the private bucket private. The server uploads with the service role and
-- the API only returns a user's own material rows.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('study-materials','study-materials',false,15728640,array['application/pdf','text/plain'])
on conflict(id) do update set public=false,file_size_limit=15728640;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
begin insert into public.profiles(id,full_name) values(new.id,new.raw_user_meta_data->>'full_name') on conflict(id) do nothing; return new; end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();
