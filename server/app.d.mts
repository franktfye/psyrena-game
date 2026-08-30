// Hand-written declarations for server/app.mjs so vite.config.ts type-checks.
import type { IncomingMessage, ServerResponse } from "node:http";

/** Handles /api/* requests; resolves false when the URL is not an API route. */
export function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean>;

/** Create a user with hashed password + default game state; returns the user id. */
export function createUser(
  username: string,
  password: string,
  state?: Record<string, unknown>
): number;
