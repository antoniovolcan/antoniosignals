# MLB Telegram Signals Bot

Personal Telegram bot that cross-references MLB stats with betting odds (The Odds API)
to surface value-bet signals. See `docs/superpowers/specs/2026-07-22-telegram-mlb-signals-bot-design.md`
for the full design.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in credentials.
3. Run `npm test` to run the unit test suite (pure logic only, no network/DB needed).
