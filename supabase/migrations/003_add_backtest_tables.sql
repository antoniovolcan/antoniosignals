-- Backtesting: walk-forward accuracy tracking, independent of odds/edge/ROI.
-- backtest_runs: one row per full backtest execution (a date range tested with a given model version note).
-- backtest_predictions: one row per individual prediction made during that run, graded against the real outcome.
create table backtest_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  from_date date not null,
  to_date date not null,
  model_note text,
  finished_at timestamptz
);

create table backtest_predictions (
  id bigserial primary key,
  run_id bigint not null references backtest_runs(id) on delete cascade,
  game_pk bigint not null,
  game_date date not null,
  market text not null,
  selection text,
  subject_id bigint,
  home_team text not null,
  away_team text not null,
  projected_value numeric,
  projected_prob numeric,
  actual_value numeric,
  actual_outcome boolean,
  factors jsonb,
  created_at timestamptz not null default now()
);

create index backtest_predictions_run_id_idx on backtest_predictions (run_id);
create index backtest_predictions_market_idx on backtest_predictions (market);
create index backtest_predictions_game_date_idx on backtest_predictions (game_date);
