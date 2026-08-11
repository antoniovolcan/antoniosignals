# MLB Telegram Signals Bot — CONTEXT

## Lo esencial

| | |
|---|---|
| **Qué es** | Bot de Telegram personal que cruza stats de MLB con cuotas de casa de apuestas y manda señales de valor (moneyline, totales, totales 1ras 5 entradas). No manda señales de hits de bateador ni de ponches de pitcher (ambas se quitaron a propósito — hits desde el inicio, ponches el 2026-08-01 por demasiada varianza, esencialmente un coinflip). |
| **Repo local** | `C:\Users\anton\OneDrive\Escritorio\AI raiz\MLB\mlb-telegram-bot` (movido el 2026-08-11 — antes estaba en `C:\Users\anton\OneDrive\Escritorio\MLB`) |
| **GitHub** | `https://github.com/antoniovolcan/antoniosignals` (rama `master`) |
| **Deploy** | Vercel, proyecto `antoniovolcans-projects/mlb-telegram-signals`, plan **Hobby (gratis)** — límite duro de 10s por función |
| **URL producción** | `https://mlb-telegram-signals.vercel.app` |
| **Dashboard de backtest** | `https://mlb-telegram-signals.vercel.app/backtest/` — protegido con `DASHBOARD_SECRET` (localStorage del navegador) |
| **Stack** | Node.js (ESM), Vercel serverless, Supabase (Postgres), Telegram Bot API, The Odds API, MLB Stats API (`statsapi.mlb.com`) |
| **Tests** | `npm test` → `node --test lib/**/*.test.js` — confirmar conteo real corriendo el comando, ha ido subiendo entre sesiones (última cifra conocida: 229) |
| **Git** | Antonio Volcan / soyvolcom@gmail.com. Commits directos a `master` (proyecto personal, sin PRs) |
| **Regla** | Cada cambio: implementar → testear → `git push` → `vercel --prod --yes` → verificar con datos reales |
| **⚠️ Trabajo concurrente** | Puede haber **otra sesión de Claude Code corriendo en paralelo** sobre este mismo repo (ya pasó una vez: agregó la integración con el simulador externo, ver abajo, y en el camino un `git reset` casi borra trabajo sin comitear de esta sesión). Siempre `git status`/`git log`/`git fetch` al empezar, y comitear seguido para no perder trabajo. |

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
  signals.js          # heurística pura: probabilidades, log5, Poisson, blending, projectedTotalRuns/F5, computeLineupOps, calibración
  mlb.js               # cliente statsapi.mlb.com — fetch + parse separados. Incluye mlbDateToday()/addDaysToDateString() (ver "Timezone" abajo)
  odds.js              # cliente The Odds API (incluye extractMarket, exportado para mercados no-featured como F5)
  db.js                # cliente Supabase (todas las queries, incluye paginación >1000 filas, y getSimPrediction — ver "Simulador externo")
  telegram.js          # sendTelegramMessage, sendTelegramDocument (multipart)
  parkFactors.js       # tablas estáticas de factor de parque: ponches (STRIKEOUT_PARK_FACTORS) y carreras (RUN_PARK_FACTORS)
  battingLedger.js     # libreta acumulada de stats reales bateador-vs-mano desde jugada-por-jugada (usada solo por el backtest)
  missAnalysis.js      # post-mortem de un fallo: trae jugada-por-jugada real y explica qué bateador lo causó
  backtestMetrics.js   # agregación de métricas (bias/MAE/RMSE/accuracy/Brier) sobre backtest_predictions
  *.test.js            # tests unitarios de las funciones puras, sin red

api/
  scan.js               # cron principal: analiza juegos del día (moneyline, totales, totales F5), genera y guarda señales, manda documento .txt agrupado
  telegram-webhook.js   # comandos: /hoy /senales /simulaciones /partido /config edge
  nightly-report.js     # corre de madrugada: califica señales de ayer vs resultado real, manda reporte
  sim-report.js         # manda por Telegram TODAS las simulaciones del día del proyecto externo (no solo las que generan señal) — cron + /simulaciones
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
  migrations/*.sql         # migraciones incrementales — correrlas a mano en el SQL Editor de Supabase, no hay forma de aplicarlas por código (la 004_add_sim_predictions.sql es la más reciente)

docs/
  superpowers/specs/       # specs de diseño (una por feature grande)
  superpowers/plans/       # planes de implementación
  MODEL_INPUTS.md          # referencia de qué stats usa cada señal — **desactualizado, no confiar sin revisar el código real**
```

## Tablas en Supabase

- `games` — juegos del día + `last_scanned_at`
- `signals` — cada señal enviada en producción (market, selection, odds, probabilidades, `line`, `subject_id`, `hit`/`actual_value`/`graded_at`)
- `results` — resultado final de cada juego
- `config` — `edge_threshold` (ajustable con `/config edge N`)
- `team_map` / `player_map` — sin usar todavía
- `backtest_runs` — una fila por corrida de backtest (fechas, `model_note` describiendo qué se probó)
- `backtest_predictions` — una fila por predicción individual del backtest (proyectado, real, `factors` en JSON con todos los valores intermedios) — **usar `getBacktestPredictions` de `lib/db.js`, no hacer `select` directo sin paginar** (Supabase corta en 1000 filas por default)
- `sim_predictions` — **tabla nueva, poblada por un proyecto EXTERNO** (no por este bot): predicciones de moneyline de un simulador Monte Carlo, una fila por `(date, home_team, away_team)` con `home_win_pct`/`away_win_pct`/`sims`. Este bot solo LEE de ahí (`getSimPrediction` en `lib/db.js`) para comparar contra su propio modelo — ver sección del simulador abajo.

## Cron jobs externos (cron-job.org)

1. `.../api/scan?secret=<CRON_SECRET>` — cada hora
2. `.../api/nightly-report?secret=<CRON_SECRET>` — ~madrugada
3. `.../api/sim-report?secret=<CRON_SECRET>` — pendiente de crear en cron-job.org por el usuario; correr un poco después de que el simulador externo termine su corrida nocturna (visto escribiendo `sim_predictions` ~05:04-05:07 UTC, así que ~05:15 UTC es un margen razonable)

## Comandos de Telegram

- `/hoy` — juegos del día
- `/senales` — corre el análisis completo bajo demanda, siempre en modo `force`: re-analiza todo con datos frescos y **actualiza** (no duplica) señales ya enviadas ese día
- `/simulaciones` — manda TODAS las simulaciones del día del proyecto externo (equipo/pitcher probable/% de victoria por lado), no solo las que generan una señal de moneyline
- `/partido <equipo>` — estado rápido de un juego
- `/config edge <0-1>` — umbral mínimo de edge (default 0.05)

---

## Timezone — gotcha importante

MLB corre en hora Eastern (US), no UTC. `mlbDateToday()` (`lib/mlb.js`) usa `Intl.DateTimeFormat` con `timeZone: 'America/New_York'` para sacar la fecha "de hoy" correcta — **usar siempre esto, no `new Date().toISOString().slice(0,10)`**, porque UTC rueda al día siguiente a las 8pm Eastern (justo cuando la mayoría de los juegos están en curso), desincronizando el calendario del bot varias horas cada noche. `addDaysToDateString(dateString, days)` hace aritmética pura de fecha sobre un string `YYYY-MM-DD` ya correcto. Esto afectó: fetch del schedule, ventanas de dedup de señales, calificación nocturna, y el cruce con `sim_predictions` (ver abajo).

## Simulador externo — integración de solo lectura

Otro proyecto (no este repo) corre un simulador Monte Carlo y escribe sus predicciones de moneyline a la tabla `sim_predictions` cada noche (confirmado escribiendo bien: pitchers probables + win% por lado + cantidad de simulaciones). Dos formas de verlo desde este bot:

1. **Nota en señales de moneyline** (`getSimPrediction` + `formatSimComparisonNote` en `signals.js`): "Simulador coincide: X (63%)" o "Simulador difiere: predice Y" pegado al final del reasoning — puramente informativo, no afecta probabilidad ni edge. **Limitación conocida**: solo aparece si ESE juego generó una señal de moneyline real (edge + confianza mínima); la mayoría de los juegos simulados no la generan, así que la mayor parte de las simulaciones nunca se veían por esta vía — por eso se agregó el reporte independiente de abajo.
2. **Reporte independiente de TODAS las simulaciones del día** (`getSimPredictionsForDate` en `db.js`, `formatSimReportMessage` en `signals.js`, `api/sim-report.js`): manda un mensaje de Telegram con cada juego simulado (equipo/pitcher probable/% por lado), sin filtrar por señal ni edge. Se dispara por cron diario (pendiente de configurar en cron-job.org, ver abajo) y por el comando `/simulaciones`.

---

## El modelo — estado actual

**Moneyline**: ERA temporada+reciente (60/40, clamp de ratio 0.4x-2.2x liga = 1.6-8.8 aplicado **en el origen**, en `mlb.js`), re-blendeado con ERA de **carrera** (`CAREER_ERA_WEIGHT = 0.8`, 20% carrera), récord de equipo (últimos 15 + temporada completa, `TEAM_RECORD_RECENT_WEIGHT = 0.3`, 30/70 — deliberadamente al revés que el ERA, porque el récord de un equipo en 15 partidos es más ruidoso que el ERA de un pitcher en 5 arranques), localía, y factor ofensivo individual por bateador (ver abajo). Log5 combina ambos equipos, cada uno clampeado 30-70%, y el resultado pasa por un **encogimiento hacia 0.5** (`calibrateWinProbability`/`MONEYLINE_CALIBRATION_SHRINK = 0.5`) porque el modelo era sobreconfiado en los extremos (validado: favorito visitante <40% ganaba ~50% de las veces en la realidad). Antes de mandar una señal real, además del `edge_threshold` de siempre, hay un **filtro de confianza mínima propia** (`MIN_MONEYLINE_CONFIDENCE = 0.08`, `isConfidentEnough`): el modelo tiene que estar a ≥8% de distancia de 50/50, no solo tener edge vs. la cuota.

**Totales** (partido completo y **1ras 5 entradas**): mismo ERA (temporada+reciente+carrera) × carreras/partido (temporada+15 días, 60/40) × factor ofensivo × **factor de parque para carreras** (`RUN_PARK_FACTORS` en `parkFactors.js`, Coors 1.18 el más alto, San Francisco 0.91 el más bajo). F5 escala la misma fórmula a base de 5 entradas (5/9). Ambos pasan por un **encogimiento hacia un punto de gravedad ajustado por parque** (`calibrateProjectedTotal`/`TOTALS_CALIBRATION_SHRINK = 0.8`) por el mismo problema de sobreconfianza que moneyline (proyecciones bajas se quedaban cortas, altas se pasaban). **Bullpen NO se usa** — se probó y se descartó (ver "Experimentos descartados" abajo).

**Factor ofensivo (moneyline + totales/F5)**: por cada uno de los 9 bateadores del lineup titular, se blendea su OPS vs.-la-mano-del-pitcher-rival con su OPS general de temporada (50/50). Esos 9 valores se combinan dándole 70% de peso a los 2 bateadores más peligrosos y 30% al resto del lineup (`computeLineupOps`, `topN=2, topWeight=0.7`) — un esquema alternativo (top-3/50%, mano 30/70, o agregar AVG/K-rate) se probó y **no mostró ninguna mejora** una vez recalibrado correctamente (ver abajo). El resultado se compara contra `LEAGUE_AVG_TOP_WEIGHTED_OPS = 0.840` (no 0.720 — recalibrado a mano porque el esquema top-N infla el número para casi cualquier lineup).

**ERA/K9 de carrera** (pitcher): suma de todas las temporadas regulares anteriores a la actual (vía `stats=yearByYear` de MLB), excluye deliberadamente la temporada en curso para ser el mismo dato en vivo y en el backtest. Si el pitcher es novato, el componente se omite (no se inventa reemplazo). **Trampa real**: un trade a mitad de temporada devuelve la temporada 2-3 veces en la API (una fila por equipo + una combinada) — hay que deduplicar quedándose solo con la combinada (`dedupSeasonSplits` en `mlb.js`).

**Récord de equipo** (últimos 15 + temporada completa): se calcula desde el calendario real del equipo (`computeWinPctFromSchedule` en `mlb.js`, sirve para cualquier ventana — `{lastN: 15}` o completo), no del split precalculado de MLB (que no tiene versión "últimos 15"). Mismo método en vivo y en backtest.

**Data que NO se usa todavía**: bullpen (probado, descartado), OPS/AVG/K-rate de carrera del bateador, umpire, descanso/fatiga.

**Ponches del pitcher — señal quitada (2026-08-01)**: se ofrecía como mercado (K/9 temporada+reciente+carrera, innings ajustados por riesgo de salida temprana, tasa de ponches del lineup rival, parque, clima) pero se descontinuó por decisión del usuario: demasiada varianza partido a partido, esencialmente un coinflip pese al modelo. Se eliminó el código de proyección (`expectedPitcherStrikeouts` y todo lo que solo alimentaba esa señal en `signals.js`/`mlb.js`/`parkFactors.js`), el envío de señales en `scan.js`, la calificación en `nightly-report.js`, el post-mortem en `missAnalysis.js`, las métricas en `backtestMetrics.js`, el backtest en `scripts/backtest.js`, y la columna/gráfica en el dashboard. Si se quisiera reintroducir, habría que reconstruir esa parte desde cero — no quedó código muerto a propósito.

---

## Bugs reales corregidos (ya no deberían regresar, avisar si algo se ve raro)

- Pretemporada colándose como juegos reales (`gameType=R` faltante).
- ERA/AVG sin límite en muestras chicas — podían disparar proyecciones absurdas (ej. ERA de 65 con 1 mal arranque). Clamp agregado en el origen (`mlb.js`: `computeRecentEra`, `computeSeasonEra`, `extractBattingAvgAndPA`) — las probabilidades finales nunca se vieron afectadas (ya había clamps downstream), pero el texto/factors guardados sí mostraban números rotos.
- Fecha "hoy" en UTC en vez de Eastern — desincronizaba el bot varias horas cada noche (ver sección Timezone arriba).
- Dedup de totales roto, moneyline con probabilidades irreales, falsos aciertos en reporte nocturno por `line` faltante, fallos silenciosos en Telegram sin avisar (sesiones muy anteriores).

## Experimentos probados y descartados (no repetir sin nueva evidencia)

- **"Equipos irregulares" excluidos del bot**: descartado — investigado a fondo (varianza, sesgo, qué tan parejos). Reconfirmado múltiples veces que el accuracy-por-equipo-en-un-período es ruido de muestra chica, no una característica real (ej. Pittsburgh #2 en toda la temporada 2025 pero último en junio 2026; Chicago Cubs #1 en junio y último en julio). **No usar accuracy por equipo para decidir nada del modelo.**
- **Pesos alternativos del factor ofensivo** (top-3/50% en vez de top-2/70%, mano 30/70 en vez de 50/50, agregar AVG/K-rate): sin recalibrar `LEAGUE_AVG_TOP_WEIGHTED_OPS` empeoraba todo; recalibrado correctamente, rindió **prácticamente idéntico** al esquema actual (todo dentro del ruido de un mes). No hay evidencia para cambiarlo.
- **Bullpen en totales** (ERA de bullpen del equipo, blendeado con el del abridor por % de entradas): mejora chica en un mes se diluyó a nada en la temporada completa. La API de MLB permite aislar el bullpen (`sitCodes=rp`) pero ese filtro se ignora silenciosamente combinado con `byDateRange` — el proxy de "temporada anterior completa" (leak-free) probablemente está muy desactualizado para reflejar el bullpen actual. Si se retoma, requeriría un "bullpen ledger" desde jugada-por-jugada como `battingLedger.js`, no este proxy simple.
- **"Pegar temporada 2025 a 2026" para abril** (experimento en `scripts/backtest-season-glue.js`, nunca aplicado al bot; el script se eliminó el 2026-08-01 al quitar las señales de ponches, de las que dependía gran parte de su código — el hallazgo sigue siendo válido, solo hay que reescribirlo si se retoma): mejoró métricas de abril en frío. Confirma que el problema de abril es falta de muestra, no diseño. **Pendiente decidir** si vale la pena implementarlo en vivo.

## Metodología de backtest (repetir en sesiones futuras)

1. Correr la temporada completa **de una sola vez** (`node scripts/backtest.js <inicio> <fin> "nota"`) en vez de mes por mes — más eficiente y evita "hornear" ruido de un mes antes de probar el siguiente.
2. Buscar patrones sobre el agregado completo (miles de predicciones).
3. **Validar con holdout real** — partir la temporada en dos mitades (ej. marzo-mayo vs. junio-septiembre) y confirmar que el patrón se repite en ambas por separado. Descartar lo que no se repite.
4. Solo implementar lo que sobrevive el holdout, testear, y re-correr la temporada completa para confirmar antes de desplegar.
5. **Un mes solo (n≈400) NO alcanza para decidir nada** — varias "mejoras" de un mes (pesos de bateo, bullpen) se diluyeron a ruido con la temporada completa (n≈12,000). Preferir siempre la validación de temporada completa antes de comitear un cambio de modelo.

La temporada 2025 en esta base de datos va del 18 de marzo al 28 de septiembre. Backtest recomendado: `2025-03-25` a `2025-09-28` (margen para calentar la libreta de bateo).

## Limitaciones conocidas / pendientes

- El cron automático no re-analiza un juego "ya escaneado hoy" el resto del día (`/senales` sí).
- ~30-40 llamadas a la API de MLB por partido — riesgo de timeout en Vercel Hobby (10s), mitigado con `last_scanned_at`.
- Sin ajuste por descanso/fatiga del pitcher/equipo.
- Umpire no implementado.
- `docs/MODEL_INPUTS.md` desactualizado — no confiar sin revisar el código real.
- Cuota de The Odds API se agota fácil — el backtest no la toca, pero `runScan()`/`/senales` sí.
- **Muestra chica en producción real** (`signals` en Supabase, limpia desde 2026-08-11 — ver abajo): moneyline y totales rondan apenas por encima de 50% de acierto real, bastante peor que el backtest. Vigilar con más datos acumulados antes de sacar conclusiones sobre si el filtro de edge les sirve.

## Auditoría de señales en vivo (2026-08-11) — hallazgos y pendientes

Se pidió un análisis profundo de todas las señales enviadas hasta ahora vs. lo que pasó en la realidad. Hallazgos:

- **Contaminación de datos, ya limpiada**: el 24/07 había 156 filas en `signals` (128 de "totals") generadas en una ráfaga de 9 horas sobre solo 15 juegos — claramente pruebas manuales de cuando se armaba el bot, no actividad real (inflaba el accuracy de totales a 80.5% ese día solo). Se borraron esas 156 filas de Supabase (por id explícito, ver commits/chat del 2026-08-11). Además, el modelo actual (shrink de calibración de moneyline, filtro de confianza, peso de ERA de carrera, park factor) recién quedó armado el 27-28/07 — señales anteriores a esa fecha las mandó una versión inmadura (se vieron `estimated_prob` de hasta 98.2%, imposible con el clamp actual de 95%) y no deberían usarse para juzgar el modelo de hoy.
- **Con datos limpios (desde 27-28/07)**: moneyline 17/36 (47.2%), totales 70/128 (54.7%, pero Over 49.5% vs Under 68.6% — asimetría fuerte).
- **Moneyline: el edge está invertido** — a mayor edge reportado, peor accuracy real (5-8% edge: 58.8%, 8-12%: 41.7%, 12%+: 28.6%). Causa raíz identificada revisando los picks de mayor edge uno por uno (con datos reales de la API de MLB y noticias): los pesos de blend son fijos (`blendEraEstimates` recentWeight=0.6, `CAREER_ERA_WEIGHT`=0.8) sin importar cuántos arranques respaldan cada número — una ventana de 5 arranques ruidosa pesa más que una temporada completa (caso Cristopher Sánchez: reciente 5.02 alejó del pick, esa misma noche ponchó 11 en 6 innings en blanco), y una brecha carrera-vs-temporada extrema se corrige igual que una chica (caso Foster Griffin: temporada 2.76 / carrera 6.75, regresó a la media literalmente en su siguiente arranque con 6 carreras permitidas). También se confirmó que `computeRecentEra`/`computeSeasonEra` no filtran por `gamesStarted` (mezclan arranques y relevos — caso Randy Dobnak). El moneyline tampoco usa factor de parque (solo lo usan totales/F5) — caso Rockies en Coors, 7-9.
- **Totales: sesgo direccional persiste post-shrink** — picks de Over ganan por apenas +0.75 carreras de margen promedio, picks de Under por -1.59. Es el mismo patrón que originalmente motivó `TOTALS_CALIBRATION_SHRINK` (proyecciones altas se quedan cortas), pero el shrink actual es simétrico y no corrige un sesgo que es direccional (solo lado alto). Confirmado que esto NO lo introdujo la feature de líneas alternativas (mismo patrón antes y después del 03/08).
- **Validado con backtest de temporada completa (run #43, 2025-03-25 a 2025-09-28, 7281 predicciones, instrumentado con `homeStartsCount`/`awayStartsCount`/`homeCareerGap`/`awayCareerGap` en `factors` de moneyline — ver `scripts/backtest.js`)**: la hipótesis de shrinkage-por-muestra-chica de la sesión anterior **se sostiene solo a medias, y la de brecha-de-carrera NO se sostiene**:
  - Con n=2427 sin filtrar, no hay relación clara entre accuracy y arranques-reales (51.5%-58.1% en todos los buckets) ni brecha de carrera (51.7%-55.8%) — los casos puntuales de la auditoría en vivo (Sánchez, Griffin, Dobnak) probablemente eran anécdotas de muestra chica, no un patrón sistemático. **No perseguir la brecha carrera-vs-temporada como palanca de mejora — no hay evidencia.**
  - PERO restringiendo a los picks de **alta confianza** (`|prob-0.5|>=0.15`, exactamente el tipo que sale como señal real, n=288): cuando el pitcher del lado favorito tiene **menos de 5 arranques reales** detrás de su ERA, accuracy cae a 53.1% (n=98) vs. 68.5% (n=92) cuando tiene 10-20 arranques — una brecha de ~15 puntos, moderadamente significativa (p≈0.03). Real pero más modesto que lo que sugería la muestra en vivo.
  - **Totales: el sesgo direccional SÍ se confirmó con fuerza** (n=2427): bias (real−proyectado) va de **+0.70** en proyecciones bajas (<7.5) a **−1.12** en proyecciones altas (10.5+), monótono y creciente — el mismo patrón que originalmente motivó `TOTALS_CALIBRATION_SHRINK`, sin resolver por el shrink simétrico actual (0.8). Este es el hallazgo más sólido de toda la auditoría.
  - **✅ Implementado (2026-08-11): `TOTALS_CALIBRATION_SHRINK` 0.8 → 0.5.** Reconstruí, para cada predicción del run #43, el punto de gravedad ajustado por parque y la desviación pre-shrink (`rawDev = (projected_value - gravity) / 0.8`), y probé una grilla de shrinks recalculando `gravity + rawDev*shrink` contra el resultado real. Hallazgo clave: MAE/RMSE casi no cambian en todo el rango (0.8→MAE 3.648, 0.26→MAE 3.604) — la varianza partido-a-partido de carreras está dominada por ruido que el modelo no puede capturar de ninguna forma, así que un shrink más fuerte no cuesta precisión real. En cambio el sesgo por bucket sí se corrige: en 0.5 queda razonablemente simétrico (+0.30 en el bucket bajo, -0.24 en el alto, vs. +0.70/-1.12 en 0.8), sin comprimir tanto como para vaciar el bucket bajo de datos (a 0.3 quedan solo 2 juegos ahí). Mismo patrón confirmado independientemente en totals_f5 con la misma corrida. **Esto NO es un "el modelo ahora acierta más" — es "los fallos de Over dejan de ser sistemáticamente peores que los de Under".** Test actualizado (`calibrateProjectedTotal: defaults to TOTALS_CALIBRATION_SHRINK (0.5)`), desplegado a producción.
  - **✅ Implementado (2026-08-11): descuento de confianza para moneyline con pitcher favorito de muestra chica.** `THIN_SAMPLE_STARTS_THRESHOLD=5` / `THIN_SAMPLE_EXTRA_SHRINK=0.7` en `signals.js` (`applyThinSampleDampening`), aplicado dentro de `moneylineEstimate` solo al lado favorito. Validado con backtest run #45 vs #44 (misma temporada completa): accuracy general sin cambios (0.5406, esperado — el shrink no cambia a quién favorece, solo la magnitud), Brier mejoró (0.2507→0.2497), y el bucket problemático (alta confianza + <5 arranques) **desapareció del todo** — ya no hay ningún pick que sea "alta confianza" con esa combinación, porque el descuento lo saca de esa categoría antes de que llegue a ella. El resto de alta confianza subió de 59.4% a 62.6% al quedar filtrado ese subgrupo débil. `countRealStarts` ahora vive en `mlb.js` (compartida entre `scan.js` y `backtest.js`). Desplegado a producción.
  - **Pendientes (sin implementar aún)**:
    1. Corrección de higiene de datos de bajo riesgo, independiente de si mueve el accuracy: filtrar `computeRecentEra`/`computeSeasonEra` por `gamesStarted===1` para no mezclar arranques con relevos (caso Dobnak) — vale hacerlo igual aunque el efecto agregado no se haya medido.
    2. Sin confirmar todavía (no se testeó en este backtest): agregar factor de parque al moneyline. Es solo una hipótesis arquitectónica de un caso anecdótico (Rockies/Coors) — necesitaría su propio test antes de implementarse.

## Loop de mejora autónomo — mayo 2025 como señal rápida (2026-08-11, en curso)

El usuario autorizó una sesión larga y desatendida: iterar prueba-y-error contra el backtest de mayo 2025 (rápido, ~1 mes) como señal de feedback veloz, pero **todo cambio que "mejore" mayo se valida contra la temporada completa antes de quedárselo** — si no se sostiene ahí, se descarta. Meta: accuracy real de moneyline ~65-70% (no 80%, se explicó por qué es irreal para MLB — favoritos de moneyline ganan ~57-60% en toda la liga). Está bien si varía mes a mes. Instrumenté `scripts/backtest.js` para capturar TODOS los ingredientes crudos de cada predicción de moneyline (ERA cruda por componente, récord crudo por componente, OPS de lineup, park factor, arranques reales) — permite simular miles de combinaciones de pesos/parámetros con cálculo local puro contra una sola corrida capturada, sin tener que re-pegarle a la API de MLB por cada prueba. Ver historial de commits desde 2026-08-11 tarde para el detalle de qué se probó y qué se quedó.

## Cómo retomar en una sesión nueva

1. `git status` / `git log -10` / `git fetch` primero — puede haber otra sesión trabajando en paralelo (ver aviso arriba).
2. Lee este archivo. `docs/MODEL_INPUTS.md` está desactualizado, mejor revisar `lib/signals.js` y `scripts/backtest.js` directamente para el estado real del modelo.
3. `cd "C:\Users\anton\OneDrive\Escritorio\AI raiz\MLB\mlb-telegram-bot" && npm test` — confirmar que todo pasa (el conteo exacto de tests sube con cada sesión).
4. Para ver el estado del modelo con datos reales: dashboard (`/backtest/`, secreto en `.env` como `DASHBOARD_SECRET`).
5. Para correr un backtest nuevo: `node --env-file=.env scripts/backtest.js <inicio> <fin> "nota"` — tarda varios minutos (un mes) a ~1 hora (temporada completa).
6. Para analizar fallos en bulk: `node --env-file=.env scripts/analyze-misses.js <runId> [--market=X] [--limit=N]`.
7. Cualquier cambio al modelo: implementar → testear → backtest de temporada completa (no solo un mes) para comparar contra la config anterior → `git push` → `vercel --prod --yes` → verificar con `/senales`.
