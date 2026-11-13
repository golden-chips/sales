import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { api, getApp, platformToken, createPlan, provision, roleId, createUser } from "./helpers.js";
import { withTenant } from "../src/db/pool.js";

const Y = new Date().getUTCFullYear();
const ok = (r: any, s = 201) => { if (r.status !== s) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const as = (w: any) => ({ token: w.token });

describe("CRM, documents & approvals, projects", () => {
  let T: any, SM: any, CS: any, FIN: any, PM: any, acc: Record<string, string>, lot: any;
  beforeAll(async () => {
    const p = await platformToken();
    const plan = await createPlan(p, { modules: ["accounting", "sales", "inventory", "quality", "crm", "documents", "projects"] });
    T = await provision(p, plan.code);
    ok(await api("POST", "/api/v1/accounting/accounts/seed-template", { companyId: T.companyId }, as(T)));
    ok(await api("POST", "/api/v1/accounting/fiscal-years", { companyId: T.companyId, name: `FY${Y}`, startDate: `${Y}-01-01` }, as(T)));
    acc = Object.fromEntries((await api("GET", `/api/v1/accounting/accounts?companyId=${T.companyId}`, undefined, as(T))).body.map((a: any) => [a.code, a.id]));
    SM = await createUser(T, [{ roleId: await roleId(T.token, "sales_manager") }]);
    CS = await createUser(T, [{ roleId: await roleId(T.token, "customer_service") }]);
    FIN = await createUser(T, [{ roleId: await roleId(T.token, "finance_manager") }]);
    PM = await createUser(T, [{ roleId: await roleId(T.token, "project_manager") }]);
    const bag = ok(await api("POST", "/api/v1/uoms", { code: "BAG", nameAr: "كيس" }, as(T))).id;
    const item = ok(await api("POST", "/api/v1/items", { companyId: T.companyId, code: "FG-1", nameAr: "منتج", kind: "finished", baseUomId: bag, trackLots: true, salesPrice: "1" }, as(T)));
    await withTenant(T.tenantId, null, async (db) => { lot = (await db.query("INSERT INTO lots (tenant_id, item_id, lot_no, expiry_date) VALUES ($1,$2,'L-77',$3) RETURNING *", [T.tenantId, item.id, `${Y + 1}-01-01`])).rows[0]; });
  });

  describe("CRM", () => {
    let customerId: string;
    it("lead → duplicate check → conversion to a real customer; pipeline with weighted value", async () => {
      const camp = ok(await api("POST", "/api/v1/crm/campaigns", { companyId: T.companyId, name: "حملة رمضان", channel: "field", startDate: `${Y}-03-01`, budget: "500" }, as(SM)));
      const lead = ok(await api("POST", "/api/v1/crm/leads", { companyId: T.companyId, name: "أحمد", businessName: "بقالة النور", phone: "+218911111111", source: "campaign", campaignId: camp.id }, as(SM)));
      expect((await api("POST", "/api/v1/crm/leads", { companyId: T.companyId, name: "أحمد 2", phone: "+218911111111" }, as(SM))).status).toBe(409);
      expect((await api("POST", "/api/v1/crm/leads", { companyId: T.companyId, name: "x" }, as(CS))).status).toBe(403);   // customer service cannot create leads
      const opp = ok(await api("POST", "/api/v1/crm/opportunities", { companyId: T.companyId, title: "توريد شهري", leadId: lead.id, expectedValue: "1000" }, as(SM)));
      ok(await api("POST", `/api/v1/crm/opportunities/${opp.id}/stage`, { stage: "negotiation" }, as(SM)), 200);
      const pipe = ok(await api("GET", `/api/v1/crm/pipeline?companyId=${T.companyId}`, undefined, as(SM)), 200);
      expect(pipe.stages).toEqual([{ stage: "negotiation", n: 1, value: "1000.0000", weighted: "700.0000" }]);
      const conv = ok(await api("POST", `/api/v1/crm/leads/${lead.id}/convert`, { customerCode: "C-NOOR", creditLimit: "300" }, as(SM)));
      customerId = conv.customer.id;
      expect(conv.customer.name_ar).toBe("بقالة النور");
      expect((await api("POST", `/api/v1/crm/leads/${lead.id}/convert`, { customerCode: "C-NOOR2" }, as(SM))).body.error.code).toBe("LEAD_CONVERTED");
      const won = ok(await api("POST", `/api/v1/crm/opportunities/${opp.id}/stage`, { stage: "won" }, as(SM)), 200);
      expect([won.probability, won.customer_id]).toEqual([100, customerId]);
      expect((await api("POST", `/api/v1/crm/opportunities/${opp.id}/stage`, { stage: "proposal" }, as(SM))).body.error.code).toBe("OPPORTUNITY_CLOSED");
      const camps = ok(await api("GET", `/api/v1/crm/campaigns?companyId=${T.companyId}`, undefined, as(SM)), 200);
      expect([camps[0].leads, camps[0].converted]).toEqual([1, 1]);
    });

    it("activities: my open tasks, mark done", async () => {
      const a = ok(await api("POST", "/api/v1/crm/activities", { companyId: T.companyId, kind: "call", subject: "متابعة الطلبية", customerId, dueAt: "2020-01-01T09:00:00Z" }, as(SM)));
      const open = ok(await api("GET", `/api/v1/crm/activities?companyId=${T.companyId}&open=true&mine=true`, undefined, as(SM)), 200);
      expect(open[0]).toMatchObject({ id: a.id, overdue: true });
      ok(await api("POST", `/api/v1/crm/activities/${a.id}/done`, {}, as(SM)), 200);
      expect(ok(await api("GET", `/api/v1/crm/activities?companyId=${T.companyId}&open=true&mine=true`, undefined, as(SM)), 200)).toEqual([]);
    });

    it("complaint about a lot opens a quality non-conformance; SLA; resolution and satisfaction", async () => {
      const t = ok(await api("POST", "/api/v1/crm/tickets", { companyId: T.companyId, customerId, kind: "complaint", priority: "high", subject: "كيس منتفخ", lotId: lot.id, openNcr: true }, as(CS)));
      expect(t.number).toMatch(/^TK-/);
      expect(Math.round((Date.parse(t.due_at) - Date.parse(t.created_at)) / 3600000)).toBe(24);
      const list = ok(await api("GET", `/api/v1/crm/tickets?companyId=${T.companyId}`, undefined, as(CS)), 200);
      expect(list[0].ncr_number).toMatch(/^NCR-/);
      expect((await api("POST", `/api/v1/crm/tickets/${t.id}/feedback`, { score: 5 }, as(CS))).body.error.code).toBe("TICKET_NOT_RESOLVED");
      expect((await api("POST", `/api/v1/crm/tickets/${t.id}/status`, { status: "resolved" }, as(CS))).status).toBe(422);
      ok(await api("POST", `/api/v1/crm/tickets/${t.id}/status`, { status: "resolved", resolution: "استبدال الكرتونة وفتح تحقيق جودة" }, as(CS)), 200);
      ok(await api("POST", `/api/v1/crm/tickets/${t.id}/feedback`, { score: 4, comment: "سريع" }, as(CS)), 200);
      const st = ok(await api("GET", `/api/v1/crm/service-stats?companyId=${T.companyId}&from=${Y}-01-01&to=${Y}-12-31`, undefined, as(CS)), 200);
      expect([st.tickets, st.complaints, st.open, st.csat_avg]).toEqual([1, 1, 0, "4.00"]);
    });
  });

  describe("documents & approvals", () => {
    let doc: any;
    const file = Buffer.from("%PDF-1.4 test certificate");
    const b64 = file.toString("base64");
    it("upload with hash, new version keeps the old one, download, restricted documents hidden, versions immutable", async () => {
      doc = ok(await api("POST", "/api/v1/documents", { companyId: T.companyId, title: "شهادة ISO 22000", category: "certificate", tags: ["iso", "جودة"], expiresOn: `${Y}-12-31`,
        file: { fileName: "iso.pdf", mimeType: "application/pdf", contentBase64: b64 } }, as(FIN)));
      expect(doc.version.sha256).toBe(createHash("sha256").update(file).digest("hex"));
      expect((await api("POST", "/api/v1/documents", { companyId: T.companyId, title: "x", category: "other", file: { fileName: "a.exe", mimeType: "application/x-msdownload", contentBase64: b64 } }, as(FIN))).status).toBe(422);
      const v2 = ok(await api("POST", `/api/v1/documents/${doc.id}/versions`, { file: { fileName: "iso-2026.pdf", mimeType: "application/pdf", contentBase64: Buffer.from("%PDF v2").toString("base64") } }, as(FIN)));
      expect(v2.version).toBe(2);
      const d = ok(await api("GET", `/api/v1/documents/${doc.id}`, undefined, as(FIN)), 200);
      expect(d.versions.map((v: any) => v.version)).toEqual([2, 1]);
      const app = await getApp();
      const dl = await app.inject({ method: "GET", url: `/api/v1/documents/${doc.id}/versions/1/download`, headers: { authorization: `Bearer ${FIN.token}` } });
      expect([dl.statusCode, dl.rawPayload.equals(file), dl.headers["x-content-sha256"]]).toEqual([200, true, doc.version.sha256]);
      expect(ok(await api("GET", `/api/v1/documents?companyId=${T.companyId}&q=iso`, undefined, as(FIN)), 200).length).toBe(1);
      expect(ok(await api("GET", `/api/v1/documents?companyId=${T.companyId}&expiringWithinDays=365`, undefined, as(FIN)), 200).length).toBe(1);
      // restricted contract: invisible to a user without the sensitive permission
      const secret = ok(await api("POST", "/api/v1/documents", { companyId: T.companyId, title: "عقد توزيع حصري", category: "contract", restricted: true,
        file: { fileName: "c.pdf", mimeType: "application/pdf", contentBase64: b64 } }, as(T)));
      expect((await api("GET", `/api/v1/documents/${secret.id}`, undefined, as(SM))).status).toBe(404);
      expect(ok(await api("GET", `/api/v1/documents?companyId=${T.companyId}`, undefined, as(SM)), 200).map((x: any) => x.id)).not.toContain(secret.id);
      await expect(withTenant(T.tenantId, null, (db) => db.query("UPDATE document_versions SET file_name = 'x' WHERE document_id = $1", [doc.id]))).rejects.toThrow();
    });

    it("two-step approval: by role then by user; requester cannot approve; rejection needs a reason; the file hash is recorded", async () => {
      const d = ok(await api("GET", `/api/v1/documents/${doc.id}`, undefined, as(FIN)), 200);
      const req = ok(await api("POST", "/api/v1/approvals", { companyId: T.companyId, title: "اعتماد الشهادة", entityType: "document", entityId: doc.id, documentVersionId: d.versions[0].id,
        steps: [{ roleId: await roleId(T.token, "finance_manager") }, { userId: PM.id }] }, as(SM)));
      expect((await api("POST", `/api/v1/approvals/${req.id}/decide`, { decision: "approved" }, as(SM))).body.error.code).toBe("SEGREGATION_OF_DUTIES");
      expect((await api("POST", `/api/v1/approvals/${req.id}/decide`, { decision: "approved" }, as(PM))).body.error.code).toBe("NOT_YOUR_STEP");
      expect(ok(await api("GET", "/api/v1/approvals/inbox", undefined, as(FIN)), 200).map((x: any) => x.id)).toEqual([req.id]);
      const s1 = ok(await api("POST", `/api/v1/approvals/${req.id}/decide`, { decision: "approved", comment: "مطابقة" }, as(FIN)), 200);
      expect([s1.status, s1.current_step, s1.steps[0].evidence_sha256]).toEqual(["pending", 2, d.versions[0].sha256]);
      expect((await api("POST", `/api/v1/approvals/${req.id}/decide`, { decision: "rejected" }, as(PM))).status).toBe(422);
      const fin = ok(await api("POST", `/api/v1/approvals/${req.id}/decide`, { decision: "approved" }, as(PM)), 200);
      expect(fin.status).toBe("approved");
      expect((await api("POST", `/api/v1/approvals/${req.id}/decide`, { decision: "approved" }, as(PM))).body.error.code).toBe("APPROVAL_CLOSED");
    });
  });

  describe("projects", () => {
    it("project with its cost centre: actual cost from the GL, budget use, weighted progress, task ownership", async () => {
      const p = ok(await api("POST", "/api/v1/projects", { companyId: T.companyId, code: "LINE3", nameAr: "تركيب خط إنتاج 3", startDate: `${Y}-02-01`, budget: "1000", managerId: PM.id }, as(PM)));
      expect(p.cost_center_code).toBe("PRJ-LINE3");
      const t1 = ok(await api("POST", `/api/v1/projects/${p.id}/tasks`, { title: "تجهيز الأرضية", estimateHours: 30, assigneeId: FIN.id }, as(PM)));
      ok(await api("POST", `/api/v1/projects/${p.id}/tasks`, { title: "تركيب الماكينة", estimateHours: 10 }, as(PM)));
      ok(await api("PATCH", `/api/v1/projects/tasks/${t1.id}`, { progressPct: 100 }, as(FIN)), 200);       // the assignee updates their own task
      expect((await api("PATCH", `/api/v1/projects/tasks/${t1.id}`, { dueDate: `${Y}-12-01` }, as(FIN))).status).toBe(403);
      // a rent expense charged to the project's cost centre (created by one user, posted by another)
      const je = ok(await api("POST", "/api/v1/accounting/journal-entries", { companyId: T.companyId, entryDate: `${Y}-02-10`, memo: "إيجار رافعة للمشروع",
        lines: [{ accountId: acc["5402"], debit: "300", costCenterId: p.cost_center_id }, { accountId: acc["1111"], credit: "300" }] }, as(T)));
      ok(await api("POST", `/api/v1/accounting/journal-entries/${je.id}/post`, {}, as(FIN)), 200);
      const s = ok(await api("GET", `/api/v1/projects/${p.id}`, undefined, as(PM)), 200);
      expect([s.actual_cost, s.budget_used_pct, s.over_budget, s.progress_pct, s.done, s.tasks]).toEqual(["300.0000", 30, false, "75.0", 1, 2]);   // (100×30 + 0×10) / 40
      expect(s.costs[0]).toMatchObject({ account_code: "5402", amount: "300.0000" });
      expect(ok(await api("GET", "/api/v1/projects/my-tasks", undefined, as(FIN)), 200)).toEqual([]);      // done tasks are not listed
    });
  });
});
