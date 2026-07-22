# Bot de Telegram — Señales de apuestas MLB (Diseño)

**Fecha:** 2026-07-22
**Estado:** Aprobado por el usuario, pendiente de implementación

## Contexto

El usuario ya opera `mlb2026-stats` (Desktop), un sitio HTML/JS que consume `statsapi.mlb.com` y
`bdfed.stitch.mlbinfra.com` con datos ricos de MLB: standings, roster de bateadores, historial
pitcher-vs-equipo y pitcher-vs-pitcher (career + gamelog + box score). Este proyecto nuevo reutiliza
esa fuente de datos para generar señales de apuestas, cruzándola con cuotas de The Odds API (ya
contratada por el usuario), y las entrega vía un bot de Telegram de uso personal (un solo chat).

## Objetivo

Un bot de Telegram que:
1. Cruza datos de MLB (stats, matchups) con cuotas de una casa de apuestas (The Odds API).
2. Calcula una probabilidad estimada de cada resultado con una heurística transparente.
3. Genera "señales" cuando hay edge (probabilidad estimada > probabilidad implícita de la cuota)
   por encima de un umbral configurable.
4. Muestra el razonamiento detrás de cada señal para que el usuario pueda auditarla antes de actuar.
5. Permite validar históricamente (backtesting direccional) qué tan bien habría acertado la
   heurística en partidos pasados, antes de confiar en ella en vivo.

## Alcance

- Uso **personal**, un solo chat de Telegram (no multi-usuario).
- Mercados: **moneyline, totals (over/under carreras), player props** (hits, HR, ponches).
- Hosting: **Vercel** (serverless), igual que los otros proyectos del usuario.
- Base de datos: **Supabase (Postgres)** — nueva, recomendada por no tener ninguna ya configurada.
- Fuente de odds: **The Odds API** (ya contratada).
- Fuente de stats: `statsapi.mlb.com` / `bdfed.stitch.mlbinfra.com` (reutilizando patrones de
  `mlb2026-stats`).

## Arquitectura

Repo nuevo `MLB/` (o nombre final del proyecto) desplegado en Vercel:

```
/api/telegram-webhook.js   # recibe updates de Telegram (comandos)
/api/scan.js               # invocado por Vercel Cron: escanea juegos del día, genera y envía señales
/lib/mlb.js                # cliente statsapi.mlb.com (standings, rosters, matchups, career splits)
/lib/odds.js                # cliente The Odds API (moneyline, totals, player props MLB)
/lib/signals.js             # motor de heurística: prob. estimada vs prob. implícita, edge, motivo
/lib/db.js                  # cliente Supabase
/scripts/backtest.js        # script de backtesting direccional sobre partidos pasados de la temporada
```

Telegram opera en **modo webhook** (no polling), consistente con el hosting serverless.

## Motor de señales (heurística v1)

Fórmula transparente y ajustable a mano, no caja negra ni modelo entrenado (se deja espacio para
evolucionar a un modelo estadístico más adelante si el backtesting lo justifica).

- **Moneyline**: variante tipo *log5* combinando ERA/WHIP reciente de abridores, historial
  head-to-head pitcher vs equipo rival, récord reciente de cada equipo (últimos 10), ventaja de
  local.
- **Totals**: proyección de carreras combinando ERA/WHIP esperado de ambos abridores + promedio de
  carreras anotadas/permitidas reciente de ambos equipos, comparada contra la línea de la casa.
- **Player props**: tasa esperada del jugador (ej. hits, HR, ponches) usando historial del bateador
  vs mano del pitcher (Z/D) o historial career del pitcher, comparada contra la línea de la prop.

**Regla de señal:** se genera una señal cuando
`prob_estimada − prob_implícita_de_la_cuota > umbral` (umbral configurable, default 5%,
ajustable vía comando `/config edge N`).

**Formato de mensaje** (incluye siempre el motivo, no solo el pick):

```
⚾ NYY @ BOS — Moneyline: BOS gana
Cuota: 1.85 (implícita 54.1%) | Estimada: 61.3% | Edge: +7.2%
Motivo: ERA abridor BOS 2.87 (últimos 5) vs NYY históricamente .215 AVG
contra zurdos similares; BOS 8-2 últimos 10 en casa.
```

## Datos (Supabase)

- `games` — juegos del día: game_pk, equipos, fecha, estado (programado/en vivo/terminado/pospuesto).
- `team_map` / `player_map` — mapeo nombre MLB ↔ nombre usado por The Odds API (se completa la
  primera vez que aparece un mismatch; entradas pendientes se loguean y esa señal se omite hasta
  resolverse).
- `signals` — cada señal generada: mercado, selección, cuota, prob. estimada, edge, motivo (texto),
  timestamp, game_pk. Sirve también como control de duplicados (no reenviar la misma señal el mismo
  día).
- `results` — resultado real del juego/prop, completado tras finalizar el partido vía `statsapi`,
  para marcar cada señal como acierto/fallo.

## Backtesting

Script manual (`/scripts/backtest.js`, no serverless) que:
1. Toma partidos pasados de la temporada actual (`statsapi` tiene histórico).
2. Reconstruye qué señal habría generado la heurística con las stats disponibles *antes* de ese
   partido.
3. Compara contra el resultado real.

**Limitación conocida:** The Odds API no ofrece odds históricas en el plan del usuario, por lo que
el backtest mide **acierto direccional** (¿la heurística acertó el resultado?), no ROI real
(no se puede reconstruir el edge histórico). Si en el futuro se contrata un plan con odds
históricas, se puede añadir ROI real al backtest.

## Interfaz de Telegram

**Comandos:**
- `/hoy` — lista los juegos de MLB del día con su estado.
- `/senales` — corre el análisis bajo demanda para los juegos del día, devuelve señales encontradas.
- `/partido <equipo>` — análisis específico de ese juego (moneyline, totals, props destacadas),
  con o sin edge suficiente para calificar como señal.
- `/config edge <N>` — ajusta el umbral mínimo de edge sin tocar código.

**Push automático:** Vercel Cron corre en horario de juegos (ej. cada hora, 12pm–11pm ET), escanea
los juegos del día y envía señales nuevas. Usa la tabla `signals` para no duplicar señales ya
enviadas para el mismo juego/mercado el mismo día.

## Manejo de errores

- **Juego pospuesto/cancelado**: se marca en `games`, se omite del scan.
- **Sin mapeo odds↔MLB** para un equipo/jugador: se loguea como pendiente en `team_map`/
  `player_map`, se omite esa señal (nunca se envía con datos incompletos).
- **Rate limit de The Odds API**: el scan se salta ese ciclo y reintenta en el próximo cron sin
  fallar el resto del proceso.

## Testing

- Pruebas unitarias del motor de heurística (`signals.js`) con casos fijos (inputs conocidos →
  edge esperado).
- Prueba manual de `/senales` contra un chat de Telegram de prueba antes de activar el cron en
  producción.

## Fuera de alcance (por ahora)

- Multi-usuario / suscripciones de otros usuarios al bot.
- Modelo estadístico entrenado (regresión logística, Elo) — posible evolución futura tras validar
  la heurística con backtesting.
- ROI histórico real en el backtest (requiere plan de The Odds API con odds históricas).
