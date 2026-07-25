# MLB Telegram Signals Bot — CONTEXT

## Lo esencial

| | |
|---|---|
| **Qué es** | Bot de Telegram personal que cruza stats de MLB con cuotas de casa de apuestas y manda señales de valor (moneyline, totales, hits de bateador, ponches de pitcher) |
| **Repo local** | `C:\Users\anton\OneDrive\Escritorio\MLB` |
| **GitHub** | `https://github.com/antoniovolcan/antoniosignals` (rama `master`) |
| **Deploy** | Vercel, proyecto `antoniovolcans-projects/mlb-telegram-signals`, plan **Hobby (gratis)** — límite duro de 10s por función |
| **URL producción** | `https://mlb-telegram-signals.vercel.app` |
| **Stack** | Node.js (ESM), Vercel serverless, Supabase (Postgres), Telegram Bot API, The Odds API, MLB Stats API (`statsapi.mlb.com`) |
| **Tests** | `npm test` → `node --test lib/*.test.js` (~118 tests, solo lógica pura, sin red) |
| **Git** | Antonio Volcan / soyvolcom@gmail.com. Commits directos a `master` (proyecto personal, sin PRs) |
| **Regla** | Cada cambio: implementar → revisar (spec + calidad) → `git push` → `vercel --prod --yes` → verificar con datos reales |

---

## Variables de entorno (`.env` local, y en Vercel → Environment Variables)

```
TELEGRAM_BOT_TOKEN     # bot @Paynesignalsbot (BotFather)
TELEGRAM_CHAT_ID       # chat del usuario (7376496117)
ODDS_API_KEY           # the-odds-api.com — CUIDADO: cuota limitada, se agota fácil con pruebas manuales
SUPABASE_URL           # https://rxckhorulnxaiwbsmpzq.supabase.co
SUPABASE_SERVICE_KEY   # service_role key (NO la anon)
CRON_SECRET            # protege /api/scan y /api/nightly-report de llamadas externas no autorizadas
```

Para correr localmente con datos reales: `node --env-file=.env -e "..."` (Node 20+ soporta `--env-file` nativo).

---

## Estructura del código

```
lib/
  signals.js      # heurística pura (sin red): probabilidades, log5, Poisson, grading, blending
  mlb.js          # cliente statsapi.mlb.com — fetch + parse separados
  odds.js         # cliente The Odds API
  db.js           # cliente Supabase (todas las queries)
  telegram.js     # sendTelegramMessage, sendTelegramDocument (multipart)
  *.test.js       # tests unitarios de las funciones puras (parsers/heurística), sin red

api/
  scan.js               # cron principal: analiza juegos del día, genera y guarda señales, manda documento .txt agrupado
  telegram-webhook.js   # comandos: /hoy /senales /partido /config edge
  nightly-report.js     # corre de madrugada: califica señales de ayer vs resultado real, manda reporte

scripts/
  backtest.js     # backtesting histórico manual (direccional, sin ROI real — sin odds históricas)

supabase/
  schema.sql              # schema completo (referencia, ya no se re-ejecuta)
  migrations/*.sql         # migraciones incrementales ya aplicadas a la BD real

docs/
  superpowers/specs/       # spec de diseño original
  superpowers/plans/       # plan de implementación original
  MODEL_INPUTS.md          # *** referencia de qué stats usa cada señal — CONSULTAR ANTES DE TOCAR EL MODELO ***
```

## Tablas en Supabase

- `games` — juegos del día + `last_scanned_at` (para resumir un scan cortado a mitad)
- `signals` — cada señal enviada: market, selection, odds, probabilidades, `line`, `subject_id` (para calificar después), `hit`/`actual_value`/`graded_at` (llenado por nightly-report)
- `results` — resultado final de cada juego (llenado por nightly-report)
- `config` — `edge_threshold` (ajustable con `/config edge N`)
- `team_map` / `player_map` — existen en schema pero **no se usan** todavía (nombres MLB vs Odds API coinciden directo por ahora)

## Cron jobs externos (cron-job.org, porque Vercel Hobby no permite cron cada hora)

1. `https://mlb-telegram-signals.vercel.app/api/scan?secret=<CRON_SECRET>` — cada hora
2. `https://mlb-telegram-signals.vercel.app/api/nightly-report?secret=<CRON_SECRET>` — ~madrugada, después de medianoche

---

## Comandos de Telegram

- `/hoy` — juegos del día
- `/senales` — corre el análisis completo bajo demanda (mismo código que el cron), pero siempre en modo `force`: ignora el flag "ya escaneado hoy" y re-analiza todos los juegos programados con datos/cuotas frescos, sin importar cuántas veces se llame ni el gasto de cuota de Odds API
- `/partido <equipo>` — estado rápido de un juego (no corre análisis completo)
- `/config edge <0-1>` — cambia el umbral mínimo de edge (default 0.05 = 5%)

---

## Qué usa cada señal (resumen — ver `docs/MODEL_INPUTS.md` para detalle completo)

- **Moneyline**: ERA temporada+reciente (60/40) de cada abridor, récord últimos 10, localía, y **factor ofensivo** (OPS del lineup titular real vs. mano del pitcher rival). Probabilidad final limitada 30%-70% (evita exceso de confianza), combinada con fórmula log5.
- **Totales**: mismo ERA combinado + carreras/partido (temporada+últimos 15 días, 60/40) × factor ofensivo. Comparado contra la línea con curva normal.
- **Ponches del pitcher**: K/9 temporada+reciente (60/40), innings reales esperados por arranque (no fijo), tasa de ponches del lineup titular rival vs. la mano del pitcher. Poisson vs. la línea.
- **Hits del bateador**: AVG de temporada × turnos al bate por juego. Poisson vs. la línea. (Más simple, no usa desglose por mano todavía.)
- **Lineup titular real**: se saca del último partido REALMENTE jugado por el equipo (batting order real vía boxscore), con respaldo al roster completo si no hay partido reciente.

---

## Bugs importantes ya corregidos (por si algo se ve raro, revisar que no hayan regresado)

1. **Dedup de totales roto** — comparaba solo "Over"/"Under" sin la línea, nunca coincidía, reenviaba la misma señal cada hora. Corregido: ahora compara `${side} ${line.point}` completo.
2. **Moneyline con probabilidades irreales (90%+)** — el clamp de `teamWinProbability` era demasiado ancho (0.05-0.95). Corregido a (0.30, 0.70).
3. **Falsos aciertos en el reporte nocturno** — señales de totales sin `line` guardada (bug ya corregido en #1, datos viejos) se calificaban mal porque `actualValue > null` en JS es casi siempre `true`. Corregido: `gradeTotalsSignal`/`gradeOverSignal` devuelven `null` (no calificable) si falta la línea.
4. **Fallos silenciosos en Telegram** — si un comando fallaba (ej. cuota de Odds API agotada), el bot no avisaba nada. Corregido: ahora manda un mensaje de error al usuario.

## Limitaciones conocidas / pendientes (a discutir)

- **El cron automático** no re-analiza un juego "ya escaneado hoy" el resto del día, aunque cambien las cuotas más tarde. *(`/senales` sí re-analiza siempre, ver arriba — este límite solo aplica al cron horario.)*
- **Volumen de llamadas a la API de MLB muy alto por partido** (~30-40 llamadas: ERA, K9, roster, lineup, OPS vs mano, etc.) — riesgo real de timeout en el plan gratis de Vercel (10s duro). Ya se aceptó este riesgo; el sistema de "resumir" (`last_scanned_at`) mitiga la pérdida de trabajo si se corta.
- **Datos de pruebas del 2026-07-24 en la tabla `signals` están contaminados** (duplicados y algunas calificaciones incorrectas de antes del fix) — se dejaron sin borrar a propósito, no confiar en el % de acierto de ese día específico.
- **Hits del bateador** no usa desglose por mano del pitcher todavía (los otros 3 mercados sí) — candidato a mejorar con la misma técnica.
- **Bullpen** (relevistas) no se usa en ninguna señal — solo se mira al abridor.
- **Clima, parque de juego, umpire** — no implementado, requeriría una API externa nueva.
- **Cuota de The Odds API se agota fácil** con pruebas manuales repetidas — evitar correr `runScan()` manualmente muchas veces seguidas salvo que sea necesario.

## Cómo retomar en una sesión nueva

1. Lee este archivo + `docs/MODEL_INPUTS.md`.
2. `cd C:\Users\anton\OneDrive\Escritorio\MLB && npm test` para confirmar que todo sigue verde.
3. Si vas a probar con datos reales: `node --env-file=.env -e "import('./api/scan.js').then(({runScan}) => runScan().then(r=>console.log(r)))"` — con cuidado de no gastar cuota de Odds API innecesariamente.
4. Cualquier cambio: implementar → revisar → `git push` → `vercel --prod --yes` → verificar.
