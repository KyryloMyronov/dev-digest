# PR Self Review — план скіла

Локальний гейт якості, що прогонить усі відкриті зміни через релевантні скіли
репо перед відкриттям PR. Один critical finding → відкриття PR блокується.

---

## 0. Мета і межі

**Робить:** збирає весь незамерджений diff (закомічений + робоче дерево +
untracked), зіставляє змінені файли зі скілами `.claude/skills/`, прогонить
детерміновані перевірки репо, віддає verdict і блокує `gh pr create` / `git push`.

**Не робить:** не блокує merge на GitHub. Локальний скіл цього не може —
справжній merge-блок це required status check (етап 5). Локальний рівень
блокує *відкриття* PR і push.

---

## 1. Артефакти

```
.claude/skills/pr-self-review/
  SKILL.md              # оркестрація фаз, verdict, формат звіту
  routing.md            # glob → скіли (єдине джерело правди)
  repo-invariants.md    # власні правила репо + як їх перевіряти
  severity.md           # що є critical саме тут
  collect.sh            # git-збір changeset → JSON
  invariants.sh         # детерміновані перевірки з repo-invariants.md
  gate.sh               # дешевий вартовий для хуків
.claude/settings.json                    # PreToolUse hook (зараз є лише settings.local.json)
.githooks/pre-push                       # + core.hooksPath у scripts/dev.sh
.github/workflows/pr-self-review.yml     # етап 5, справжній merge-блок
.gitignore                               # + .pr-self-review/
```

---

## 2. Фаза 1 — збір changeset (`collect.sh`)

База: `git merge-base origin/main HEAD` (базова гілка репо — `main`).

Об'єднати три набори, бо «відкриті зміни» ≠ тільки коміти:

| Джерело | Команда |
|---|---|
| закомічене на гілці | `git diff --name-status <base>...HEAD` |
| staged + unstaged | `git diff HEAD` |
| untracked | `git ls-files --others --exclude-standard` |

Виключити зі змісту рев'ю (але порахувати й повідомити): `server/clones/**`,
`dist/`, `.next/`, `coverage/`, `*.tsbuildinfo`.

Вихід — `.pr-self-review/changeset.json`: `{path, status, package, hash, skills[]}`.
`hash` потрібен фазі 4 для інкрементальності.

---

## 3. Фаза 2 — маршрутизація (`routing.md`)

| Змінені файли | Скіли |
|---|---|
| `client/src/app/**`, `client/src/components/**`, `client/src/lib/hooks/**` | `frontend-ui-architecture`, `react-best-practices`, `next-best-practices` |
| `client/**/*.test.tsx` | `react-testing-library` |
| `server/src/modules/*/routes.ts` | `fastify-best-practices`, `onion-architecture` |
| `server/src/modules/*/service.ts`, `server/src/adapters/**` | `onion-architecture` |
| `server/src/modules/*/repository*.ts`, `server/src/db/**` | `drizzle-orm-patterns`, `onion-architecture` |
| `server/src/db/schema*.ts`, `server/src/db/migrations/**` | `postgresql-table-design` |
| `reviewer-core/src/**` | `onion-architecture` (чистота ring 1 — без I/O) |
| `*/vendor/shared/contracts/**` | `zod` + обов'язковий `check-contracts.sh` |
| `e2e/**` | без скіла — правила з `e2e/AGENTS.md` |
| будь-який `*.ts` / `*.tsx` | `typescript-expert` |
| завжди | `security` |

Перед рев'ю пакета — прочитати його `insights.md` + кореневий (вимога `AGENTS.md`).

### Звіт покриття

Обов'язкова секція у звіті: які скіли на які файли пішли **і які файли не
отримали жодного**. Робить маршрутизацію аудитованою — інакше `routing.md`
тихо гниє при появі нових модулів. Файл без покриття це не помилка, а сигнал
дописати рядок у таблицю.

---

## 4. Фаза 3 — детерміновані перевірки

Дешеві, першими, паралельно, тільки для зачеплених пакетів. Червоний
`lint:arch` робить LLM-рев'ю архітектури зайвим — відсікаємо до витрати токенів.

### 4a. Наявний тулінг

`./scripts/check-contracts.sh` → `server: pnpm lint:arch` → `pnpm typecheck`
(server / client / reviewer-core) → `pnpm test`.

### 4b. Інваріанти репо (`invariants.sh`)

Те, чого вендорені скіли не знають. Grep-рівень, нуль хибних спрацювань:

| # | Перевірка | Severity |
|---|---|---|
| 1 | правка hash-locked скіла руками (список — з `skills-lock.json` у корені; локальні й дозволені: `engineering-insights`, `onion-architecture`, `frontend-ui-architecture`) | critical |
| 2 | правка `client/src/vendor/**` без відповідної зміни в `server/src/vendor/shared/**` — редагування дзеркала замість джерела | critical |
| 3 | правка вже застосованої міграції в `server/src/db/migrations/**` | critical |
| 4 | нова доменна таблиця в `server/src/db/schema*.ts` без `workspace_id` | critical |
| 5 | нова залежність зі build-скриптами без запису в `allowBuilds:` (`server/pnpm-workspace.yaml`, `client/pnpm-workspace.yaml`) — інакше падає в CI, не локально | major |
| 6 | секрет / креденшел / `.env` у changeset | critical |
| 7 | випадкові артефакти в changeset (`*.png`, тимчасові скрипти, вивід дебагу) | major |

Перевірка 7 спрацювала б на поточному дереві просто зараз: `img.png`, `popup.png`,
`cell*.png` — untracked і **не** в `.gitignore`, тобто поїхали б у PR.

---

## 5. Фаза 4 — рев'ю зі скілами

Для кожної групи файлів завантажити її скіли й рев'ювити.

**Виконання:** послідовно в основному контексті. Просто, дешево, детерміновано.
Прапорець `--parallel` (субагент на групу: frontend / backend / contracts /
security) — пізніше, коли буде видно реальний час прогону.

### Рев'ю по diff, не по файлу

Findings тільки на рядках diff. Інакше кожен дотик до старого файлу приносить
чужі проблеми і гейт стає нескінченним.

### Інкрементальність

Кеш `.pr-self-review/cache/` по хешу вмісту файлу з фази 1. Цикл
«прогнав → пофіксив → прогнав» це основний режим; з кешем другий прогін
перевіряє 2 файли замість 40. Інвалідація: змінився хеш файлу, `routing.md`
або сам скіл.

### Формат finding

```
{file, line, severity, skill, rule, why, fix}
```

`rule` — посилання на конкретне правило скіла. Finding без прив'язки до
правила відкидається: це відсікає вигадане.

---

## 6. Severity

`critical` — блокує. Вузько і перевірювано:

- запит до доменної таблиці без `workspace_id` (головний інваріант репо — витік між тенантами)
- порушення dependency rule, зловлене `lint:arch`
- розсинхрон `shared` контрактів (server ≠ client)
- OWASP-клас вразливість, досяжна з користувацького вводу
- секрет у diff
- `typecheck` або `test` червоні
- інваріанти 1, 2, 3, 4, 6 з §4b

`major` / `minor` — у звіті, **не блокують**. Навмисно: гейт, який спрацьовує
на стилі, вимикають на другий день.

---

## 7. Waivers та override

**Точковий waiver:** `// pr-self-review-ignore: <rule> — <причина>` над рядком.
Причина обов'язкова, потрапляє у звіт. Без цього люди вимикають гейт цілком,
а не точково.

**Аварійний вихід:** `PR_SELF_REVIEW_SKIP=1` з обов'язковим текстом причини,
який теж пишеться у звіт. Гейт без аварійного виходу — це граблі.

---

## 8. Verdict, звіт, опис PR

`.pr-self-review/report.json` — `headSha`, хеш робочого дерева, `verdict`,
лічильники за severity, findings, секція покриття скілами.
`.pr-self-review/report.md` — те саме для людини.

### Генерація опису PR (`--describe`)

Скіл уже зібрав changeset і зрозумів зміни рівно в момент перед `gh pr create` —
title + body з цього майже безкоштовні. Вивід у `.pr-self-review/pr-body.md`,
далі `gh pr create --body-file`. Щоденної користі від цього більше, ніж від
самого гейта.

---

## 9. Блокування — три рівні

1. **PreToolUse hook** у `.claude/settings.json`, matcher `Bash`, ловить
   `gh pr create` / `git push`. Викликає `gate.sh`, який **не робить рев'ю** —
   лише перевіряє: чи є звіт, чи він відповідає поточному стану дерева, чи
   `verdict == pass`. Немає / застарів / `fail` → `exit 2`, виклик заблоковано,
   у stderr підказка запустити `/pr-self-review`. Хук лишається мілісекундним.
2. **`.githooks/pre-push`** — той самий `gate.sh` для флоу поза Claude Code.
   Вмикається через `git config core.hooksPath .githooks` у `scripts/dev.sh`.
3. **`.github/workflows/pr-self-review.yml`** — required check, щоб merge
   реально блокувався. Тільки детермінований шар (§4, відтворюваний);
   LLM-частина лишається локальною.

---

## 10. Етапи

| # | Що | Результат |
|---|---|---|
| 1 | `collect.sh`, `routing.md`, `repo-invariants.md` + `invariants.sh`, звіт покриття | видно підбір скілів і всі порушення інваріантів; ще нічого не блокує |
| 2 | `SKILL.md` фази 3–4, `severity.md`, diff-scoped findings, waivers, кеш; ручний `/pr-self-review` | повноцінне рев'ю, ще нічого не блокує |
| 3 | `gate.sh` + hook у `settings.json` + `--describe` | блокує `gh pr create`, генерує опис PR |
| 4 | `.githooks/pre-push` + `dev.sh` | покриває не-Claude флоу |
| 5 | CI workflow | справжній merge-блок |

Етапи 1–2 самодостатні: скіл корисний до появи блокування. Валідувати можна
на поточному diff — там є client, server, contracts і e2e одночасно, тобто
маршрутизація перевіряється в один прогін.

---

## 11. Пізніше

| Що | Чому не зараз |
|---|---|
| `--fix` для механічних findings | спершу потрібна довіра до findings |
| Fixture-тест скіла (еталонний changeset → очікуваний набір скілів) | боронить `routing.md` від гниття; для курсового репо детермінізм демо важливий |
| Повторювані findings → кандидати в `insights.md` через `engineering-insights` | замикає цикл навчання репо, але потрібна статистика за тижні |
| Постинг non-critical findings коментарем у PR | це write у GitHub — окреме підтвердження щоразу |

## 12. Свідомо не робимо

- **LLM всередині git-хука** — pre-push має бути мілісекундним
- **Блокування за стиль або розмір PR** — вимкнуть на другий день
- **Покриття тестами як critical** — корисно як `major`, як блокер дає шум

---

## 13. Рішення за замовчуванням

Прийняті, якщо не скажеш інакше:

1. Список `critical` — як у §6
2. Виконання фази 4 — послідовне, `--parallel` пізніше
3. CI-рівень — робимо, але останнім етапом
