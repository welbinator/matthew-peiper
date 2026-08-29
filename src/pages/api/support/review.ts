export const prerender = false;

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
	notifySupportApproval,
	notifySupportDisapproval,
} from "../../../lib/support-cc";
import { verifyReviewToken } from "../../../lib/support-review-token";

const SITE_ID = "master-carpenters";
const SITE_HOST = "mastercarpentersllc.com";

/** Staging hosts allowed to call this endpoint from the browser bar. */
const ALLOWED_ORIGINS = new Set([
	"https://welbinator.github.io",
	"http://localhost:4321",
	"http://127.0.0.1:4321",
]);

function corsHeaders(request: Request): HeadersInit {
	const origin = request.headers.get("Origin") || "";
	const allow = ALLOWED_ORIGINS.has(origin) ? origin : "https://welbinator.github.io";
	return {
		"Access-Control-Allow-Origin": allow,
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
		"Access-Control-Max-Age": "86400",
		Vary: "Origin",
	};
}

function json(request: Request, data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			...corsHeaders(request),
		},
	});
}

function newMsgId() {
	const rand = crypto.getRandomValues(new Uint8Array(8));
	return "msg_" + [...rand].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const OPTIONS: APIRoute = async ({ request }) => {
	return new Response(null, { status: 204, headers: corsHeaders(request) });
};

/**
 * POST /api/support/review
 * Token-based approve / disapprove from the staging preview bar (no portal login).
 * Body: { token, action: "approve" | "disapprove", reason? }
 */
export const POST: APIRoute = async ({ request }) => {
	const secret = (env as Record<string, string | undefined>).PUSH_NOTIFY_SECRET || "";
	if (!secret) return json(request, { ok: false, error: "Server misconfigured" }, 500);

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json(request, { ok: false, error: "Invalid JSON" }, 400);
	}

	const token = String(body.token || "").trim();
	const action = String(body.action || "").trim().toLowerCase();
	const reason = String(body.reason || body.body || "").trim().slice(0, 8000);

	if (!token) return json(request, { ok: false, error: "Missing review token" }, 400);
	if (action !== "approve" && action !== "disapprove") {
		return json(request, { ok: false, error: "action must be approve or disapprove" }, 400);
	}
	if (action === "disapprove" && reason.length < 3) {
		return json(
			request,
			{ ok: false, error: "Please explain what you’d like changed (a short note is fine)." },
			400
		);
	}

	const verified = await verifyReviewToken(secret, token, SITE_ID);
	if (!verified.ok) return json(request, { ok: false, error: verified.error }, 401);

	const ticketId = verified.payload.tid;
	const db = env.DB;
	if (!db) return json(request, { ok: false, error: "Database unavailable" }, 500);

	try {
		const ticket = await db
			.prepare(
				`SELECT t.id, t.subject, t.user_id, t.status, t.staging_url, t.approved_at,
				        u.email as user_email, u.name as user_name
				 FROM support_tickets t
				 LEFT JOIN support_users u ON u.id = t.user_id
				 WHERE t.id = ?
				 LIMIT 1`
			)
			.bind(ticketId)
			.first<{
				id: string;
				subject: string;
				user_id: string;
				status: string;
				staging_url: string;
				approved_at: string;
				user_email: string;
				user_name: string;
			}>();

		if (!ticket) return json(request, { ok: false, error: "Request not found" }, 404);

		const st = String(ticket.status || "");
		const staging = (ticket.staging_url || "").trim();
		const userEmail = ticket.user_email || "";
		const userName = ticket.user_name || userEmail || "Client";
		const now = new Date().toISOString();
		const msgId = newMsgId();

		if (action === "approve") {
			if (st === "approved" || ticket.approved_at) {
				return json(request, {
					ok: true,
					already: true,
					action: "approve",
					ticket: { id: ticket.id, status: "approved", staging_url: staging },
				});
			}
			if (st === "done" || st === "closed") {
				return json(request, { ok: false, error: "This request is already closed." }, 400);
			}
			if (st !== "staging") {
				return json(
					request,
					{
						ok: false,
						error:
							"This preview isn’t waiting for approval right now. Check your support thread for the latest status.",
					},
					400
				);
			}

			const bodyText = staging
				? `I reviewed the preview and approve these changes.\n\nPreview: ${staging}`
				: "I reviewed the preview and approve these changes.";

			await db.batch([
				db
					.prepare(
						`UPDATE support_tickets
						 SET status = 'approved', approved_at = ?, updated_at = ?
						 WHERE id = ?`
					)
					.bind(now, now, ticketId),
				db
					.prepare(
						`INSERT INTO support_messages
							(id, ticket_id, sender, author_name, body, created_at)
						 VALUES (?, ?, 'client', ?, ?, ?)`
					)
					.bind(msgId, ticketId, userName, bodyText, now),
			]);

			try {
				await notifySupportApproval({
					ticket_id: ticketId,
					message_id: msgId,
					site_id: SITE_ID,
					site: SITE_HOST,
					subject: ticket.subject,
					body: bodyText,
					staging_url: staging,
					user_email: userEmail,
					user_name: userName,
					created_at: now,
					approved_at: now,
				});
			} catch (err) {
				console.warn("review approve CC notify error:", err);
			}

			return json(request, {
				ok: true,
				action: "approve",
				ticket: {
					id: ticketId,
					status: "approved",
					staging_url: staging,
					approved_at: now,
				},
			});
		}

		// disapprove
		if (st === "done" || st === "closed") {
			return json(request, { ok: false, error: "This request is already closed." }, 400);
		}
		if (st === "approved") {
			return json(
				request,
				{
					ok: false,
					error:
						"You already approved this preview. Open your support thread if you need a new change.",
				},
				400
			);
		}
		if (st !== "staging") {
			return json(
				request,
				{
					ok: false,
					error:
						"This preview isn’t waiting for review right now. Check your support thread for the latest status.",
				},
				400
			);
		}

		const bodyText = staging
			? `I reviewed the preview and need changes before going live.\n\nWhat I didn’t like / what to fix:\n${reason}\n\nPreview: ${staging}`
			: `I reviewed the preview and need changes before going live.\n\nWhat I didn’t like / what to fix:\n${reason}`;

		await db.batch([
			db
				.prepare(
					`UPDATE support_tickets
					 SET status = 'changes_requested',
					     approved_at = '',
					     updated_at = ?
					 WHERE id = ?`
				)
				.bind(now, ticketId),
			db
				.prepare(
					`INSERT INTO support_messages
						(id, ticket_id, sender, author_name, body, created_at)
					 VALUES (?, ?, 'client', ?, ?, ?)`
				)
				.bind(msgId, ticketId, userName, bodyText, now),
		]);

		try {
			await notifySupportDisapproval({
				ticket_id: ticketId,
				message_id: msgId,
				site_id: SITE_ID,
				site: SITE_HOST,
				subject: ticket.subject,
				body: bodyText,
				reason,
				staging_url: staging,
				user_email: userEmail,
				user_name: userName,
				created_at: now,
			});
		} catch (err) {
			console.warn("review disapprove CC notify error:", err);
		}

		return json(request, {
			ok: true,
			action: "disapprove",
			ticket: {
				id: ticketId,
				status: "changes_requested",
				staging_url: staging,
				approved_at: "",
			},
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("support review error:", msg);
		return json(request, { ok: false, error: "Could not submit review" }, 500);
	}
};
