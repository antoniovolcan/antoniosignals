# MLB Telegram Signals Bot — CONTEXT

## Lo esencial

| | |
|---|---|
| **Qué es** | Bot de Telegram personal que cruza stats de MLB con cuotas de casa de apuestas y manda señales de valor (moneyline, totales, totales 1ras 5 entradas, ponches de pitcher). **Ya NO manda señales de hits de bateador** — se quitó a propósito. |
| **Repo local** | `C:\Users\anton\OneDrive\Escritorio\MLB` |
| **GitHub** | `https://github.com/antoniovolcan/antoniosignals` (rama `master`) |
| **Deploy** | Vercel, proyecto `antoniovolcans-projects/mlb-telegram-signals`, plan **Hobby (gratis)** — límite duro de 10s por función |
| **URL producción** | `https://mlb-telegram-signals.vercel.app` |
| **Dashboard de backtest** | `https://mlb-telegram-signals.vercel.app/backtest/` — protegido con `DASHBOARD_SECRET` (guardado en localStorage del navegador) |
| **Stack** | Node.js (ESM), Vercel serverless, Supabase (Postgres), Telegram Bot API, The Odds API, MLB Stats API (`statsapi.mlb.com`) |
| **Tests** | `npm test` → `node --test lib/**/*.test.js` (199 tests, solo lógica pura, sin red) |
| **Git** | Antonio Volcan / soyvolcom@gmail.com. Commits directos a `master` (proyecto personal, sin PRs) |
| **Regla** | Cada cambio: implementar → testear → `git push` → `vercel --prod --yes` → verificar con datos reales |

---

## Variables de entorno (`.env` local, y en Vercel → Environment Variables)

```
TELEGRAM_BOT_TOKEN     # bot @Paynesignalsbot (BotFather)
TELEGRAM_CHAT_ID       # chat del usuario (7376496117)
ODDS_API_KEY           # the-odds-api.com — CUIDADO: cuota limitada, se agota fácil con pruebas manuales
SUPABASE_URL           # https://rxckhorulnxaiwbsmpzq.supabase.co
SUPABASE_SERVICE_KEY   # service_role key (NO la anon)
CRON_SECRET            # protege /api/scan y /api/nightly-report de llamadas externas no autorizadas
DASHBOARD_SECRET       # protege /backtest/ y /api/backtest-data, /api/backtest-analyze
```

Para correr localmente con datos reales: `node --env-file=.env -e "..."` (Node 20+ soporta `--env-file` nativo).
El backtest y sus scripts **no gastan cuota de Odds API** — solo usan MLB Stats API (gratis, sin límite conocido).

---

## Estructura del código

```
lib/
  signals.js          # heurística pura: probabilidades, log5, Poisson, blending, projectedTotalRuns/F5, computeLineupOps
  mlb.js              # cliente statsapi.mlb.com — fetch + parse separados
  odds.js             # cliente The Odds API (incluye extractMarket, exportado para mercados no-featured como F5)
  db.js               # cliente Supabase (todas las queries, incluye paginación >1000 filas)
  telegram.js         # sendTelegramMessage, sendTelegramDocument (multipart)
  parkFactors.js       # tabla estática de factor de parque para ponches
  battingLedger.js     # libreta acumulada de stats reales bateador-vs-mano desde jugada-por-jugada (usada solo por el backtest)
  missAnalysis.js       # post-mortem de un fallo: trae jugada-por-jugada real y explica qué bateador lo causó
  backtestMetrics.js    # agregación de métricas (bias/MAE/RMSE/accuracy/Brier) sobre backtest_predictions
  *.test.js            # tests unitarios de las funciones puras, sin red

api/
  scan.js               # cron principal: analiza juegos del día, genera y guarda señales, manda documento .txt agrupado
  telegram-webhook.js   # comandos: /hoy /senales /partido /config edge
  nightly-report.js     # corre de madrugada: califica señales de ayer vs resultado real, manda reporte
  backtest-data.js      # API del dashboard: runs/summary/detail (protegido con DASHBOARD_SECRET)
  backtest-analyze.js   # API del botón "¿Por qué falló?" del dashboard (protegido con DASHBOARD_SECRET)

scripts/
  backtest.js               # backtest walk-forward oficial (día por día, sin fuga de datos, sin odds/edge/ROI)
  analyze-misses.js         # corre missAnalysis.js sobre todos los fallos de un run, agrega patrones por frecuencia
  backtest-season-glue.js   # EXPERIMENTO — pega temporada 2025 a 2026 para probar si ayuda en abril. No se usa en el bot.

public/backtest/
  index.html, dashboard.js  # dashboard web (HTML/CSS/JS plano, Chart.js vía CDN) — corridas, gráficas, tabla de Aciertos/Fallos

supabase/
  schema.sql              # schema completo (referencia, ya no se re-ejecuta)
  migrations/*.sql         # migraciones incrementales — la 003 (backtest_runs/backtest_predictions) hay que correrla a mano en el SQL Editor de Supabase, no hay forma de aplicarla por código

docs/
  superpowers/specs/       # spec de diseño original
  superpowers/plans/       # plan de implementación original
  MODEL_INPUTS.md          # referencia de qué stats usa cada señal — **desactualizado desde esta sesión, revisar antes de confiar en él**
```

## Tablas en Supabase

- `games` — juegos del día + `last_scanned_at`
- `signals` — cada señal enviada en producción (market, selection, odds, probabilidades, `line`, `subject_id`, `hit`/`actual_value`/`graded_at`)
- `results` — resultado final de cada juego
- `config` — `edge_threshold` (ajustable con `/config edge N`)
- `team_map` / `player_map` — sin usar todavía
- `backtest_runs` — una fila por corrida de backtest (fechas, `model_note` describiendo qué se probó)
- `backtest_predictions` — una fila por predicción individual del backtest (proyectado, real, `factors` en JSON con todos los valores intermedios) — **usar `getBacktestPredictions` de `lib/db.js`, no hacer `select` directo sin paginar** (Supabase corta en 1000 filas por default, ya arreglado ahí)

## Cron jobs externos (cron-job.org)

1. `.../api/scan?secret=<CRON_SECRET>` — cada hora
2. `.../api/nightly-report?secret=<CRON_SECRET>` — ~madrugada

## Comandos de Telegram

- `/hoy` — juegos del día
- `/senales` — corre el análisis completo bajo demanda, siempre en modo `force`: re-analiza todo con datos frescos y **actualiza** (no duplica) señales ya enviadas ese día, sin importar cuántas veces se llame
- `/partido <equipo>` — estado rápido de un juego
- `/config edge <0-1>` — umbral mínimo de edge (default 0.05)

---

## El modelo — estado actual (validado con 3 meses de backtest: mayo, junio, julio 2026)

**Moneyline**: ERA temporada+reciente (60/40, clamp de ratio 0.4-2.2 desde esta sesión — antes sin clamp, un ERA de muestra chica podía disparar proyecciones absurdas), récord últimos 10, localía, y **factor ofensivo individual por bateador** (ver abajo). Log5, probabilidad final 30-70%.

**Totales** (partido completo y **1ras 5 entradas**, nuevo esta sesión): mismo ERA clampeado + carreras/partido (temporada+15 días, 60/40) × factor ofensivo. F5 escala la misma fórmula a base de 5 entradas (5/9) en vez de modelar bullpen directamente.

**Ponches del pitcher**: K/9 temporada+reciente, innings reales (ajustados a la baja si el pitcher tiene mal ERA contra ofensiva fuerte — riesgo de salida corta), tasa de ponches + mezcla poder/contacto del lineup rival (todavía **promedio de equipo**, no individual — candidato a mejorar), factor de parque y clima (mejor esfuerzo).

**ERA y K/9 de carrera — nuevo esta sesión**: además del blend de siempre (reciente 60% + temporada 40%), ahora se re-blendea contra el ERA/K9 de **carrera** del pitcher (todas las temporadas regulares anteriores a la actual, sin incluir la actual) con un peso inicial de **10% carrera / 90% blend de siempre** (`CAREER_ERA_WEIGHT`/`CAREER_K9_WEIGHT = 0.9` en `signals.js`, aplicado como un segundo llamado a `blendEraEstimates` en cascada, no una función nueva). "Carrera" = suma de temporadas anteriores completas vía `stats=yearByYear` de MLB — deliberadamente excluye la temporada en curso para que sea el mismo dato tanto en vivo (`scan.js`) como en el backtest walk-forward (`scripts/backtest.js`, con `season` como corte, no la fecha del día), sin fuga de datos. Si el pitcher no tiene temporadas anteriores (su primera en MLB), el componente de carrera simplemente se omite (no se inventa un valor de reemplazo). **Validado con backtest de mayo (run #20 vs. baseline #15, mismo mes/config)**: con 10% de peso, moneyline accuracy 54.4%→55.1%, Brier casi igual (0.2560→0.2563), totales MAE 3.574→3.570, F5 MAE 2.496→2.495, ponches MAE 1.887→1.865 y bias 0.227→0.192 (más cerca de 0, la mejora más clara). Movimiento chico y en la dirección correcta en casi todo — esperable para un peso de partida del 10%. **Pendiente**: probar 20-30% en corridas adicionales antes de decidir el valor final. El OPS de carrera del bateador se decidió **no** tocarlo en esta sesión (fuera de alcance).

**Trampa encontrada al implementar carrera**: la API `yearByYear` de MLB devuelve una temporada con trade a mitad de año **más de una vez** — una fila por cada equipo, más una fila combinada (sin campo `team`) con el total real. Sumar todas las filas ciegamente triplicaría innings/ER/K de esa temporada. Se deduplicó quedándose solo con la fila combinada cuando existe (`dedupSeasonSplits` en `mlb.js`).

**Factor ofensivo — la pieza que más cambió esta sesión**: en vez de promediar el OPS de los 5 titulares contra la mano del pitcher (como al principio), ahora:
1. Se evalúan **9 bateadores** (lineup completo), cada uno con su OPS vs.-esa-mano mezclado 50/50 con su OPS general (para no confiar ciegamente en muestra chica de una sola temporada).
2. Se combina dándole **70% de peso a los 2 bateadores más peligrosos** y 30% al promedio del lineup completo (`computeLineupOps` en `signals.js`, `topN=2, topWeight=0.7`).
3. El resultado se compara contra `LEAGUE_AVG_TOP_WEIGHTED_OPS = 0.840` (**no** 0.720) — constante recalibrada a mano porque casi cualquier lineup real tiene variación interna, así que el paso 2 infla el número para casi cualquier equipo, no solo los buenos de verdad. Comparado contra el 0.720 viejo, el factor ofensivo promediaba 1.09-1.17 en vez de 1.0 — esa fue la causa real de que totales sobreestimara sistemáticamente. Con 0.840 el promedio real medido en mayo/junio/julio es 0.99-1.01.

**En vivo** (`scan.js`) esto se calcula con datos reales de la API sin restricción. **En el backtest** (`scripts/backtest.js`) la API de MLB no deja combinar "jugador individual" + "rango de fechas pasado" + "mano específica" a la vez, así que se construyó `lib/battingLedger.js`: una libreta que acumula AB/hits/HR/BB/K reales de cada bateador contra cada mano, procesando la jugada-por-jugada de los partidos en orden cronológico. Se "calienta" desde ~20 de marzo (o desde la temporada anterior completa en el experimento de abril) hasta el día antes de empezar el backtest, y se actualiza un día a la vez, siempre DESPUÉS de calificar ese día (para no filtrar información futura).

---

## Bugs importantes corregidos (por si algo se ve raro, revisar que no hayan regresado)

De sesiones anteriores: dedup de totales roto, moneyline con probabilidades irreales, falsos aciertos en reporte nocturno por `line` faltante, fallos silenciosos en Telegram sin avisar.

**De la sesión anterior** (los 3 primeros afectan al bot en vivo, no solo al backtest):
1. **Pretemporada colándose como si fueran juegos reales** — `fetchSchedule`/`fetchTeamRecentSchedule` no filtraban por `gameType=R`. Corregido.
2. **ERA sin límite en `projectedTotalRuns`** — un pitcher con muestra chica (ej. 1 mal arranque) podía tener ERA de 67.5, disparando proyecciones de 40+ carreras. Clamp agregado (0.4x-2.2x liga).
3. **AVG sin límite en `extractBattingAvgAndPA`** — mismo problema, un bateador con 1-2 turnos podía dar AVG de 1.000. Clamp agregado (0.150-0.380).
4. **Swap de rival en ponches, solo en el backtest** (`scan.js` en vivo siempre estuvo bien) — el pitcher local usaba por error las stats de su propio equipo en vez de las del rival. Corregido.
5. **Calibración del factor ofensivo** — el hallazgo más importante de esa sesión.

**De esta sesión**:
1. **Trade a mitad de temporada triplicaría stats de carrera** — la API `yearByYear` de MLB devuelve una temporada canjeada más de una vez (una fila por equipo + una combinada). Deduplicado quedándose solo con la fila combinada. Ver sección del modelo arriba.

---

## Hallazgos validados del backtest (mayo/junio/julio 2026, config actual)

- El enfoque de bateador individual **sí le gana** al promedio de equipo simple: moneyline 53.7%→~52-56% según el mes, Brier mejoró, totales MAE bajó de 3.78 a ~3.6-3.9. Junio fue un mes flojo (51.4%) pero mayo y julio lo superaron claramente — parece variación normal, no una tendencia.
- **La idea de excluir "equipos irregulares" del bot se descartó** — se investigó a fondo (varianza de carreras, sesgo promedio del modelo, qué tan parejos eran sus partidos) y ninguna explicación estructural se sostuvo. Prueba definitiva: Chicago Cubs fue el equipo *más predecible* en mayo+junio y el *más impredecible* de los 30 en julio. Es ruido de muestra chica (18-55 juegos/equipo/mes), no una característica real de ningún equipo.
- **Experimento "pegar temporada 2025 a 2026" para abril** (`scripts/backtest-season-glue.js`, NO aplicado al bot): mejoró casi todas las métricas de abril vs. arrancar en frío (moneyline 47.6%→49.9%, factor ofensivo promedio 1.061→0.977 casi perfecto). Confirma que el problema de abril es falta de muestra, no diseño del modelo. **Pendiente de decidir** si vale la pena implementarlo en el bot en vivo (usar stats de temporada anterior las primeras semanas de cada temporada nueva).
- Se quitaron las señales de **hits de bateador** por completo (pedido explícito) — ya no se generan en `scan.js` ni en `scripts/backtest.js`.
- Se agregó el mercado de **totales de primeras 5 entradas** (`totals_1st_5_innings` en The Odds API, vía el endpoint por-evento igual que ponches) — debutó con sesgo casi cero en mayo/junio/julio.

## Limitaciones conocidas / pendientes

- El cron automático no re-analiza un juego "ya escaneado hoy" el resto del día (`/senales` sí).
- ~30-40 llamadas a la API de MLB por partido — riesgo de timeout en Vercel Hobby (10s), mitigado con `last_scanned_at`.
- Ponches todavía usa promedio de equipo para el rival, no la libreta individual (sí se usa para moneyline/totales) — candidato a mejora, no se ha probado si ayuda ahí también.
- Bullpen no se usa en ninguna señal — solo el abridor.
- Umpire no implementado.
- `docs/MODEL_INPUTS.md` quedó desactualizado esta sesión — no confiar en él sin revisar contra el código real.
- Cuota de The Odds API se agota fácil — el backtest no la toca, pero correr `runScan()`/`/senales` sí.
- Pendiente decidir sobre el experimento de "pegar temporada anterior" (ver arriba).
- Pendiente decidir el peso final de ERA/K9 de carrera (arranca en 10%, hay que correr el backtest con distintos valores).
- OPS de carrera del bateador: no implementado todavía (se decidió dejarlo fuera de esta sesión).

## Cómo retomar en una sesión nueva

1. Lee este archivo. `docs/MODEL_INPUTS.md` está desactualizado, mejor revisar `lib/signals.js` y `scripts/backtest.js` directamente para el estado real del modelo.
2. `cd C:\Users\anton\OneDrive\Escritorio\MLB && npm test` — deben pasar 199 tests.
3. Para ver el estado del modelo con datos reales: entra al dashboard (`/backtest/`, secreto en `.env` como `DASHBOARD_SECRET`) y revisa las corridas de mayo/junio/julio (las más recientes con la config actual).
4. Para correr un backtest nuevo: `node --env-file=.env scripts/backtest.js <inicio> <fin> "nota"`. Tarda varios minutos por el calentamiento de la libreta de bateo.
5. Para analizar fallos en bulk: `node --env-file=.env scripts/analyze-misses.js <runId> [--market=X] [--limit=N]`.
6. Cualquier cambio al modelo: implementar → testear → correr backtest para comparar contra la config anterior → `git push` → `vercel --prod --yes` → verificar.
