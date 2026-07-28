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
| **Tests** | `npm test` → `node --test lib/**/*.test.js` (219 tests, solo lógica pura, sin red) |
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
  parkFactors.js       # tablas estáticas de factor de parque: ponches (STRIKEOUT_PARK_FACTORS) y carreras (RUN_PARK_FACTORS)
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

**Moneyline**: ERA temporada+reciente (60/40, clamp de ratio 0.4-2.2 — antes sin clamp, un ERA de muestra chica podía disparar proyecciones absurdas), **récord de equipo blendeado (últimos 15 + temporada completa, 30/70 — ver abajo)**, localía, y **factor ofensivo individual por bateador** (ver abajo). Log5, cada equipo clampeado 30-70%, y desde esta sesión la probabilidad final pasa por un **encogimiento (shrinkage) hacia 0.5** (`calibrateWinProbability`/`MONEYLINE_CALIBRATION_SHRINK = 0.5` en `signals.js`) — ver "Calibración y filtro de confianza" más abajo.

**Totales** (partido completo y **1ras 5 entradas**): mismo ERA clampeado + carreras/partido (temporada+15 días, 60/40) × factor ofensivo × **factor de parque para carreras** (nuevo, ver abajo). F5 escala la misma fórmula a base de 5 entradas (5/9) en vez de modelar bullpen directamente. Ambos pasan por un **encogimiento hacia un punto de gravedad ajustado por parque** (`calibrateProjectedTotal`/`TOTALS_CALIBRATION_SHRINK = 0.8`, mismo mecanismo que moneyline).

**Ponches del pitcher**: K/9 temporada+reciente, innings reales (ajustados a la baja si el pitcher tiene mal ERA contra ofensiva fuerte — riesgo de salida corta, **dampening de 50% desde esta sesión** vía `EARLY_HOOK_RISK_SCALE = 0.5`, ver abajo), tasa de ponches + mezcla poder/contacto del lineup rival (todavía **promedio de equipo**, no individual — candidato a mejorar), factor de parque y clima (mejor esfuerzo).

**ERA y K/9 de carrera**: además del blend de siempre (reciente 60% + temporada 40%), se re-blendea contra el ERA/K9 de **carrera** del pitcher (todas las temporadas regulares anteriores a la actual, sin incluir la actual), aplicado como un segundo llamado a `blendEraEstimates` en cascada (no una función nueva). "Carrera" = suma de temporadas anteriores completas vía `stats=yearByYear` de MLB — deliberadamente excluye la temporada en curso para que sea el mismo dato tanto en vivo (`scan.js`) como en el backtest walk-forward (`scripts/backtest.js`, con `season` como corte, no la fecha del día), sin fuga de datos. Si el pitcher no tiene temporadas anteriores (su primera en MLB), el componente de carrera simplemente se omite (no se inventa un valor de reemplazo). El OPS de carrera del bateador se decidió **no** tocarlo (fuera de alcance).

**Pesos de carrera — barrido 10/20/30/40/50% y valor final asentado**: se probó con backtests reales de mayo y junio 2026. ERA (afecta moneyline+totales+F5) y K/9 (afecta solo ponches) resultaron necesitar pesos distintos:
- **ERA**: el bias de totales se fue alejando de cero de forma consistente al subir el peso más allá de 20%, y el Brier de moneyline revirtió (empeoró) en junio a 30%. Se asentó en **`CAREER_ERA_WEIGHT = 0.8`** (20% carrera) — el último punto limpio antes de esas reversiones.
- **K/9**: mejoró de forma monótona (MAE y bias) en ambos meses hasta 40%, pero a 50% el MAE de junio revirtió levemente. Se asentó en **`CAREER_K9_WEIGHT = 0.6`** (40% carrera) por la misma razón.

**Récord de equipo (moneyline) — últimos 15 + temporada completa, no solo últimos 10**: antes el modelo solo sabía "cómo viene jugando" un equipo (récord de últimos 10, vía el split precalculado de MLB), sin ninguna noción de qué tan bueno es en general esa temporada — dos equipos podían llegar con la misma racha de 5-5 aunque uno fuera 1° lugar y el otro último. Ahora `computeWinPctFromSchedule` (antes `computeLastTenFromSchedule`, generalizada) calcula el récord tanto del bot en vivo como del backtest de la misma forma — a partir del calendario real del equipo, no del split de MLB (que no tiene una versión "últimos 15") — y `TEAM_RECORD_RECENT_WEIGHT = 0.3` blendea 30% últimos 15 / **70% temporada completa** (deliberadamente al revés que el blend de ERA del pitcher: el récord de un equipo en 15 partidos es mucho más ruidoso que el ERA de un pitcher en 5 arranques — hasta un equipo de 100 victorias pierde ~40% de sus partidos).

**Validado con la temporada 2025 completa (run #31 baseline vs. #33 con el cambio)**: el promedio general de moneyline queda prácticamente plano (accuracy 54.4%→54.0%, Brier 0.2504→0.2507) — pero en los partidos con brecha de récord genuinamente grande (≥20 puntos porcentuales), el cambio es real: el método viejo (solo últimos 10) clasificaba el 46% de los partidos como "brecha grande" con 56.9% de acierto ahí (mucho ruido de racha, no calidad real); el método nuevo clasifica solo el 18% como brecha grande, pero con **61.9%** de acierto — identifica el desajuste real de calidad con más precisión, aunque la mayoría de los partidos de MLB son entre equipos parecidos (calendario balanceado) y ahí no cambia mucho. Se mantuvo el cambio porque resuelve exactamente el problema conceptual original (el modelo no sabía distinguir mejor-equipo-vs-peor-equipo) sin dañar el promedio general.

**Trampa encontrada al implementar carrera**: la API `yearByYear` de MLB devuelve una temporada con trade a mitad de año **más de una vez** — una fila por cada equipo, más una fila combinada (sin campo `team`) con el total real. Sumar todas las filas ciegamente triplicaría innings/ER/K de esa temporada. Se deduplicó quedándose solo con la fila combinada cuando existe (`dedupSeasonSplits` en `mlb.js`).

**Calibración y filtro de confianza — nuevo esta sesión, validado con la temporada 2025 completa** (backtest walk-forward marzo-septiembre 2025, 12,129 predicciones, run #30 baseline → run #31 con fixes, con holdout real marzo-mayo vs. junio-septiembre para confirmar que cada patrón no era ruido de un mes):

1. **`EARLY_HOOK_RISK_SCALE = 0.5`** (en `adjustedInningsForEarlyHookRisk`, `signals.js`): el recorte de entradas esperadas por riesgo de salida temprana estaba sub-proyectando sistemáticamente los ponches de pitchers con ERA malo (4.5+): bias +0.63 en mar-may, +0.23 en jun-sep — un pitcher con mal ERA a menudo tiene buen "stuff"/alta tasa de ponches aunque permita carreras, y el recorte de entradas no lo capturaba. Con el dampening al 50%, el bias de ese bucket bajó de +0.35 a +0.27 en la temporada completa (mejora real, pero no se cerró del todo — candidato a seguir bajando la escala si se quiere apretar más).
2. **`MONEYLINE_CALIBRATION_SHRINK = 0.5`** (en `calibrateWinProbability`, aplicado al final de `moneylineEstimate`): el modelo era sobreconfiado en los extremos — cuando favorecía al visitante (<40%), el equipo local terminaba ganando ~50-53% de las veces en ambas mitades de la temporada (casi sin señal real ahí). Encogiendo la probabilidad final hacia 0.5, el Brier de moneyline bajó de 0.269 a **0.250** en la temporada completa (accuracy quedó igual, ~54.4%, como se esperaba — el shrinkage no cambia a quién favorece el modelo, solo la magnitud).
3. **`MIN_MONEYLINE_CONFIDENCE = 0.08`** (`isConfidentEnough`, gate nuevo en `scan.js` para moneyline, apilado **encima** de `edge_threshold`, no en su reemplazo): validado que restringir a predicciones donde el modelo está a ≥8% de distancia de 50/50 sube el accuracy crudo de 54.4% a ~55.6% quedándose con ~48% de los partidos (la curva completa: ≥6%→55.4%@61%, ≥10%→56.1%@37%, ≥15%→59.1%@13% — mejora real pero modesta, no hay un salto grande escondido).

**Ojo — señales reales en producción (muestra chica, no concluyente todavía)**: al revisar `signals` calificadas en Supabase, totales tiene 72.9% de acierto real (n=181, muy bien), pero moneyline 46.3% (n=41) y ponches 42.9% (n=21) — **peor** que el accuracy crudo del backtest sin filtrar. Con muestras tan chicas puede ser ruido, pero es una señal a vigilar con más datos acumulados antes de sacar conclusiones sobre si el filtro de edge le sirve a esos dos mercados.

**Análisis de pies a cabeza + 3 fixes nuevos (validado con la temporada 2025 completa, run #33 baseline → run #36 con los 3 fixes)**: se pidió una revisión completa del modelo buscando bugs y patrones nuevos. Encontrados y corregidos:

1. **Bug preexistente (no de esta sesión): ERA/K9 crudo sin clamp en el origen** — el clamp de ratio 0.4x-2.2x ya existía, pero solo protegía los cálculos downstream (`projectedTotalRuns`, `pitcherFactor`, `adjustedInningsForEarlyHookRisk`), nunca el valor crudo de `homeEra`/`ownEra` que se guarda en `factors` y se muestra en el texto real de Telegram. Encontrados 25 de 4,848 predicciones de ponches (0.5%, todas en la primera semana de abril con 1-2 arranques de muestra) con ERAs de **29-65** en pitchers reales (Nestor Cortes, Bailey Ober, etc.) — las probabilidades finales nunca se vieron afectadas (confirmado: ninguna predicción de moneyline se acerca a los límites), pero el mensaje real se hubiera visto roto. Corregido clampeando en el origen (`computeRecentEra`/`computeSeasonEra`/`extractStrikeoutsPer9`/`computeRecentStrikeoutsPer9` en `mlb.js`, mismo rango 1.6-8.8 para ERA y nuevo 3.0-16.0 para K/9) — matemáticamente un no-op para todo lo que ya pasaba por los clamps downstream, solo arregla la visualización/almacenamiento.
2. **Totales necesitaba el mismo shrinkage que moneyline** — bias por magnitud de proyección era monótono y limpio (proyección <7.5: +1.13 de sesgo; 10.5+: -1.82). `calibrateProjectedTotal`/`TOTALS_CALIBRATION_SHRINK = 0.8` encoge hacia un punto de gravedad (no un promedio fijo, para no des-ajustar el factor de parque de abajo). Resultado: bias de totales -0.233→**-0.108**, F5 -0.072→**-0.004** (casi perfecto), MAE mejoró en ambos.
3. **Factor de parque para carreras — no existía, solo para ponches** — Colorado Rockies tenía el bias más alto de las 30 franquicias en totales (+1.79 carreras sub-proyectadas, el efecto Coors Field real). `RUN_PARK_FACTORS` en `parkFactors.js` (Coors 1.18, el más alto; San Francisco 0.91, el más bajo — tabla estática basada en factores de parque reales conocidos, mismo estilo que `STRIKEOUT_PARK_FACTORS`), aplicado en `projectedTotalRuns`/`projectedFirstFiveInningsRuns`. Resultado: bias de Colorado bajó de **+1.79 a +0.24** (-86%).

Moneyline y ponches quedaron prácticamente sin cambio (esperado, ninguno de los 3 fixes los toca de fondo).

**Patrones encontrados pero no atacados todavía (candidatos para la próxima sesión)**: calibración de moneyline mejoró pero no se cerró del todo (favorito visitante <40% real ~50.6% vs. predicho ~37-43%); bullpen no se usa en ninguna señal; K-rate individual del lineup rival en ponches (la libreta `battingLedger.js` ya existe para OPS, se podría extender); clima solo se aplica a ponches, no a totales; sin ajuste por descanso/fatiga del pitcher/equipo; OPS de carrera del bateador sigue sin implementar.

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

**De la sesión de esta ronda (implementación de carrera)**:
1. **Trade a mitad de temporada triplicaría stats de carrera** — la API `yearByYear` de MLB devuelve una temporada canjeada más de una vez (una fila por equipo + una combinada). Deduplicado quedándose solo con la fila combinada. Ver sección del modelo arriba.

**De esta sesión (patrones encontrados en la temporada 2025 completa, ver "Calibración y filtro de confianza" arriba)**:
1. **El recorte de entradas por riesgo de salida temprana sub-proyectaba ponches de pitchers con mal ERA** — dampening al 50% (`EARLY_HOOK_RISK_SCALE`).
2. **Moneyline sobreconfiado en los extremos, especialmente cuando favorecía al visitante** — shrinkage hacia 0.5 (`MONEYLINE_CALIBRATION_SHRINK`).
3. Se agregó un **filtro de confianza mínima** para moneyline (`MIN_MONEYLINE_CONFIDENCE`), apilado sobre `edge_threshold`.

---

## Hallazgos validados del backtest (mayo/junio/julio 2026, config actual)

- El enfoque de bateador individual **sí le gana** al promedio de equipo simple: moneyline 53.7%→~52-56% según el mes, Brier mejoró, totales MAE bajó de 3.78 a ~3.6-3.9. Junio fue un mes flojo (51.4%) pero mayo y julio lo superaron claramente — parece variación normal, no una tendencia.
- **La idea de excluir "equipos irregulares" del bot se descartó** — se investigó a fondo (varianza de carreras, sesgo promedio del modelo, qué tan parejos eran sus partidos) y ninguna explicación estructural se sostuvo. Es ruido de muestra chica (18-55 juegos/equipo/mes), no una característica real de ningún equipo. **Reconfirmado dos veces**: Chicago Cubs fue el más predecible en mayo+junio y el más impredecible de los 30 en julio; y con la config final (10 equipos, mayo/junio/julio 2026 + temporada 2025 completa) el ranking de accuracy por equipo salta sin ningún patrón de un período a otro (ej. Pittsburgh #2 en toda la temporada 2025 pero último en junio 2026; Cubs #1 en junio y último en julio). No usar accuracy-por-equipo-en-un-período para decidir nada sobre el modelo.
- **Experimento "pegar temporada 2025 a 2026" para abril** (`scripts/backtest-season-glue.js`, NO aplicado al bot): mejoró casi todas las métricas de abril vs. arrancar en frío (moneyline 47.6%→49.9%, factor ofensivo promedio 1.061→0.977 casi perfecto). Confirma que el problema de abril es falta de muestra, no diseño del modelo. **Pendiente de decidir** si vale la pena implementarlo en el bot en vivo (usar stats de temporada anterior las primeras semanas de cada temporada nueva).
- Se quitaron las señales de **hits de bateador** por completo (pedido explícito) — ya no se generan en `scan.js` ni en `scripts/backtest.js`.
- Se agregó el mercado de **totales de primeras 5 entradas** (`totals_1st_5_innings` en The Odds API, vía el endpoint por-evento igual que ponches) — debutó con sesgo casi cero en mayo/junio/julio.

## Backtest de la temporada 2025 completa (marzo-septiembre, metodología para futuras sesiones)

Cuando se pide "correr una temporada completa y buscar patrones", el enfoque usado (y que conviene repetir) es:
1. Correr la temporada completa **de una sola vez** (un solo `node scripts/backtest.js <inicio> <fin> "nota"` con todo el rango) en vez de mes por mes — es más eficiente (la libreta de bateo y los caches de pitcher se calientan una sola vez) y evita el riesgo real de "hornear" ruido de un solo mes en la config antes de probar el siguiente (ya pasó con el caso de los Cubs, ver arriba).
2. Buscar patrones sobre el agregado completo (miles de predicciones, no cientos).
3. **Validar cada patrón candidato con holdout real** — partir la temporada en dos mitades independientes (ej. marzo-mayo vs. junio-septiembre) y confirmar que el patrón se repite en ambas por separado, no solo en el agregado. Descartar lo que no se repite.
4. Solo implementar lo que sobrevive el holdout, testear, y re-correr la temporada completa para confirmar la mejora total antes de decidir si se despliega.

La temporada 2025 en esta base de datos va del 18 de marzo al 28 de septiembre. El backtest se corrió 2025-03-25 a 2025-09-28 (~5 días de margen para que la libreta de bateo tenga algo de calentamiento).

## Limitaciones conocidas / pendientes

- El cron automático no re-analiza un juego "ya escaneado hoy" el resto del día (`/senales` sí).
- ~30-40 llamadas a la API de MLB por partido — riesgo de timeout en Vercel Hobby (10s), mitigado con `last_scanned_at`.
- Ponches todavía usa promedio de equipo para el rival, no la libreta individual (sí se usa para moneyline/totales) — candidato a mejora, no se ha probado si ayuda ahí también.
- Bullpen no se usa en ninguna señal — solo el abridor.
- Umpire no implementado.
- `docs/MODEL_INPUTS.md` quedó desactualizado esta sesión — no confiar en él sin revisar contra el código real.
- Cuota de The Odds API se agota fácil — el backtest no la toca, pero correr `runScan()`/`/senales` sí.
- Pendiente decidir sobre el experimento de "pegar temporada anterior" (ver arriba).
- OPS de carrera del bateador: no implementado todavía (se decidió dejarlo fuera de esta sesión).
- `EARLY_HOOK_RISK_SCALE = 0.5` mejoró el bias de ponches en pitchers de mal ERA pero no lo cerró del todo (quedó en +0.27, era +0.35) — candidato a bajar más (ej. 0.3) si se quiere apretar, con el mismo riesgo de sobre-corregir que se vio con los pesos de carrera.
- `MIN_MONEYLINE_CONFIDENCE = 0.08` es un punto de partida conservador (deja ~48% de los partidos) — se puede subir si se prioriza más accuracy sobre volumen de señales.
- El multiplicador `0.3` dentro de `teamWinProbability` (cuánto pesa la desviación del récord de equipo respecto a .500 en la probabilidad final) no se retocó al agregar el récord de temporada completa — podría estar limitando cuánto impacta un desajuste real de calidad. Candidato a probar subirlo y re-correr la temporada completa.
- **Ojo con las señales reales de moneyline y ponches en producción** (n=41 y n=21 respectivamente, `signals` en Supabase) — su acierto real está por debajo del accuracy crudo del backtest, a diferencia de totales (72.9%, muy bien). Muestra muy chica todavía para concluir nada, pero vale la pena revisar de nuevo cuando haya más señales acumuladas.

## Cómo retomar en una sesión nueva

1. Lee este archivo. `docs/MODEL_INPUTS.md` está desactualizado, mejor revisar `lib/signals.js` y `scripts/backtest.js` directamente para el estado real del modelo.
2. `cd C:\Users\anton\OneDrive\Escritorio\MLB && npm test` — deben pasar 219 tests.
3. Para ver el estado del modelo con datos reales: entra al dashboard (`/backtest/`, secreto en `.env` como `DASHBOARD_SECRET`) y revisa las corridas de mayo/junio/julio (las más recientes con la config actual).
4. Para correr un backtest nuevo: `node --env-file=.env scripts/backtest.js <inicio> <fin> "nota"`. Tarda varios minutos por el calentamiento de la libreta de bateo.
5. Para analizar fallos en bulk: `node --env-file=.env scripts/analyze-misses.js <runId> [--market=X] [--limit=N]`.
6. Cualquier cambio al modelo: implementar → testear → correr backtest para comparar contra la config anterior → `git push` → `vercel --prod --yes` → verificar.
