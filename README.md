# MLB Telegram Signals Bot

Personal Telegram bot that cross-references MLB stats with betting odds (The Odds API)
to surface value-bet signals. See `docs/superpowers/specs/2026-07-22-telegram-mlb-signals-bot-design.md`
for the full design.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in credentials.
3. Run `npm test` to run the unit test suite (pure logic only, no network/DB needed).

## Notes

- `vercel.json` sets `maxDuration: 60` for `api/scan.js` and `api/telegram-webhook.js` since a full scan can involve many sequential external API calls on a busy game day. This requires a Vercel Pro plan (Hobby is capped at 10s regardless of this setting).
