export const DEFAULT_MAX_RESTARTS: number;
export const DEFAULT_MAX_SIMULTANEOUS: number;
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
  /** When the current correlated failure was reported, while it persists. */
  brakedAt?: number;
}

export interface HealResult {
  state: HealState;
  restarted: string[];
  gaveUp: string[];
  /**
   * The unhealthy containers this pass refused to restart because that many
   * failing together means the host. Populated once per window, like gaveUp;
   * when it is non-empty nothing was restarted.
   */
  braked: string[];
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
  /**
   * Unhealthy containers in one pass that mean the host rather than the
   * containers: restart none of them and report once. Default 5.
   */
  maxSimultaneous?: number;
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
