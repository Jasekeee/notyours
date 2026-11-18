import { mockHeldResult } from '../mocks/fixtures.js';
import type { Boundary, Identity, ProbeResult, Ratchet } from '../types.js';

/** In-memory ratchet: lock() remembers boundary ids; replay() returns a fixed HELD result per lock. */
export class MockRatchet implements Ratchet {
  readonly locked: string[] = [];

  async lock(b: Boundary, _result: ProbeResult): Promise<void> {
    if (!this.locked.includes(b.id)) this.locked.push(b.id);
  }

  async replay(_ids: Identity[]): Promise<ProbeResult[]> {
    return this.locked.map((boundaryId) => ({ ...mockHeldResult, boundaryId }));
  }
}
