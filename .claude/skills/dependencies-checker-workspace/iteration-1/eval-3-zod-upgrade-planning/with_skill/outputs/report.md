## Zod v4 Upgrade — Pre-Flight Check

**1. Installed zod version, per package (not just declared range):**

| Package | Manager | Declared range | Installed version | Latest |
|---|---|---|---|---|
| server | pnpm | ^3.24.1 | **3.25.76** | 4.5.4 |
| client | pnpm | ^3.24.1 | **3.25.76** | 4.5.4 |
| reviewer-core | npm | ^3.24.1 | **3.25.76** | 4.5.4 |
| mcp | npm | ^3.25.0 | **3.25.76** | 4.5.4 |

**Нема drift.** Усі чотири пакети резолвляться в ідентичний `3.25.76`, попри відсутність спільного lockfile (`crossPackage[].majorDrift` для zod = `false`). Єдина косметична різниця: `mcp` декларує `^3.25.0`, решта `^3.24.1` — обидва зараз перетинаються на тій самій installed версії, це не drift, лише майбутній ризик розходження.

**2. Найважливіша реальна знахідка (не сам zod):** `server/package.json` тягне `fastify-type-provider-zod@4.0.2`, чиї `peerDependencies` заявляють `zod: ^3.14.2` — не покриває zod 4. `npm outdated` показує для цього пакета `latest: 7.0.0` (major bump 4→7), ймовірно та лінія, що додала підтримку zod v4. **Апгрейд zod до 4.x на server неможливий без паралельного апгрейду `fastify-type-provider-zod`** — інакше route validation (`response:`, body schemas) зламається/дасть undefined behavior. Це стосується лише server. Транзитивна `zod-to-json-schema` ніде напряму не імпортується в коді (0 збігів).

**3. Migration surface:** 47 файлів імпортують `zod` напряму — server: 26, client: 14, mcp: 6, reviewer-core: 1. Канонічний контракт-барель живе в `server/src/vendor/shared/`, дзеркалиться в `client/src/vendor/shared/` — мігрувати першим, прогнати `./scripts/check-contracts.sh --fix`.

**4. Broader outdated-majors scan (all 5 packages):** окрім zod, мажорно застарілі однаково в усіх 5 пакетах — `typescript` (5.9.3→7.0.2) та `vitest` (2.1.9→4.1.11), без drift, спільний технічний борг, окремий від zod. По одному пакету: server — `openai` SDK (4→7), `octokit` (4→5), `testcontainers` (10→12), `dependency-cruiser`, `dotenv`, `p-queue`, `@fastify/cors`; client — `next` (15→16), `recharts` (2→3), `next-intl` (3→4), `lucide-react` (0.x→1.x), test-tooling. e2e: лише typescript мажорно застарілий, zod там взагалі не залежність.

**5. Coverage:** 5/5 `node_modules` присутні, `outdated` відпрацював без помилок скрізь; немає live vulnerability feed (audit не запускався).

**Рекомендація:** апгрейдити zod одним атомарним PR на всі 4 пакети одночасно (P0), включити `fastify-type-provider-zod` у той самий PR (P0, блокер), вирівняти declared ranges на `^3.25.0` (P2), typescript/vitest/next/openai-SDK — окремі backlog-цикли, не змішувати з zod.
