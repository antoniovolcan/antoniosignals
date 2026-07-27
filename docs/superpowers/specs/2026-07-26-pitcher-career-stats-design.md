# Pitcher career stats (ERA/K9) as a third blend layer — design

## Contexto

El modelo actual blendea el ERA y K/9 de cada abridor en dos niveles: reciente (últimos 5
arranques, 60%) + temporada actual (40%), vía `blendEraEstimates` en `lib/signals.js`. No usa
nada de temporadas anteriores del jugador.

Un pitcher puede tener una temporada actual/reciente atípica (buena o mala) que no refleje su
nivel real de carrera. La idea es agregar el ERA y K/9 de carrera (todas las temporadas
regulares anteriores a la actual) como un tercer input, con un peso deliberadamente bajo para
que no domine sobre el rendimiento actual — que sigue siendo lo más importante.

Fuera de alcance por ahora: el OPS de carrera del bateador (se decidió no tocarlo en esta
iteración).

## Definición de "carrera"

Carrera = suma de todas las temporadas de tipo regular (`gameType: 'R'`) **estrictamente
anteriores** a la temporada bajo análisis (todas para el bot en vivo, la del backtest para el
backtest). No incluye nada de la temporada en curso.

Esta definición es intencional: al no incluir la temporada actual, es exactamente el mismo
dato tanto en vivo como en el backtest walk-forward — no hace falta inventar una versión
"as of past date" distinta para cada uno, porque las temporadas anteriores ya están 100%
cerradas y no pueden filtrar información futura sin importar cuándo se corra el código.

Si un pitcher no tiene ninguna temporada regular anterior (su primera temporada en MLB), no
hay componente de carrera: se usa el blend actual (reciente+temporada) tal cual, sin inventar
un valor de reemplazo (ni el promedio de liga).

## Fuente de datos y trampa a evitar (deduplicación por trade)

Endpoint: `GET /people/{id}/stats?stats=yearByYear&group=pitching` (sin parámetro `season` —
devuelve todas las temporadas del jugador en un solo response, cada una como un split con
`season`, `gameType`, `team`, y el objeto `stat` con `earnedRuns`, `inningsPitched`,
`strikeOuts`, `outs`, etc. — mismo shape que el gameLog que ya se usa).

**Trampa verificada con una llamada real (Scherzer, personId 453286):** cuando un pitcher es
canjeado a mitad de temporada, esa temporada aparece **más de una vez** — una fila por cada
equipo, más una fila combinada (sin campo `team`) con el total correcto de esa temporada.
Ejemplo real, temporada 2021: Washington (111.0 IP) + Dodgers (68.1 IP) + una fila combinada
(179.1 IP — la suma real). Sumar todas las filas ciegamente triplicaría innings/ER/K de
cualquier temporada con trade.

Mitigación: antes de sumar, se agrupan los splits por `season`; si una temporada tiene más de
una fila, se usa únicamente la fila sin `team` (el total ya combinado por MLB); si tiene una
sola fila, se usa esa. Esto es necesario para cualquier jugador con varios años de carrera, no
un caso raro.

## Cambios en `lib/mlb.js`

- `fetchPitcherYearByYearStats(personId)` — pega al endpoint de arriba.
- `computeCareerEraBeforeSeason(yearByYearResponse, season)` — dedup por temporada (ver
  arriba), filtra `gameType === 'R'` y `Number(split.season) < season`, suma innings (vía
  `inningsPitchedToOuts`, reusando el helper existente) y earned runs, devuelve
  `earnedRuns*9/innings`. Devuelve `null` si no hay ninguna temporada anterior calificada.
- `computeCareerK9BeforeSeason(yearByYearResponse, season)` — misma dedup/filtro, con
  `strikeOuts*9/innings`. Devuelve `null` en el mismo caso.

## Cambios en `lib/signals.js`

- `CAREER_ERA_WEIGHT = 0.9` y `CAREER_K9_WEIGHT = 0.9` (peso que se le da al blend
  reciente+temporada frente a carrera; o sea, arranca en 10% carrera / 90% blend actual —
  punto de partida para recalibrar con el backtest, mismo patrón que
  `LEAGUE_AVG_TOP_WEIGHTED_OPS`).
- No se crea una función nueva de 3 argumentos: se reusa `blendEraEstimates` en cascada.
  ```js
  const recentSeasonEra = blendEraEstimates(recentEra, seasonEra, 0.6); // ya existe
  const finalEra = careerEra == null
    ? recentSeasonEra
    : blendEraEstimates(recentSeasonEra, careerEra, CAREER_ERA_WEIGHT);
  ```
  Mismo mecanismo para K9.

## Integración en `api/scan.js` (bot en vivo)

Junto a `fetchPitcherGameLog(pitcherId, SEASON)`, se pide en paralelo
`fetchPitcherYearByYearStats(pitcherId)` para cada abridor probable (2 llamadas extra por
partido). Es MLB Stats API — no consume cuota de Odds API. `SEASON` (año actual) es el corte
para "antes de la temporada actual".

El ERA/K9 final de cada pitcher (usado en moneyline, totales, F5 y ponches) pasa por el blend
de 3 niveles de arriba. El mensaje de Telegram de cada señal que ya menciona el ERA de
temporada/reciente del abridor agrega una nota corta con el ERA de carrera cuando exista
(ej. "carrera: 3.85 en N temporadas").

## Integración en `scripts/backtest.js`

Mismo mecanismo, con dos diferencias por ser histórico:

1. El corte de temporada es `season` (el año que se está backtesteando), no el año calendario
   real en el que se corre el script — así carrera = todo antes de esa temporada, sin importar
   cuándo se ejecuta el backtest.
2. Se cachea por `pitcherId` igual que `gameLogCache`/`pitchHandCache` (un fetch por pitcher
   por corrida completa, ya que las temporadas anteriores no cambian día a día dentro del rango
   del backtest).

`computePitcherProfileAsOf` pasa a incluir `careerEra`/`careerK9` (o `null`) en el objeto que
devuelve, y `factors` en `backtest_predictions` incluye el ERA/K9 final ya blendeado (como ya
ocurre) — no hace falta guardar el career crudo por separado, ya que se puede recalcular
recorriendo el yearByYear si algún día hace falta auditar un fallo puntual.

## Tests

- `computeCareerEraBeforeSeason` / `computeCareerK9BeforeSeason`:
  - Suma correctamente varias temporadas anteriores.
  - Ignora la temporada actual y cualquier futura.
  - Ignora `gameType` distinto de `'R'` (pretemporada).
  - Deduplica correctamente una temporada con trade (usa la fila combinada, no triplica).
  - Devuelve `null` cuando no hay ninguna temporada calificada (novato).
- Verificación de que el blend en cascada (`blendEraEstimates` dos veces) da el resultado
  esperado con pesos conocidos, y que cuando `careerEra` es `null` el resultado es idéntico al
  blend de 2 niveles de siempre (no debe cambiar el comportamiento actual para novatos).

## Plan de validación (antes de decidir el peso final)

Con el peso inicial de 10% ya en el código (no en 0%, según lo decidido), el siguiente paso
después de implementar es correr `scripts/backtest.js` sobre mayo/junio/julio 2026 (los mismos
meses ya validados) y comparar bias/MAE/RMSE/accuracy/Brier contra las corridas existentes con
esa config. Si el peso de 10% no mueve las métricas de forma clara, se puede probar 20-30% en
corridas adicionales antes de decidir qué queda en producción — igual que se hizo con
`LEAGUE_AVG_TOP_WEIGHTED_OPS` en la sesión anterior.
