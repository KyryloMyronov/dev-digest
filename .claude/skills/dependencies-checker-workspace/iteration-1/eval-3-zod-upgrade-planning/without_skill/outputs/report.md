# Zod v4 upgrade — pre-flight check (server / client / reviewer-core / mcp)

Дата перевірки: 2026-09-01. Всі числа нижче — реальні встановлені версії з
`node_modules` та актуальних lockfiles (`pnpm-lock.yaml` / `package-lock.json`),
плюс `npm view <pkg> version` для "latest" наживо з registry. Не з декларованих
`^` рейнджів у package.json — ті самі можуть виглядати однаково, ховаючи drift.

## TL;DR

**Version drift по zod між чотирма пакетами відсутній.** Всі чотири резолвляться
рівно в `zod@3.25.76`. Але апгрейд до zod 4 не можна зробити рівномірно одним
PR — є один жорсткий блокер у `server`, якого немає в інших трьох пакетах.
Окрім zod, у репо є кілька залежностей, які відстали на 2–3 мажорних версії і
вартують окремої уваги ще до того, як братися за zod.

## 1. Zod: version drift check

| Пакет | Декларовано (package.json) | Встановлено (реально резолвиться) |
|---|---|---|
| `server` | `^3.24.1` | 3.25.76 |
| `client` | `^3.24.1` | 3.25.76 |
| `reviewer-core` | `^3.24.1` | 3.25.76 |
| `mcp` | `^3.25.0` | 3.25.76 |

Перевірено напряму через `require('.../node_modules/zod/package.json').version`
у всіх чотирьох, і крос-перевірено в lockfile-ах:
- `server/pnpm-lock.yaml`: один запис `zod@3.25.76:` — жодного дубля.
- `client/pnpm-lock.yaml`: той самий один запис `zod@3.25.76:`.
- `reviewer-core/package-lock.json`, `mcp/package-lock.json`: жодних вкладених
  копій zod іншої версії (тільки одна версія в дереві).

Висновок: drift-у немає, це не проблема. `mcp` єдиний, хто задекларував трохи
інший діапазон (`^3.25.0` замість `^3.24.1`), але це косметика — фактично всі
чотири стоять на одному й тому ж патчі. Немає технічної причини не вирівняти
всі чотири на однаковий рядок діапазону при апгрейді.

## 2. Головний блокер апгрейду: `fastify-type-provider-zod` у `server`

Це найважливіша знахідка. `server` не використовує `zod` напряму для Fastify
route schemas — це робить `fastify-type-provider-zod` (`server/package.json:31`,
`^4.0.2`, встановлено 4.0.2).

Перевірив `peerDependencies` кожної мажорної версії цього пакета напряму з
registry:

| Версія `fastify-type-provider-zod` | `zod` peer | `@fastify/swagger` peer | `openapi-types` peer |
|---|---|---|---|
| 4.0.2 (те, що зараз стоїть) | `^3.14.2` | — | — |
| 5.0.0–5.0.3 | `>=3.25.56` | `>=9.5.1` (новий!) | `^12.1.3` (новий!) |
| 5.1.0 | `>=3.25.67` | `>=9.5.1` | `^12.1.3` |
| 6.0.0 / 6.1.0 | `>=4.1.5` (zod3 більше НЕ підтримується) | `>=9.5.1` | `^12.1.3` |
| 7.0.0 (latest) | `>=4.1.5` | `>=9.5.1` | `^12.1.3` |

Це означає:
- Жодна версія не підтримує одночасно zod3 і zod4. Лінія 5.x підтримує тільки
  zod3, лінія 6.x+ — тільки zod4. Апгрейд zod до 4 в `server` мусить бути
  зроблений в одному й тому самому кроці з апгрейдом
  `fastify-type-provider-zod` з 4.0.2 → мінімум 6.0.0 (краще одразу 7.0.0,
  latest). Не можна апгрейднути zod окремо і "подивитись чи все ще працює" —
  типи `fastify-type-provider-zod@4.0.2` просто не приймуть Zod 4 схеми.
- Це саме по собі стрибок на три мажорні версії (4 → 7) пакета, який є
  єдиною точкою інтеграції zod з Fastify route validation/serialization.
- Апгрейд, навіть тільки в межах 4.x → 5.x (без чіпання zod), вже додає два
  нові обов'язкові peer-и, яких зараз немає в `server/package.json` взагалі:
  `@fastify/swagger` (>=9.5.1) та `openapi-types` (^12.1.3). Перевірено —
  в поточному дереві `server` їх немає (в `pnpm-lock.yaml` фігурує лише
  `@octokit/openapi-types`, це інший пакет).

Практичний висновок: апгрейд zod у `server` — це фактично апгрейд трьох
пов'язаних пакетів одночасно (`zod` 3→4, `fastify-type-provider-zod` 4→7,
плюс нові deps `@fastify/swagger` + `openapi-types`), а не bump однієї строчки.

## 3. Чи є той самий блокер в інших трьох пакетах?

- `client` — `zod` використовується напряму для контрактів (Zod-схеми в
  `server/src/vendor/shared/`, дзеркально скопійовані в
  `client/src/vendor/shared/`), Fastify тут немає. Блокера з
  `fastify-type-provider-zod` немає, але оскільки shared-контракт — канонічний
  в `server` і лише синхронізується в `client` (`./scripts/check-contracts.sh`),
  `client` фактично прив'язаний до того ж моменту апгрейду, що й `server` —
  інакше типи розійдуться між копіями.
- `reviewer-core` — залежить від `zod` (^3.24.1) і `openai` (^4.77.0).
  Перевірив `openai@4.104.0` (встановлена версія) — не має `zod` у власних
  dependencies взагалі (ні прямої, ні peer). Тобто `reviewer-core` вільний від
  будь-якого стороннього блокера й міг би апгрейднутись незалежно.
- `mcp` — залежить від `@modelcontextprotocol/sdk@1.30.0`, встановленого і
  актуального (latest = 1.30.0, тобто вже свіжий). Його власний
  `dependencies` вже декларує `zod: "^3.25 || ^4.0"` — тобто SDK вже готовий
  до zod 4, блокера нема.

Тобто по факту єдиний пакет, що тримає весь апгрейд назад, — `server`,
конкретно через `fastify-type-provider-zod`.

## 4. Інші застарілі мажорні версії, варті уваги (окремо від zod)

Перевірено `npm view <pkg> version` (latest з registry) проти реально
встановлених версій у кожному пакеті.

### server

| Пакет | Встановлено | Latest | Мажорних версій позаду |
|---|---|---|---|
| `openai` | 4.104.0 | 7.8.0 | 3 — великий стрибок, чекати SDK breaking changes |
| `fastify-type-provider-zod` | 4.0.2 | 7.0.0 | 3 (описано вище, блокер #1) |
| `@fastify/cors` | 10.1.0 | 11.3.0 | 1 |
| `dependency-cruiser` | 17.4.3 | 18.2.0 | 1 |
| `octokit` | 4.1.4 | 5.0.5 | 1 |
| `@anthropic-ai/sdk` | 0.33.1 | 0.123.0 | 0.x, але 90 minor-релізів позаду — фактично багато накопичених breaking changes |
| `drizzle-orm` | 0.38.4 | 0.45.2 | 0.x, 7 minor-релізів позаду |
| `vitest` | 2.1.9 | 4.1.11 | 2 |
| `typescript` | 5.9.3 | 7.0.2 | 2 |
| `fastify`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/autoload`, `postgres`, `drizzle-kit` | — | — | той самий мажор, лише minor/patch позаду — низький пріоритет |

### client

| Пакет | Встановлено | Latest | Мажорних версій позаду |
|---|---|---|---|
| `next` | 15.5.19 | 16.3.4 | 1 |
| `recharts` | 2.15.4 | 3.10.1 | 1 |
| `react-markdown` | 9.1.0 | 10.1.0 | 1 |
| `vitest` | 2.1.9 | 4.1.11 | 2 (той самий across-repo борг, що й у server) |
| `typescript` | 5.9.3 | 7.0.2 | 2 (той самий across-repo борг) |
| `react`/`react-dom`, `@tanstack/react-query`, `tailwindcss`, `mermaid`, `jszip` | — | — | той самий мажор, свіжо |

### reviewer-core / mcp

| Пакет | Встановлено | Latest | Коментар |
|---|---|---|---|
| `openai` (reviewer-core) | 4.104.0 | 7.8.0 | той самий борг у 3 мажори, що й у `server` |
| `vitest`, `typescript` | 2.1.9 / 5.9.3 | 4.1.11 / 7.0.2 | той самий репо-широкий борг |
| `@modelcontextprotocol/sdk` (mcp) | 1.30.0 | 1.30.0 | вже актуальний |

### Наскрізний борг (торкається всіх 4+e2e пакетів)

- `typescript`: усі п'ять пакетів на `^5.7.x` → встановлено 5.9.3, latest у
  registry вже 7.0.2 (два мажори позаду). Це найбільш системний technical
  debt в репо — торкається кожного пакета одразу.
- `vitest`: всі три тестові suite (server/client/reviewer-core+mcp) на
  `^2.1.8` → встановлено 2.1.9, latest 4.1.11 (два мажори позаду).

`e2e` перевірено окремо для повноти: там взагалі немає `zod` серед залежностей
(лише `@types/node`, `tsx`, `typescript`), тож він не бере участі в цьому
конкретному drift-питанні.

## 5. Рекомендація по порядку робіт

1. Не робити спочатку "просто zod". Спочатку розвідати
   `fastify-type-provider-zod@7.0.0` (peer: `zod>=4.1.5`, `fastify^5.5.0`,
   новий `@fastify/swagger>=9.5.1`, `openapi-types^12.1.3`) — це має бути один
   об'єднаний PR разом із zod 3→4 саме в `server`.
2. `reviewer-core` і `mcp` можна апгрейднути до zod 4 незалежно і раніше —
   блокерів немає.
3. `client` тримати в синхроні з `server` (через
   `./scripts/check-contracts.sh --fix`), бо shared-контракт канонічний в
   `server`.
4. `openai` (4→7, і в `server`, і в `reviewer-core`) і `typescript`/`vitest`
   (по всьому репо) — окремі, більші за обсягом апгрейди; варто планувати як
   окремі задачі, не змішувати з zod-міграцією.

## Методологія (для відтворюваності)

- Встановлені версії: `node -e "console.log(require('./<pkg>/node_modules/<dep>/package.json').version)"` — по кожному пакету, по кожній прямій залежності.
- Крос-перевірка на дублі версій: `grep -n "zod@" server/pnpm-lock.yaml client/pnpm-lock.yaml`, `grep "zod" reviewer-core/package-lock.json mcp/package-lock.json`.
- Latest з registry: `npm view <pkg> version` / `npm view <pkg>@<version> peerDependencies`.
- Це НЕ використовувало проєктний skill `dependencies-checker` — виконано вручну інструментами Bash/Read/Grep за прямою вимогою задачі.
