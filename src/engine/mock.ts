import { mockHeldResult } from '../mocks/fixtures.js';
import type { Boundary, Config, Engine, Identity, ProbeResult } from '../types.js';

/** Returns a fixed HELD result for any boundary. No Kane runs, no credits. */
export class MockEngine implements Engine {
  async runBoundary(b: Boundary, _ids: Identity[], _cfg: Config): Promise<ProbeResult> {
    return { ...mockHeldResult, boundaryId: b.id };
  }
}
