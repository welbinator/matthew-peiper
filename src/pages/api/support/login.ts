export const prerender = false;

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
	createSession,
	findUserByEmail,
	requestIsSecure,
	sessionCookieHeader,
	verifyPassword,
} from "../../../lib/support-auth";

function json(data: unknown, status = 200, headers: HeadersInit = {}) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

export const POST: APIRoute = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, error: "Invalid JSON" }, 400);
	}

	const email = typeof body.email === "string" ? body.email.trim() : "";
	const password = typeof body.password === "string" ? body.password : "";
	if (!email || !password) {
		return json({ ok: false, error: "Email and password are required" }, 422);
	}

	const db = env.DB;
	if (!db) return json({ ok: false, error: "Database unavailable" }, 500);

	try {
		const user = await findUserByEmail(db, email);
		if (!user || !(await verifyPassword(password, user.password_hash))) {
			return json({ ok: false, error: "Invalid email or password" }, 401);
		}

		const token = await createSession({
			id: user.id,
			email: user.email,
			name: user.name || "",
		});
		const setCookie = sessionCookieHeader(token, requestIsSecure(request));
		return json(
			{ ok: true, user: { id: user.id, email: user.email, name: user.name || "" } },
			200,
			{ "Set-Cookie": setCookie }
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("support login error:", msg);
		return json({ ok: false, error: "Login failed" }, 500);
	}
};
