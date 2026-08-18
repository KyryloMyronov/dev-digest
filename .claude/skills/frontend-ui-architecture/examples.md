# Frontend UI Architecture — Code Shapes

Companion to [SKILL.md](SKILL.md). Each shape shows the target pattern (and the
anti-pattern where it clarifies).

## Target folder tree (feature-based, Bulletproof-style)

```
src/
├── app/                    # Next.js App Router — routing shim + composition
│   ├── (marketing)/        # route group: own layout, same URL level
│   ├── repos/[repoId]/
│   │   ├── _components/    # route-scoped, not routable
│   │   ├── _lib/
│   │   └── page.tsx        # Server Component: fetch + compose features
│   └── layout.tsx
├── components/             # shared UI (used by 2+ features)
├── config/                 # app-wide config, env parsing
├── features/
│   └── reviews/
│       ├── actions/        # Server Actions (mutations) — 'use server'
│       ├── queries/        # server read fns for RSCs — 'server-only'
│       ├── api/            # client hooks + queryOptions factories
│       ├── components/
│       ├── hooks/
│       ├── types.ts
│       └── utils/
├── hooks/                  # shared hooks (2+ features)
├── lib/                    # configured 3rd-party facades (api-client, query-client)
├── types/                  # cross-cutting domain entities / DTOs only
└── utils/                  # pure generic fns by purpose (format/, array/…)
```

Rules embedded in the tree: no feature imports another feature; `app/`
composes features; anything in a feature moves up one level only when a second
feature needs it.

## `as const` instead of enum

```ts
// ❌ enum: nominal typing, reverse mappings, banned by erasableSyntaxOnly
enum ReviewStatus { Pending = 'pending', Done = 'done' }

// ✅ const object + derived union
export const REVIEW_STATUS = {
  Pending: 'pending',
  Done: 'done',
} as const;
export type ReviewStatus = (typeof REVIEW_STATUS)[keyof typeof REVIEW_STATUS];
```

## queryOptions factory per feature (TanStack Query v5)

```ts
// features/reviews/api/review-queries.ts
import { queryOptions } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';

export const reviewQueries = {
  all: () => ['reviews'] as const,                       // key-only: invalidation root
  lists: () => [...reviewQueries.all(), 'list'] as const,
  list: (repoId: string) =>
    queryOptions({
      queryKey: [...reviewQueries.lists(), repoId],
      queryFn: () => apiClient.get(`/repos/${repoId}/reviews`),
    }),
};

// usage — same object everywhere:
useQuery(reviewQueries.list(repoId));
queryClient.prefetchQuery(reviewQueries.list(repoId));
queryClient.invalidateQueries({ queryKey: reviewQueries.lists() });
```

No global `queryKeys.ts`; keys structured generic → specific.

## RSC boundary: client leaf + server children (interleaving)

```tsx
// ❌ 'use client' on the page drags the whole subtree into the client bundle

// ✅ page stays a Server Component; interactivity is a leaf
// app/repos/[repoId]/page.tsx  (Server Component)
export default async function RepoPage({ params }) {
  const repo = await getRepo((await params).repoId); // DAL call
  return (
    <CollapsiblePanel title={repo.name}>   {/* client wrapper */}
      <ReviewList reviews={repo.reviews} /> {/* stays a Server Component */}
    </CollapsiblePanel>
  );
}

// _components/collapsible-panel.tsx
'use client';
export function CollapsiblePanel({ title, children }: Props) {
  const [open, setOpen] = useState(true);
  return (/* children rendered on the server, passed through */);
}
```

## Data Access Layer (DAL) skeleton

```ts
// lib/dal.ts — the ONLY place that touches the DB and process.env
import 'server-only';
import { cache } from 'react';

export const verifySession = cache(async () => {
  const session = await readSessionCookie();
  if (!session) redirect('/login');
  return session;
});

export async function getRepo(repoId: string): Promise<RepoDTO> {
  const session = await verifySession();          // authorize at the source
  const row = await db.query.repos.findFirst(/* scoped by session */);
  return toRepoDTO(row);                          // minimal DTO, never the raw row
}
```

Layouts never do auth checks; middleware/proxy only does optimistic
cookie-redirects.

## Server Action shape (mutation only, validated, authorized)

```ts
// features/reviews/actions/create-review.ts
'use server';
import { z } from 'zod';
import { verifySession } from '@/lib/dal';

const CreateReview = z.object({ repoId: z.string().uuid(), title: z.string().min(1) });

export async function createReview(_prev: unknown, formData: FormData) {
  const parsed = CreateReview.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { errors: parsed.error.flatten().fieldErrors };

  const session = await verifySession();          // action = public POST endpoint
  await insertReview(session, parsed.data);       // DAL mutation
  revalidatePath(`/repos/${parsed.data.repoId}`);
}
```

## ESLint: enforce the architecture

```js
// eslint config (shape from bulletproof-react's react-vite sample)
'import/no-restricted-paths': ['error', {
  zones: [
    // no cross-feature imports
    { target: './src/features/reviews', from: './src/features', except: ['./reviews'] },
    // features must not import from app
    { target: './src/features', from: './src/app' },
    // shared code must not import upward
    {
      target: ['./src/components', './src/hooks', './src/lib', './src/types', './src/utils'],
      from: ['./src/features', './src/app'],
    },
  ],
}],
'import/no-cycle': 'error',
'no-restricted-syntax': ['error',
  { selector: 'TSEnumDeclaration', message: 'Use `as const` objects instead of enums.' },
],
```

## Direct imports, no barrels

```ts
// ❌ features/reviews/index.ts re-exporting everything, then:
import { ReviewCard } from '@/features/reviews';

// ✅ import the module directly:
import { ReviewCard } from '@/features/reviews/components/review-card';
```
