export const prerender = false;

import type { APIRoute } from "astro";
import { requireUser } from "../../../lib/support-auth";

export const GET: APIRoute = async ({ request }) => {
	const user = await requireUser(request);
	if (!user) {
		return new Response(JSON.stringify({ ok: false, authenticated: false }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	}
	return new Response(
		JSON.stringify({ ok: true, authenticated: true, user }),
		{ status: 200, headers: { "Content-Type": "application/json" } }
	);
};
