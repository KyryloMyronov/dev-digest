/**
 * Live smoke check for every selectable feature model.
 *
 * WHY THIS EXISTS. Every test lane in this repo stubs the LLM
 * (`TESTING.md` — "Mock the outside world"), so "the model we resolved is
 * actually usable in THIS deployment" is unobservable in CI by construction.
 * SPEC-02's `risk_brief` shipped pointing at `openai / gpt-4.1` against an
 * account with no credits: every derivation returned 429, wrote no row by
 * design, and the studio showed a button that did nothing. One live call would
 * have caught it. This is that call.
 *
 * IT SPENDS REAL MONEY — one tiny structured completion per configured model
 * (tens of tokens each, cents at most). It is deliberately NOT wired into
 * `pnpm test`; run it by hand before calling an LLM feature delivered.
 *
 *   cd server && pnpm smoke:models
 *   cd server && pnpm smoke:models risk_brief        # one feature
 *
 * Exit code is non-zero if any checked feature fails, so it can gate a release.
 */
import { z } from 'zod';
import { FEATURE_MODELS, type FeatureModelId } from '@devdigest/shared';
import { loadConfig } from '../src/platform/config.js';
import { createDb } from '../src/db/client.js';
import { Container } from '../src/platform/container.js';
import * as t from '../src/db/schema.js';

/** The smallest structured answer worth asking for: proves the whole path. */
const ProbeSchema = z.object({
  ok: z.boolean().describe('Always true.'),
  word: z.string().describe('The single word "ready".'),
});

type Outcome = { id: string; provider: string; model: string; ok: boolean; detail: string };

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const config = loadConfig();
  const handle = createDb(config.databaseUrl);
  const container = new Container(config, handle.db);

  const [ws] = await handle.db.select({ id: t.workspaces.id }).from(t.workspaces).limit(1);
  if (!ws) {
    console.error('No workspace found — run `pnpm db:migrate && pnpm db:seed` first.');
    process.exit(2);
  }

  const features = FEATURE_MODELS.filter((f) => only.length === 0 || only.includes(f.id));
  if (features.length === 0) {
    console.error(`No such feature. Known ids: ${FEATURE_MODELS.map((f) => f.id).join(', ')}`);
    process.exit(2);
  }

  const results: Outcome[] = [];
  for (const feature of features) {
    const choice = await container.featureModel(ws.id, feature.id as FeatureModelId);
    const base = { id: feature.id, provider: choice.provider, model: choice.model };
    process.stdout.write(`… ${feature.id} → ${choice.provider}/${choice.model}\n`);

    // Constructing the provider is a separate failure from calling it: a
    // missing key fails here, an unfunded account fails below. The brief's bug
    // was the SECOND kind, which is why checking only this is not enough.
    let llm;
    try {
      llm = await container.llm(choice.provider);
    } catch (err) {
      results.push({ ...base, ok: false, detail: `provider unavailable: ${(err as Error).message}` });
      continue;
    }

    if (choice.provider === 'openrouter') {
      const supported = await container.modelCatalog
        .supportsStructuredOutputs(choice.model)
        .catch(() => null);
      if (supported === false) {
        results.push({ ...base, ok: false, detail: 'model cannot serve structured outputs' });
        continue;
      }
    }

    try {
      const res = await llm.completeStructured({
        model: choice.model,
        schema: ProbeSchema,
        schemaName: 'SmokeProbe',
        maxRetries: 0,
        // Generous on purpose: a REASONING model spends this budget before it
        // emits any JSON, so a tight cap here would fail a healthy model and
        // send you chasing the wrong thing (see `brief/constants.ts`).
        maxTokens: 2_000,
        messages: [
          { role: 'system', content: 'Reply with ok=true and word="ready".' },
          { role: 'user', content: 'ready?' },
        ],
      });
      const parsed = ProbeSchema.safeParse(res.data);
      results.push(
        parsed.success
          ? { ...base, ok: true, detail: `${res.tokensIn}→${res.tokensOut} tok, cost ${res.costUsd ?? 'n/a'}` }
          : { ...base, ok: false, detail: `answer failed the schema: ${parsed.error.issues[0]?.message}` },
      );
    } catch (err) {
      results.push({ ...base, ok: false, detail: (err as Error).message });
    }
  }

  // `padEnd`, not printf widths: Node's console.log supports `%s` but NOT the
  // `%-14s` width modifier — it prints the specifier literally.
  const w = (v: string, n: number) => v.padEnd(n);
  console.log(`\n   ${w('feature', 15)}${w('provider', 12)}${w('model', 30)}result`);
  for (const r of results) {
    console.log(
      `${r.ok ? '✓' : '✗'}  ${w(r.id, 15)}${w(r.provider, 12)}${w(r.model, 30)}${r.detail}`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} usable` +
      (failed.length ? ` — fix in Settings → Models, or fund the provider.` : ''),
  );
  await handle.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
