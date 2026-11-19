import type { SimulatedD1, SimulatedKV, SimulatedQueue, SimulatedR2 } from '../../../src/verifier/simulator.ts';

export interface Env {
  DB: SimulatedD1;
  CACHE: SimulatedKV;
  BUCKET: SimulatedR2;
  JOBS: SimulatedQueue;
}
