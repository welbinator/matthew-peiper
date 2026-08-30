export const prerender = false;

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { requireUser } from "../../../lib/support-auth";

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * GET /api/support/attachment?id=<attachment_id>
 * Streams a support attachment from R2 to the client who owns the ticket.
 * Ownership is enforced by joining the attachment's ticket to the logged-in user.
 */
export const GET: APIRoute = async ({ request }) => {
	const user = await requireUser(request);
	if (!user) return json({ ok: false, error: "Not authenticated" }, 401);

	const url = new URL(request.url);
	const id = (url.searchParams.get("id") || "").trim();
	if (!id) return json({ ok: false, error: "id required" }, 400);

	const db = env.DB;
	if (!db) return json({ ok: false, error: "Database unavailable" }, 500);

	const row = await db
		.prepare(
			`SELECT a.r2_key AS r2_key, a.filename AS filename, a.content_type AS content_type,
			        t.user_id AS user_id
			 FROM support_attachments a
			 JOIN support_tickets t ON t.id = a.ticket_id
			 WHERE a.id = ? LIMIT 1`
		)
		.bind(id)
		.first<{ r2_key: string; filename: string; content_type: string; user_id: string }>();

	if (!row || row.user_id !== user.id) {
		return json({ ok: false, error: "Not found" }, 404);
	}

	const obj = await env.SUPPORT_UPLOADS.get(row.r2_key);
	if (!obj) return json({ ok: false, error: "File no longer available" }, 404);

	const headers = new Headers();
	headers.set("Content-Type", row.content_type || "application/octet-stream");
	// Inline for images/PDF so the browser can preview; filename preserved.
	const safe = row.filename.replace(/["\\\r\n]/g, "_");
	headers.set("Content-Disposition", `inline; filename="${safe}"`);
	headers.set("Cache-Control", "private, max-age=3600");
	if (obj.httpEtag) headers.set("ETag", obj.httpEtag);

	return new Response(obj.body, { status: 200, headers });
};
