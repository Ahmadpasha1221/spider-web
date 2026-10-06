import type { SpiderSession } from "../core/session.js";

/** Lifecycle status from the Spider Session schema. No other values exist. */
export type SessionStatus = SpiderSession["objective"]["status"];

/**
 * Lightweight discovery metadata for one stored session. Summaries
 * never carry conversation or tool content.
 */
export interface SessionSummary {
  readonly id: string;
  readonly status: SessionStatus;
  readonly source_agent: string;
  readonly title: string;
  readonly project_name: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Provider-neutral local session repository. The repository stores
 * canonical Spider Sessions; provider-specific knowledge belongs in
 * adapters, never here.
 */
export interface SessionRepository {
  /** Persist a new session. Rejects duplicates and invalid sessions. */
  create(session: SpiderSession): Promise<void>;
  /** Return the stored session, or null when the ID is unknown. */
  get(sessionId: string): Promise<SpiderSession | null>;
  /** Replace an existing session atomically. */
  update(session: SpiderSession): Promise<void>;
  /** Remove a session and its index entry. */
  delete(sessionId: string): Promise<void>;
  /** List session summaries, most recently updated first. */
  list(): Promise<SessionSummary[]>;
  /** Check whether a session is stored. */
  exists(sessionId: string): Promise<boolean>;
  /** Sessions that still have work to hand off (in progress or blocked). */
  findActive(): Promise<SessionSummary[]>;
  /**
   * Store a validated canonical session, for example one recovered
   * from a Spider Egg. Duplicate IDs are rejected so importing never
   * silently overwrites stored work.
   */
  import(session: SpiderSession): Promise<void>;
}

export class SessionRepositoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionRepositoryError";
  }
}

export class SessionNotFoundError extends SessionRepositoryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionNotFoundError";
  }
}

export class SessionAlreadyExistsError extends SessionRepositoryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionAlreadyExistsError";
  }
}

/** Persistence or index failure. The stored session stays usable. */
export class SessionStoreError extends SessionRepositoryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionStoreError";
  }
}
