import { AuthenticationExpiredError, RequestTimeoutError } from "./library";

/**
 * Maps an error thrown while handling an API request onto the response the
 * frontend expects:
 *  - 401: the library session is gone and could not be refreshed, so the UI
 *    returns to the login page instead of polling a dead session forever;
 *  - 504: the upstream library request timed out;
 *  - 502: any other upstream/backend failure, carrying the original message so
 *    the client log can explain why the request failed.
 */
export function errorResponse(error: unknown): Response {
  const detail = error instanceof Error ? error.message : "内部服务错误";
  const status =
    error instanceof AuthenticationExpiredError ? 401 : error instanceof RequestTimeoutError ? 504 : 502;
  return Response.json({ detail }, { status });
}
