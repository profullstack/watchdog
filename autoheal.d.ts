export const DEFAULT_MAX_RESTARTS: number;
export const DEFAULT_WINDOW_MS: number;

export interface Container {
  id: string;
  name: string;
  health: 'healthy' | 'unhealthy' | 'starting' | 'none';
  /** The container carries the label autoheal=false. */
  optedOut: boolean;
}

export interface HealState {
  /** Restart timestamps per container name, inside the current window. */
  restarts: Record<string, number[]>;
  /** When each container that exhausted its budget was reported. */
  gaveUp: Record<string, number>;
}

export interface HealResult {
  state: HealState;
  restarted: string[];
  gaveUp: string[];
  failed: string[];
  containers: Container[];
}

/** One pass: restart what Docker marked unhealthy, within a per-container budget. */
export function healOnce(o: {
  list: () => Promise<Container[]>;
  restart: (c: Container) => Promise<unknown>;
  state?: HealState;
  now?: number;
  /** Restarts per container per window before handing to a person. Default 3. */
  maxRestarts?: number;
  /** Default one hour. */
  windowMs?: number;
  dryRun?: boolean;
  log?: { error?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
}): Promise<HealResult>;

export function parseHealth(status: string): Container['health'];
export function listDockerContainers(o?: { bin?: string }): Promise<Container[]>;
export function restartDockerContainer(
  c: Container,
  o?: { bin?: string; stopTimeoutS?: number },
): Promise<string>;
