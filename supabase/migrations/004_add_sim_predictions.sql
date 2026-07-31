create table sim_predictions (
  id bigint generated always as identity primary key,
  date date not null,
  home_team text not null,
  away_team text not null,
  home_pitcher text,
  away_pitcher text,
  home_win_pct numeric not null,
  away_win_pct numeric not null,
  sims integer not null,
  created_at timestamptz not null default now(),
  unique (date, home_team, away_team)
);
