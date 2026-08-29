export const prerender = false;

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { makeId, requireUser } from "../../../lib/support-auth";
import { notifySupportMessage } from "../../../lib/support-cc";

const SITE_ID = "master-carpenters";
const SITE_HOST = "mastercarpentersllc.com";

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function clean(v: unknown, max: number): string {
	if (typeof v !== "string") return "";
	return v.trim().slice(0, max);
}

/** POST /api/support/message — client reply on a ticket they own */
export const POST: APIRoute = async ({ request }) => {
	const user = await requireUser(request);
	if (!user) return json({ ok: false, error: "Not authenticated" }, 401);

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, error: "Invalid JSON" }, 400);
	}

	const ticketId = clean(body.ticket_id || body.id, 80);
	const text = clean(body.body || body.message, 8000);
	if (!ticketId) return json({ ok: false, error: "ticket_id required" }, 422);
	if (!text) return json({ ok: false, error: "Message is required" }, 422);

	const db = env.DB;
	if (!db) return json({ ok: false, error: "Database unavailable" }, 500);

	const ticket = await db
		.prepare(
			`SELECT id, subject, user_id, status FROM support_tickets WHERE id = ? LIMIT 1`
		)
		.bind(ticketId)
		.first<{ id: string; subject: string; user_id: string; status: string }>();

	if (!ticket || ticket.user_id !== user.id) {
		return json({ ok: false, error: "Not found" }, 404);
	}

	const msgId = makeId("msg");
	const now = new Date().toISOString();

	try {
		await db.batch([
			db
				.prepare(
					`INSERT INTO support_messages
						(id, ticket_id, sender, author_name, body, created_at)
					 VALUES (?, ?, 'client', ?, ?, ?)`
				)
				.bind(msgId, ticketId, user.name || user.email, text, now),
			db
				.prepare(
					`UPDATE support_tickets
					 SET message = ?, updated_at = ?,
					     status = CASE WHEN status IN ('done','closed','waiting_on_client','staging')
					                   THEN 'in_progress' ELSE status END
					 WHERE id = ?`
				)
				.bind(text, now, ticketId),
		]);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("support message insert error:", msg);
		return json({ ok: false, error: "Could not send message" }, 500);
	}

	try {
		await notifySupportMessage({
			ticket_id: ticketId,
			message_id: msgId,
			site_id: SITE_ID,
			site: SITE_HOST,
			subject: ticket.subject,
			body: text,
			user_email: user.email,
			user_name: user.name || "",
			created_at: now,
		});
	} catch (err) {
		console.warn("support message CC notify error:", err);
	}

	return json({
		ok: true,
		message: {
			id: msgId,
			ticket_id: ticketId,
			sender: "client",
			author_name: user.name || user.email,
			body: text,
			created_at: now,
		},
	});
};
