export const prerender = false;

import type { APIRoute } from "astro";
import {
	SESSION_COOKIE,
	clearSessionCookieHeader,
	destroySession,
	parseCookie,
	requestIsSecure,
} from "../../../lib/support-auth";

export const POST: APIRoute = async ({ request }) => {
	const token = parseCookie(request.headers.get("cookie"), SESSION_COOKIE);
	await destroySession(token);
	return new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Set-Cookie": clearSessionCookieHeader(requestIsSecure(request)),
		},
	});
};
