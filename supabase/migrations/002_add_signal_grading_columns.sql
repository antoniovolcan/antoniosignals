alter table signals add column if not exists line numeric;
alter table signals add column if not exists subject_id bigint;
alter table signals add column if not exists hit boolean;
alter table signals add column if not exists actual_value text;
alter table signals add column if not exists graded_at timestamptz;
