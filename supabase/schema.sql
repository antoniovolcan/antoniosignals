create table games (
  game_pk bigint primary key,
  date date not null,
  home_team text not null,
  away_team text not null,
  status text not null default 'scheduled',
  created_at timestamptz not null default now(),
  last_scanned_at timestamptz
);

create table team_map (
  mlb_team text primary key,
  odds_team text
);

create table player_map (
  mlb_player_id bigint primary key,
  mlb_name text not null,
  odds_name text
);

create table signals (
  id bigserial primary key,
  game_pk bigint not null references games(game_pk),
  market text not null,
  selection text not null,
  odds_price numeric not null,
  implied_prob numeric not null,
  estimated_prob numeric not null,
  edge numeric not null,
  reasoning text not null,
  sent_at timestamptz not null default now(),
  line numeric,
  subject_id bigint,
  hit boolean,
  actual_value text,
  graded_at timestamptz
);

create table results (
  game_pk bigint primary key references games(game_pk),
  home_score int,
  away_score int,
  final boolean not null default false,
  updated_at timestamptz not null default now()
);

create table config (
  key text primary key,
  value text not null
);

insert into config (key, value) values ('edge_threshold', '0.05');
