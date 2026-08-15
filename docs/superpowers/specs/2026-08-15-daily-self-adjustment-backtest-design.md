# Backtest de auto-ajuste diario (análisis, no producción)

## Propósito

Responder una pregunta conceptual del usuario: si el modelo de moneyline se
auto-ajustara un poco cada día en base a los resultados reales del día
anterior (en vez del proceso manual de backtesting + validación que se usó
para los 6 candidatos de esta sesión), ¿mejoraría o empeoraría con el correr
de la temporada?

Es un experimento de análisis, igual en espíritu al "modelo secundario" de
sobreajuste que ya se corrió antes en esta sesión (dummies por equipo,
colapsó fuera de muestra a 50.9%). No es un candidato para producción — no
toca `lib/signals.js`, `api/scan.js` ni `scripts/backtest.js`.

## Fuente de datos

Reutiliza los `factors` ya capturados en el run #50 de Supabase
(`backtest_predictions`, `run_id=50`, `market='moneyline'`, temporada
completa 2025-03-25 a 2025-09-28, 2427 predicciones). Cada fila tiene los
ingredientes crudos ya verificados en esta sesión: `homeSeasonEra`,
`homeRecentEra`, `homeCareerEra` (y away), `homeSeasonWinPct`,
`homeRecentWinPct` (y away), `homeOffensiveFactor`/`awayOffensiveFactor`,
`homeStartsCount`/`awayStartsCount`, y el resultado real (`actual_outcome`).

No hace falta un backtest nuevo contra la API de MLB — corre en segundos
sobre datos ya guardados.

## Parámetros que se auto-ajustan (7, todos continuos)

Reconstruidos a partir de las funciones reales de `lib/signals.js`
(`teamWinProbability`, `calibrateWinProbability`, `log5`,
`applyThinSampleDampening`, `pitcherFactor`, `blendEraEstimates`) para
garantizar que la fórmula base coincide exacto con producción antes de
dejar que el ajuste diario la mueva:

1. `homeFieldBonus` (prod: 0.09)
2. `recordAdjScale` (prod: 0.5)
3. `clampLo` (prod: 0.20)
4. `clampHi` (prod: 0.80)
5. `careerWeight` — peso de ERA de carrera en el blend de moneyline (prod: 0.15)
6. `recentWeight` — peso reciente/temporal del récord de equipo (prod: 0.3)
7. `shrink` — shrink de calibración de `calibrateWinProbability` (prod: 0.5)

Quedan fijos (no se ajustan): el umbral y shrink de muestra chica
(`THIN_SAMPLE_STARTS_THRESHOLD`/`THIN_SAMPLE_EXTRA_SHRINK`) porque el umbral
es un entero discreto, mal candidato para descenso de gradiente continuo.

Arranca desde los valores de producción actuales (55.99% de accuracy real,
run #48), no desde cero.

## Mecanismo: descenso de gradiente numérico sobre Brier score diario

La precisión (acierto/fallo, umbral en 0.5) no es diferenciable. El Brier
score (error cuadrático contra el resultado real 0/1) sí lo es y ya es la
métrica de calibración usada toda la sesión.

Por cada día del calendario, en orden cronológico:

1. Predecir todos los juegos de moneyline de ese día con los parámetros
   actuales.
2. Calcular el Brier score total del día.
3. Para cada uno de los 7 parámetros: perturbar +ε, recalcular el Brier del
   día, estimar la derivada numérica (diferencia finita). Repetir para -ε si
   hace falta central difference.
4. Dar un paso de tamaño `learningRate * gradiente` en la dirección que
   reduce el Brier, con un clamp razonable por parámetro para evitar que se
   vaya a valores absurdos (ej. `clampLo` nunca cruza `clampHi`).
5. Los parámetros actualizados se usan para predecir el día siguiente.

Se prueban 2-3 tasas de aprendizaje (ej. 0.001, 0.005, 0.02) para mostrar el
rango de comportamiento: muy chica (casi no se mueve) vs. razonable vs. muy
agresiva (inestable).

## Qué se mide y reporta

- Accuracy del modelo con auto-ajuste vs. baseline estático (55.99%),
  partido en las dos mitades de temporada ya establecidas (marzo-junio vs
  julio-septiembre).
- Trayectoria de cada uno de los 7 parámetros a lo largo de la temporada
  (¿convergen a algo estable? ¿se van a un extremo? ¿oscilan?).
- Comparación de Brier score total, no solo accuracy.

## Alcance y entregable

Script suelto de análisis (mismo patrón que los `candidate_*.js` de hoy),
no comiteado, borrado al terminar. Resultados documentados en
`context.md`. No hay cambio de código de producción en este trabajo — es
puramente para responder la pregunta conceptual del usuario con evidencia.
