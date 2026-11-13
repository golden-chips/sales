// Documents & approvals (Phase 6d): versioned files attached to any record,
// restricted documents, expiry tracking (licences, certificates, contracts),
// and generic multi-step e-approvals where every decision records the SHA-256
// of the exact file version approved.
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { can, tdb } from "../../core/auth.js";
import { parse, zUuid, zMoney, zDate } from "../../core/http.js";
import { E } from "../../core/errors.js";
import { audit } from "../../core/audit.js";
import type { Db } from "../../db/pool.js";
import type { UserCtx } from "../../core/auth.js";

const T = { tags: ["Documents & approvals"] };
const id$ = z.object({ id: zUuid });
const MAX_BYTES = 10 * 1024 * 1024;
// documents only — no executables or scripts
const MIME = ["application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain", "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword", "application/vnd.ms-excel"];
const zFile = z.object({ fileName: z.string().min(1).max(200).refine((n) => !/[\\/]/.test(n), "plain file name"), mimeType: z.enum(MIME as [string, ...string[]]),
  contentBase64: z.string().min(4), note: z.string().max(500).optional() });
const ev = (db: Db, u: UserCtx, action: string, type: string, id: string, after?: unknown) => audit(db, { tenantId: u.tenantId, actorType: "user", actorId: u.userId, action, entityType: type, entityId: id, after });

function decode(b64: string) {
  const buf = Buffer.from(b64, "base64");
  if (!buf.length) throw E.validation([{ path: "contentBase64", message: "empty file" }]);
  if (buf.length > MAX_BYTES) throw E.validation([{ path: "contentBase64", message: "file larger than 10 MB" }]);
  return { buf, sha256: createHash("sha256").update(buf).digest("hex") };
}
async function addVersion(db: Db, u: UserCtx, documentId: string, f: z.infer<typeof zFile>) {
  const { buf, sha256 } = decode(f.contentBase64);
  const d = (await db.query("UPDATE documents SET current_version = current_version + 1 WHERE id = $1 AND status = 'active' RETURNING current_version", [documentId])).rows[0];
  if (!d) throw E.rule("DOCUMENT_ARCHIVED", "المستند مؤرشف", "Document is archived");
  return (await db.query(
    `INSERT INTO document_versions (tenant_id, document_id, version, file_name, mime_type, size_bytes, sha256, content, note, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, version, file_name, mime_type, size_bytes, sha256, uploaded_at`,
    [u.tenantId, documentId, d.current_version, f.fileName, f.mimeType, buf.length, sha256, buf, f.note ?? null, u.userId])).rows[0];
}
const canRestricted = (u: UserCtx) => u.permissions.has("documents.restricted.view");

export async function docsRoutes(app: FastifyInstance) {
  app.get("/documents", { schema: { ...T, summary: "Search documents (title, tags, file names); filter by record, category, expiry" }, preHandler: can("documents.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, q: z.string().max(100).optional(), category: z.string().optional(), entityType: z.string().optional(), entityId: zUuid.optional(),
      expiringWithinDays: z.coerce.number().int().min(0).max(365).optional(), status: z.enum(["active", "archived"]).default("active") }), req.query);
    return tdb(req, async (db) => (await db.query(
      `SELECT d.*, u.full_name AS created_by_name, v.file_name, v.mime_type, v.size_bytes, v.sha256, v.uploaded_at, (d.expires_on - current_date) AS days_to_expiry
         FROM documents d LEFT JOIN users u ON u.id = d.created_by LEFT JOIN document_versions v ON v.document_id = d.id AND v.version = d.current_version
        WHERE d.company_id = $1 AND d.status = $2 AND ($3 OR NOT d.restricted)
          AND ($4::text IS NULL OR d.title ILIKE '%'||$4||'%' OR array_to_string(d.tags, ' ') ILIKE '%'||$4||'%'
               OR EXISTS (SELECT 1 FROM document_versions x WHERE x.document_id = d.id AND x.file_name ILIKE '%'||$4||'%'))
          AND ($5::text IS NULL OR d.category = $5) AND ($6::text IS NULL OR d.entity_type = $6) AND ($7::uuid IS NULL OR d.entity_id = $7)
          AND ($8::int IS NULL OR (d.expires_on IS NOT NULL AND d.expires_on <= current_date + $8))
        ORDER BY CASE WHEN $8::int IS NOT NULL THEN d.expires_on END, d.created_at DESC LIMIT 500`,
      [q.companyId, q.status, canRestricted(req.user!), q.q ?? null, q.category ?? null, q.entityType ?? null, q.entityId ?? null, q.expiringWithinDays ?? null])).rows);
  });
  app.post("/documents", { bodyLimit: 15 * 1024 * 1024, schema: { ...T, summary: "Upload a document (first version)" }, preHandler: can("documents.manage") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, title: z.string().min(2).max(300), category: z.enum(["contract", "invoice", "certificate", "license", "policy", "quality", "hr", "other"]),
      entityType: z.string().regex(/^[a-z_]{2,40}$/).optional(), entityId: zUuid.optional(), restricted: z.boolean().default(false), tags: z.array(z.string().max(40)).max(20).default([]),
      expiresOn: zDate.optional(), file: zFile }).refine((x) => !!x.entityType === !!x.entityId, "entityType and entityId together"), req.body);
    if (b.restricted && !canRestricted(req.user!)) throw E.forbidden("documents.restricted.view");
    return reply.code(201).send(await tdb(req, async (db) => {
      const d = (await db.query(`INSERT INTO documents (tenant_id, company_id, title, category, entity_type, entity_id, restricted, tags, expires_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.user!.tenantId, b.companyId, b.title, b.category, b.entityType ?? null, b.entityId ?? null, b.restricted, b.tags, b.expiresOn ?? null, req.user!.userId])).rows[0];
      const v = await addVersion(db, req.user!, d.id, b.file);
      await ev(db, req.user!, "document.uploaded", "document", d.id, { title: d.title, version: v.version, sha256: v.sha256 });
      return { ...d, current_version: v.version, version: v };
    }));
  });
  app.get("/documents/:id", { schema: { ...T, summary: "Document with all its versions" }, preHandler: can("documents.view") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, async (db) => {
      const d = (await db.query("SELECT * FROM documents WHERE id = $1", [id])).rows[0];
      if (!d || (d.restricted && !canRestricted(req.user!))) throw E.notFound("documents");
      const versions = (await db.query(`SELECT v.id, v.version, v.file_name, v.mime_type, v.size_bytes, v.sha256, v.note, v.uploaded_at, u.full_name AS uploaded_by_name
          FROM document_versions v LEFT JOIN users u ON u.id = v.uploaded_by WHERE v.document_id = $1 ORDER BY v.version DESC`, [id])).rows;
      const approvals = (await db.query("SELECT id, title, status, created_at, closed_at FROM approval_requests WHERE entity_type = 'document' AND entity_id = $1 ORDER BY created_at DESC", [id])).rows;
      return { ...d, versions, approvals };
    });
  });
  app.post("/documents/:id/versions", { bodyLimit: 15 * 1024 * 1024, schema: { ...T, summary: "Upload a new version (old versions are kept, never changed)" }, preHandler: can("documents.manage") }, async (req, reply) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ file: zFile }), req.body);
    return reply.code(201).send(await tdb(req, async (db) => {
      const d = (await db.query("SELECT restricted FROM documents WHERE id = $1", [id])).rows[0];
      if (!d || (d.restricted && !canRestricted(req.user!))) throw E.notFound("documents");
      const v = await addVersion(db, req.user!, id, b.file);
      await ev(db, req.user!, "document.version_added", "document", id, { version: v.version, sha256: v.sha256 });
      return v;
    }));
  });
  app.get("/documents/:id/versions/:version/download", { schema: { ...T, summary: "Download a version (logged)" }, preHandler: can("documents.view") }, async (req, reply) => {
    const p = parse(z.object({ id: zUuid, version: z.coerce.number().int().positive() }), req.params);
    const f = await tdb(req, async (db) => {
      const r = (await db.query(`SELECT d.restricted, v.file_name, v.mime_type, v.content, v.sha256 FROM documents d JOIN document_versions v ON v.document_id = d.id WHERE d.id = $1 AND v.version = $2`, [p.id, p.version])).rows[0];
      if (!r || (r.restricted && !canRestricted(req.user!))) throw E.notFound("documents");
      await ev(db, req.user!, "document.downloaded", "document", p.id, { version: p.version });
      return r;
    });
    return reply.header("content-type", f.mime_type).header("x-content-sha256", f.sha256).header("x-content-type-options", "nosniff")
      .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(f.file_name)}`).send(f.content);
  });
  app.post("/documents/:id/archive", { schema: { ...T, summary: "Archive (documents are never deleted)" }, preHandler: can("documents.manage") }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, async (db) => {
      const r = (await db.query("UPDATE documents SET status = 'archived' WHERE id = $1 RETURNING *", [id])).rows[0];
      if (!r) throw E.notFound("documents");
      await ev(db, req.user!, "document.archived", "document", id);
      return r;
    });
  });

  // ---------------------------------------------------------------- approvals
  app.post("/approvals", { schema: { ...T, summary: "Request a multi-step approval on any record (steps by role or user)" }, preHandler: can("documents.approvals.request") }, async (req, reply) => {
    const b = parse(z.object({ companyId: zUuid, title: z.string().min(3), entityType: z.string().regex(/^[a-z_]{2,40}$/), entityId: zUuid, documentVersionId: zUuid.optional(),
      amount: zMoney.optional(), steps: z.array(z.object({ roleId: zUuid.optional(), userId: zUuid.optional() }).refine((s) => !!s.roleId !== !!s.userId, "roleId or userId")).min(1).max(6) }), req.body);
    return reply.code(201).send(await tdb(req, async (db) => {
      const u = req.user!;
      const r = (await db.query(`INSERT INTO approval_requests (tenant_id, company_id, title, entity_type, entity_id, document_version_id, amount, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [u.tenantId, b.companyId, b.title, b.entityType, b.entityId, b.documentVersionId ?? null, b.amount ?? null, u.userId])).rows[0];
      let seq = 0;
      for (const s of b.steps) await db.query("INSERT INTO approval_steps (tenant_id, request_id, seq, approver_role_id, approver_user_id) VALUES ($1,$2,$3,$4,$5)", [u.tenantId, r.id, ++seq, s.roleId ?? null, s.userId ?? null]);
      await ev(db, u, "approval.requested", "approval_request", r.id, { title: b.title, steps: b.steps.length });
      return getApproval(db, r.id);
    }));
  });
  app.get("/approvals", { schema: { ...T, summary: "Approval requests" }, preHandler: can("documents.view") }, async (req) => {
    const q = parse(z.object({ companyId: zUuid, status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional() }), req.query);
    return tdb(req, async (db) => (await db.query(`SELECT r.*, u.full_name AS requested_by_name, (SELECT count(*) FROM approval_steps s WHERE s.request_id = r.id)::int AS steps
        FROM approval_requests r JOIN users u ON u.id = r.requested_by WHERE r.company_id = $1 AND ($2::approval_status IS NULL OR r.status = $2) ORDER BY r.created_at DESC LIMIT 300`,
      [q.companyId, q.status ?? null])).rows);
  });
  app.get("/approvals/inbox", { schema: { ...T, summary: "Approvals waiting for me (by my user or one of my roles)" }, preHandler: can(null) }, async (req) => {
    return tdb(req, async (db) => (await db.query(
      `SELECT r.*, s.seq, u.full_name AS requested_by_name FROM approval_requests r JOIN approval_steps s ON s.request_id = r.id AND s.seq = r.current_step JOIN users u ON u.id = r.requested_by
        WHERE r.status = 'pending' AND s.status = 'pending' AND r.requested_by <> $1
          AND (s.approver_user_id = $1 OR s.approver_role_id IN (SELECT role_id FROM user_roles WHERE user_id = $1)) ORDER BY r.created_at`, [req.user!.userId])).rows);
  });
  app.get("/approvals/:id", { schema: { ...T, summary: "Approval request with its steps and decisions" }, preHandler: can(null) }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, (db) => getApproval(db, id));
  });
  app.post("/approvals/:id/decide", { schema: { ...T, summary: "Approve or reject the current step (not your own request); records the file hash" }, preHandler: can(null) }, async (req) => {
    const { id } = parse(id$, req.params);
    const b = parse(z.object({ decision: z.enum(["approved", "rejected"]), comment: z.string().max(1000).optional() }), req.body);
    return tdb(req, async (db) => {
      const u = req.user!;
      const r = (await db.query("SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!r) throw E.notFound("approval_requests");
      if (r.status !== "pending") throw E.rule("APPROVAL_CLOSED", "طلب الاعتماد مغلق", "Approval request is closed");
      if (r.requested_by === u.userId) throw E.sod();
      const s = (await db.query("SELECT * FROM approval_steps WHERE request_id = $1 AND seq = $2", [id, r.current_step])).rows[0];
      const mine = s.approver_user_id === u.userId || (s.approver_role_id && (await db.query("SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2", [u.userId, s.approver_role_id])).rowCount);
      if (!mine) throw E.rule("NOT_YOUR_STEP", "هذه الخطوة ليست من صلاحيتك", "You are not the approver of this step");
      if (b.decision === "rejected" && !b.comment) throw E.validation([{ path: "comment", message: "a reason is required to reject" }]);
      const hash = r.document_version_id ? (await db.query("SELECT sha256 FROM document_versions WHERE id = $1", [r.document_version_id])).rows[0].sha256 : null;
      await db.query("UPDATE approval_steps SET status = $2, decided_by = $3, decided_at = now(), comment = $4, evidence_sha256 = $5 WHERE id = $1", [s.id, b.decision, u.userId, b.comment ?? null, hash]);
      const last = Number((await db.query("SELECT max(seq) AS m FROM approval_steps WHERE request_id = $1", [id])).rows[0].m);
      if (b.decision === "rejected") await db.query("UPDATE approval_requests SET status = 'rejected', closed_at = now() WHERE id = $1", [id]);
      else if (r.current_step >= last) await db.query("UPDATE approval_requests SET status = 'approved', closed_at = now() WHERE id = $1", [id]);
      else await db.query("UPDATE approval_requests SET current_step = current_step + 1 WHERE id = $1", [id]);
      await ev(db, u, `approval.step_${b.decision}`, "approval_request", id, { step: r.current_step, sha256: hash, comment: b.comment });
      return getApproval(db, id);
    });
  });
  app.post("/approvals/:id/cancel", { schema: { ...T, summary: "Requester cancels a pending request" }, preHandler: can(null) }, async (req) => {
    const { id } = parse(id$, req.params);
    return tdb(req, async (db) => {
      const r = await db.query("UPDATE approval_requests SET status = 'cancelled', closed_at = now() WHERE id = $1 AND status = 'pending' AND requested_by = $2 RETURNING id", [id, req.user!.userId]);
      if (!r.rowCount) throw E.rule("APPROVAL_CLOSED", "لا يمكن الإلغاء", "Cannot cancel");
      return getApproval(db, id);
    });
  });
}

async function getApproval(db: Db, id: string) {
  const r = (await db.query("SELECT r.*, u.full_name AS requested_by_name FROM approval_requests r JOIN users u ON u.id = r.requested_by WHERE r.id = $1", [id])).rows[0];
  if (!r) throw E.notFound("approval_requests");
  const steps = (await db.query(
    `SELECT s.*, ro.code AS role_code, ro.name_ar AS role_name_ar, au.full_name AS approver_name, du.full_name AS decided_by_name FROM approval_steps s
       LEFT JOIN roles ro ON ro.id = s.approver_role_id LEFT JOIN users au ON au.id = s.approver_user_id LEFT JOIN users du ON du.id = s.decided_by WHERE s.request_id = $1 ORDER BY s.seq`, [id])).rows;
  return { ...r, steps };
}
