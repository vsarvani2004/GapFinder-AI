-- Required by the upload recovery UI. Safe to run on existing deployments.
alter table public.study_materials
  add column if not exists processing_error text;
