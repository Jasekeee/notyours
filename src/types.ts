// FROZEN CONTRACT. Do not edit without an approved entry in CONTRACT_CHANGE.md.
// Data types are inferred from src/schemas.ts so the two can never drift.
import type { z } from 'zod';
import type {
  BoundaryKindSchema,
  BoundarySchema,
  ConfigSchema,
  HitSchema,
  IdentitySchema,
  KaneRunSchema,
  KaneRunStatusSchema,
  PlanSchema,
  ProbeResultSchema,
  RoleSchema,
  VerdictSchema,
} from './schemas.js';

export type Role = z.infer<typeof RoleSchema>; // 'owner'|'viewer'|'guest'|'free'|'pro'
export type Plan = z.infer<typeof PlanSchema>; // 'free'|'pro'|null
export type Identity = z.infer<typeof IdentitySchema>;
export type BoundaryKind = z.infer<typeof BoundaryKindSchema>;
export type Boundary = z.infer<typeof BoundarySchema>;
export type KaneRunStatus = z.infer<typeof KaneRunStatusSchema>;
export type KaneRun = z.infer<typeof KaneRunSchema>;
export type Verdict = z.infer<typeof VerdictSchema>; // 'LEAK_VISIBLE'|'LEAK_PAYLOAD'|'HELD'|'HARNESS_BROKEN'
export type Hit = z.infer<typeof HitSchema>;
export type ProbeResult = z.infer<typeof ProbeResultSchema>;
/** Config after defaults are applied. */
export type Config = z.infer<typeof ConfigSchema>;
/** Config as written in .notyours/config.yaml (defaulted fields optional). */
export type ConfigInput = z.input<typeof ConfigSchema>;

/** Runs one boundary probe: create as owner, visit targets as viewer, judge with the canary oracle. */
export interface Engine {
  runBoundary(b: Boundary, ids: Identity[], cfg: Config): Promise<ProbeResult>;
}

/** Locks probed boundaries into replayable (0-credit) Kane tests and replays them. */
export interface Ratchet {
  lock(b: Boundary, result: ProbeResult): Promise<void>;
  replay(ids: Identity[]): Promise<ProbeResult[]>;
}

/** Writes a human/agent-readable report; returns the path of the main report file. */
export interface Report {
  write(results: ProbeResult[], outDir: string): string;
}
