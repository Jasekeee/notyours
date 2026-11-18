// FROZEN CONTRACT. Do not edit without an approved entry in CONTRACT_CHANGE.md.
// Single source of truth for data shapes; src/types.ts derives every data type from these.
import { z } from 'zod';

/** Identity ids are lowercase slugs so tokens stay unambiguous: alice, bob, guest, free_user. */
export const IdentityIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'lowercase slug: [a-z][a-z0-9_]{0,31}');

/** RFC 4648 base32 alphabet (no 0/1/8/9), used for the random part of canary tokens. */
export const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Canary token: NY-<ID uppercase>-<12 chars base32>, e.g. NY-ALICE-K7Q2MZX4P3RA. */
export const TOKEN_RE = /^NY-[A-Z][A-Z0-9_]{0,31}-[A-Z2-7]{12}$/;
/** Same shape, unanchored and global, for scanning DOM text / network bodies. */
export const TOKEN_SCAN_RE = /NY-[A-Z][A-Z0-9_]{0,31}-[A-Z2-7]{12}/g;
export const TokenSchema = z.string().regex(TOKEN_RE, 'token must be NY-<ID>-<12 base32 chars>');

export const RoleSchema = z.enum(['owner', 'viewer', 'guest', 'free', 'pro']);
export const PlanSchema = z.enum(['free', 'pro']).nullable();

export const IdentitySchema = z
  .object({
    id: IdentityIdSchema,
    role: RoleSchema,
    email: z.string().optional(),
    /** NEVER logged, printed, or written to reports. Use redactIdentity() before output. */
    password: z.string().optional(),
    plan: PlanSchema,
    token: TokenSchema,
    cdpPort: z.number().int().min(1024).max(65535),
    userDataDir: z.string().min(1),
  })
  .refine((i) => i.token.startsWith(`NY-${i.id.toUpperCase()}-`), {
    message: 'token ID segment must equal id.toUpperCase()',
    path: ['token'],
  });

export const BoundaryKindSchema = z.enum(['cross-user', 'guest', 'plan-gate', 'sweep']);

export const BoundarySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'boundary id: lowercase slug'),
  kind: BoundaryKindSchema,
  /** Identity id that creates the data (and plants its token). */
  owner: IdentityIdSchema,
  /** Identity id that must NOT see the owner's token. */
  viewer: IdentityIdSchema,
  create: z.object({
    /** Kane objective run as `owner` to create data containing {{token}}. */
    objective: z.string().min(1),
    /** Kane variable names the create run must store (e.g. the new record's URL). */
    store: z.array(z.string().min(1)),
  }),
  targets: z.object({
    /** Pages the viewer visits; may reference stored values as {{name}}. */
    ui: z.array(z.string()),
    /** API URLs fetched as the viewer; may reference stored values as {{name}}. */
    api: z.array(z.string()),
  }),
  /** plan-gate only: the pro-only action a free identity attempts. */
  proAction: z.object({ objective: z.string().min(1) }).optional(),
  expect: z.literal('denied'),
  /** Code globs implicated if this boundary leaks (handed to the coding agent). */
  surface: z.array(z.string()),
  /** Set by the ratchet once a boundary has a recorded, replayable test. */
  locked: z.boolean().optional(),
});

export const KaneRunStatusSchema = z.enum(['passed', 'failed', 'error', 'timeout']);

export const KaneRunSchema = z.object({
  objective: z.string(),
  /** Identity id the run executed as (never the full Identity: it may hold a password). */
  identity: IdentityIdSchema,
  status: KaneRunStatusSchema,
  exitCode: z.number().int(),
  /** run_end.final_state from kane-cli --agent NDJSON. */
  finalState: z.record(z.string(), z.unknown()),
  /** run_end.credits_consumed; 0 for testmd replays (they report none). */
  creditsConsumed: z.number().nonnegative(),
  durationS: z.number().nonnegative(),
  testUrl: z.string().optional(),
  sessionDir: z.string().optional(),
  reason: z.string().optional(),
});

export const VerdictSchema = z.enum(['LEAK_VISIBLE', 'LEAK_PAYLOAD', 'HELD', 'HARNESS_BROKEN']);

export const HitSchema = z.object({
  token: TokenSchema,
  where: z.enum(['dom', 'network']),
  url: z.string(),
  /** Short context around the token; must not contain passwords or credentials. */
  snippet: z.string().max(500),
});

export const ProbeResultSchema = z.object({
  boundaryId: z.string(),
  verdict: VerdictSchema,
  controls: z.object({
    /** Positive control: owner can see their own token (else the harness is broken). */
    ownerSeesOwnToken: z.boolean(),
    /** Positive control: viewer can see their own token (proves the viewer session works). */
    viewerSeesOwnToken: z.boolean(),
  }),
  hits: z.array(HitSchema),
  screenshots: z.array(z.string()),
  kaneRuns: z.array(KaneRunSchema),
  /** ISO 8601 timestamp. */
  ts: z.iso.datetime(),
});

/** .notyours/config.yaml. Parse with ConfigSchema.parse() to apply defaults. */
export const ConfigSchema = z.object({
  baseUrl: z.url(),
  allowHosts: z.array(z.string().min(1)).default(['localhost', '127.0.0.1']),
  parallel: z.boolean().default(true),
  liveCapture: z.boolean().default(true),
  /** Refuse to start authoring runs when the Kane balance is below this. */
  creditFloor: z.number().nonnegative().default(300),
  maxAttempts: z.number().int().min(1).default(3),
});
