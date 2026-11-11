const HTTP_413 = /(?:^413(?:\s|:|$)|\bHTTP\s+413\b|\bstatus(?: code)?[:= ]+413\b)/i;
const BODY_SIZE = /(?:request_too_large|payload too large|request entity too large|request body (?:is )?too large|failed to buffer the request body:\s*length limit exceeded)/i;
const OTHER_ERROR = /rate limit|too many requests|\b429\b|authentication|unauthorized/i;
import { isCerebrasBodylessOverflow } from "./overflow.ts";
/** Provider errors only; never inspect tool input or shell source. */
export function isRequestBodyTooLarge(error: unknown, provider?: string): boolean {
	if (!error || typeof error !== "object") return false;
	const value = error as { status?: unknown; stopReason?: unknown; errorMessage?: unknown; message?: unknown; provider?: string };
	if (value.stopReason !== undefined && value.stopReason !== "error") return false;
	const text = typeof value.errorMessage === "string" ? value.errorMessage : typeof value.message === "string" ? value.message : "";
	if (isCerebrasBodylessOverflow(provider ?? value.provider, text)) return false;
	if (value.status === 413) return true;
	return HTTP_413.test(text) || !OTHER_ERROR.test(text) && BODY_SIZE.test(text);
}
