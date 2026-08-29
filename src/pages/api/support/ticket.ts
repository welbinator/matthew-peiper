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

/** GET /api/support/ticket?id=... — ticket detail + full thread for the logged-in client */
export const GET: APIRoute = async ({ request }) => {
	const user = await requireUser(request);
	if (!user) return json({ ok: false, error: "Not authenticated" }, 401);

	const url = new URL(request.url);
	const id = (url.searchParams.get("id") || "").trim();
	if (!id) return json({ ok: false, error: "id required" }, 400);

	const db = env.DB;
	if (!db) return json({ ok: false, error: "Database unavailable" }, 500);

	try {
		const ticket = await db
			.prepare(
				`SELECT id, subject, message, page_url, status, staging_url, approved_at, created_at, updated_at, user_id
				 FROM support_tickets WHERE id = ? LIMIT 1`
			)
			.bind(id)
			.first<{
				id: string;
				subject: string;
				message: string;
				page_url: string;
				status: string;
				staging_url: string;
				approved_at: string;
				created_at: string;
				updated_at: string;
				user_id: string;
			}>();

		if (!ticket || ticket.user_id !== user.id) {
			return json({ ok: false, error: "Not found" }, 404);
		}

		let messages =
			(
				await db
					.prepare(
						`SELECT id, sender, author_name, body, created_at
						 FROM support_messages
						 WHERE ticket_id = ?
						 ORDER BY created_at ASC`
					)
					.bind(id)
					.all()
			).results || [];

		// Backfill first message from ticket body if thread empty (pre-thread tickets)
		if (!messages.length && ticket.message) {
			const msgId = `msg_seed_${ticket.id}`;
			try {
				await db
					.prepare(
						`INSERT OR IGNORE INTO support_messages
							(id, ticket_id, sender, author_name, body, created_at)
						 VALUES (?, ?, 'client', ?, ?, ?)`
					)
					.bind(msgId, ticket.id, user.name || user.email, ticket.message, ticket.created_at)
					.run();
				messages =
					(
						await db
							.prepare(
								`SELECT id, sender, author_name, body, created_at
								 FROM support_messages
								 WHERE ticket_id = ?
								 ORDER BY created_at ASC`
							)
							.bind(id)
							.all()
					).results || [];
			} catch {
				messages = [
					{
						id: msgId,
						sender: "client",
						author_name: user.name || user.email,
						body: ticket.message,
						created_at: ticket.created_at,
					},
				];
			}
		}

		const { user_id: _uid, ...publicTicket } = ticket;
		return json({ ok: true, ticket: publicTicket, messages });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("support ticket detail error:", msg);
		return json({ ok: false, error: "Could not load ticket" }, 500);
	}
};
