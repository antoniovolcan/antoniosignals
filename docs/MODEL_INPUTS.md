# Qué datos usa cada señal

Referencia de todos los stats/factores que entran en cada tipo de señal, para llevar control de qué agregar o quitar. Última actualización: 2026-07-25.

---

## Moneyline (quién gana)

| Factor | Fuente | Detalle |
|---|---|---|
| ERA del abridor — temporada completa | MLB API, stats de temporada del pitcher | |
| ERA del abridor — últimos 5 arranques | MLB API, gameLog del pitcher, ordenado por fecha | Se combina con el de temporada (60% reciente / 40% temporada) |
| Récord últimos 10 juegos del equipo | MLB API, standings | |
| Ventaja de jugar de local | Constante fija (+4%) | |
| OPS del lineup titular vs. mano del pitcher rival | MLB API, boxscore del último partido jugado (lineup real) + stats de cada bateador titular vs esa mano específica (zurdo/derecho) | Promedio de los primeros 5 bateadores del lineup |

**Cómo se combina:** cada equipo obtiene una "probabilidad de ganar" individual (ERA combinado × factor ofensivo, ajustado por récord reciente y localía), limitada entre 30%-70% para evitar exceso de confianza. Las dos probabilidades se combinan con la fórmula log5 (sabermetría clásica) para dar la probabilidad final de cada equipo.

**No se usa todavía:** bullpen, clima, parque de juego, lesiones, umpire, descanso del pitcher.

---

## Totales (Over/Under carreras)

| Factor | Fuente | Detalle |
|---|---|---|
| ERA del abridor — temporada + últimos 5 | Igual que en moneyline | Combinado 60/40 |
| Carreras por partido — temporada completa | MLB API, stats de bateo de temporada del equipo | |
| Carreras por partido — últimos 15 días | MLB API, stats de bateo por rango de fechas | Combinado con temporada (60% reciente / 40% temporada) |
| OPS del lineup titular vs. mano del pitcher rival | Igual que en moneyline | Multiplica el promedio de carreras del equipo |

**Cómo se combina:** proyección de carreras de cada equipo = su propio promedio de carreras (reciente+temporada) × qué tan bien le pega su lineup a esa mano de pitcher, ajustado por el ERA del pitcher rival. Suma de ambos equipos = proyección total. Se compara contra la línea de la casa con una distribución estadística (curva normal) para sacar la probabilidad de Over/Under.

**No se usa todavía:** bullpen, clima/viento, parque de juego (algunos estadios favorecen más las carreras que otros), umpire.

---

## Ponches del pitcher (Over)

| Factor | Fuente | Detalle |
|---|---|---|
| Ponches por 9 innings — temporada completa | MLB API, stats de temporada del pitcher | |
| Ponches por 9 innings — últimos 5 arranques | MLB API, gameLog del pitcher | Combinado 60/40 con temporada |
| Innings esperados por arranque | MLB API, temporada del pitcher (innings totales ÷ arranques) | Real del pitcher, no un número fijo |
| **Riesgo de salida corta** | Calculado (`adjustedInningsForEarlyHookRisk`) | Si el ERA del pitcher está por encima del promedio de liga **y** enfrenta una ofensiva rival por encima del promedio (mismo `offensiveFactor` que usa moneyline/totales), se reducen los innings esperados hasta un 35% (piso de 2.0 innings) — asume que lo sacan antes si le entran carreras |
| Mano de pitcheo (zurdo/derecho) | MLB API, perfil del jugador | |
| Tasa de ponches del lineup titular rival vs. esa mano | MLB API, boxscore del último partido + stats de cada bateador titular vs esa mano | Promedio de los primeros 5 bateadores |
| **Forma general reciente del rival** | MLB API, `byDateRange` (últimos 15 días, mismo fetch que usa totales) | Tasa de ponches del equipo en general (no solo vs. esa mano), combinada 70/30 con la tasa específica vs. mano |
| **Mezcla poder/contacto del lineup rival** | Calculado (`computePowerContactFactor`), a partir de HR y AVG de cada bateador titular vs. esa mano (mismo fetch que la tasa de ponches, sin llamadas extra) | Bateadores con tasa de HR alta (jonroneros) suben la proyección de ponches; bateadores de AVG alto y pocos HR (contacto puro) la bajan. Factor acotado a ±15% |
| **Factor de parque** | Tabla estática manual (`lib/parkFactors.js`), por equipo local | Aproximado — algunos parques (ej. Coors Field, por la altura) suprimen ponches; otros (ej. Oracle Park, Dodger Stadium) los favorecen levemente. Acotado 0.93x–1.04x |
| **Clima** | MLB API, `feed/live` del juego (`gameData.weather`) — mejor esfuerzo, puede no estar disponible con mucha anticipación | Frío favorece levemente al pitcher (+3%), calor lo perjudica levemente (-2%), viento fuerte (≥15 mph) hacia afuera/adentro ajusta ±2%. Si no hay dato de clima, no afecta la proyección (factor neutral) |

**No se usa todavía:** situación del bullpen (quién puede relevar si el abridor sale temprano), historial específico pitcher-vs-bateador.

---

## Hits del bateador (Over)

| Factor | Fuente | Detalle |
|---|---|---|
| Promedio de bateo (AVG) — temporada completa | MLB API, stats de temporada del bateador | |
| Turnos al bate por juego | MLB API, stats de temporada del bateador | |

**No se usa todavía:** desglose vs. mano del pitcher específico (esta señal SÍ podría beneficiarse de la misma técnica que ya usamos en moneyline/totales/ponches — pendiente si se quiere agregar).

---

## Notas generales

- **"Recomponentes 60/40"**: en todos los casos donde combinamos temporada + reciente, el peso es 60% al dato reciente y 40% a la temporada completa (más peso a la forma actual, sin ignorar la muestra grande).
- **"Últimos 5 arranques" / "últimos 15 días"**: son ventanas fijas, no configurable todavía por comando de Telegram.
- **Lineup titular**: se saca del último partido REALMENTE jugado por el equipo (orden real al bate), no un roster genérico. Si no hay partido reciente disponible (ej. inicio de temporada), usa el roster completo como respaldo.
- **Todas las señales** requieren que el "edge" (diferencia entre probabilidad estimada y la de la cuota) supere el umbral configurado (`/config edge`, 5% por defecto) antes de enviarse.

## Historial de cambios grandes al modelo

- 2026-07-24: proyección de carreras totales pasó de usar un número fijo (4.5 carreras/partido) a usar el promedio real de cada ofensiva.
- 2026-07-25: se corrigió un bug que hacía que el moneyline diera probabilidades irreales (90%+); se limitó a un rango 30%-70%.
- 2026-07-25: se agregó el ERA de temporada combinado con el reciente para moneyline (antes solo usaba reciente).
- 2026-07-25: ponches de pitcher pasó de usar el roster completo a usar el lineup real del último partido, y de un número fijo de innings (5.5) a los innings reales del pitcher.
- 2026-07-25: se agregó el "factor ofensivo" (forma reciente + OPS del lineup vs. mano del pitcher rival) a moneyline y totales.
- 2026-07-25: ponches de pitcher ahora considera además: forma general reciente del rival (no solo vs. mano), mezcla poder/contacto del lineup (HR vs. AVG), riesgo de salida corta si el pitcher tiene mal ERA contra una ofensiva fuerte, factor de parque, y clima (mejor esfuerzo).
