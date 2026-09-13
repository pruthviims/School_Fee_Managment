import { Router } from "express";
import { requireCapability } from "../middleware/permissions.js";
import {
  getAdmissionAnalytics, getCollectionTrend, getDailyCollection, getExceptions, getOperatorAudit,
  getPaymentModeBreakdown, getPromotionAnalytics, getRefundAnalytics, getReportsSummary, getTcAnalytics,
  getYearComparison,
} from "../services/reports.js";

export const reportsRouter = Router();

// Every report reads through view_reports — already held by Owner,
// Accountant, and Viewer, and deliberately not Front Desk. No new
// permission model: a role without this capability today simply gets
// no Reports tab, which is the correct behaviour without any special
// casing here.
reportsRouter.use(requireCapability("view_reports"));

function filtersFrom(req: any) {
  return {
    schoolId: req.school!.id,
    academicYearId: req.query.academic_year_id as string,
    classLevelId: req.query.class_level_id as string | undefined,
    sectionId: req.query.section_id as string | undefined,
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
    mode: req.query.mode as string | undefined,
  };
}

reportsRouter.get("/summary", async (req, res) => {
  if (!req.query.academic_year_id) return res.status(400).json({ detail: "academic_year_id is required." });
  res.json(await getReportsSummary(filtersFrom(req)));
});

reportsRouter.get("/collection-trend", async (req, res) => {
  if (!req.query.academic_year_id) return res.status(400).json({ detail: "academic_year_id is required." });
  res.json(await getCollectionTrend(filtersFrom(req)));
});

reportsRouter.get("/payment-modes", async (req, res) => {
  if (!req.query.academic_year_id) return res.status(400).json({ detail: "academic_year_id is required." });
  res.json(await getPaymentModeBreakdown(filtersFrom(req)));
});

reportsRouter.get("/refunds", async (req, res) => {
  if (!req.query.academic_year_id) return res.status(400).json({ detail: "academic_year_id is required." });
  res.json(await getRefundAnalytics(filtersFrom(req)));
});

reportsRouter.get("/tc", async (req, res) => {
  if (!req.query.academic_year_id) return res.status(400).json({ detail: "academic_year_id is required." });
  res.json(await getTcAnalytics(filtersFrom(req)));
});

reportsRouter.get("/promotion", async (req, res) => {
  if (!req.query.academic_year_id) return res.status(400).json({ detail: "academic_year_id is required." });
  res.json(await getPromotionAnalytics(filtersFrom(req)));
});

reportsRouter.get("/admissions", async (req, res) => {
  if (!req.query.academic_year_id) return res.status(400).json({ detail: "academic_year_id is required." });
  res.json(await getAdmissionAnalytics(filtersFrom(req)));
});

reportsRouter.get("/daily-collection", async (req, res) => {
  const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
  res.json(await getDailyCollection(req.school!.id, date));
});

reportsRouter.get("/year-comparison", async (req, res) => {
  res.json(await getYearComparison(req.school!.id));
});

reportsRouter.get("/exceptions", async (req, res) => {
  if (!req.query.academic_year_id) return res.status(400).json({ detail: "academic_year_id is required." });
  res.json(await getExceptions(filtersFrom(req)));
});

// Stricter than the router-wide view_reports gate above — Viewer holds
// view_reports but not view_audit_log, and shouldn't see who
// individually processed what.
reportsRouter.get("/operator-audit", requireCapability("view_audit_log"), async (req, res) => {
  res.json(await getOperatorAudit(
    req.school!.id, req.query.from as string | undefined, req.query.to as string | undefined,
  ));
});
