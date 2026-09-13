/**
 * Reports & Analytics — one base query per report request, not one per
 * student/class/section. getEnrollmentFinancials pulls every relevant
 * enrollment's financial position (charged/conceded/grossPaid/refunded,
 * the exact same components getBulkEnrollmentLedgers already computes,
 * just grouped by enrollment across a whole year instead of a specific
 * list) in a single round trip; every "by class"/"by section"/aging
 * breakdown below groups that same in-memory result set rather than
 * re-querying the database once per class or section. Everything here
 * reads from the same tables and definitions the rest of the app
 * already uses — charges/concessions/payments/refunds, is_active for
 * "current", tc_requests/enrollments.outcome for exits, promotion_batches
 * for promotion — nothing here is a second definition of any of them.
 */

import { pool } from "../db/index.js";

export interface ReportFilters {
  schoolId: string;
  academicYearId: string;
  classLevelId?: string;
  sectionId?: string;
  from?: string; // payment-date filter, for trend/mode/daily views only
  to?: string;
  mode?: string;
}

interface EnrollmentFinancial {
  enrollment_id: string; class_level_id: string; class_name: string; ladder_order: number;
  section_id: string; section_name: string; outcome: string; is_active: boolean;
  admission_type: string; enrolled_on: string; promotion_batch_id: string | null;
  withdrawal_reason: string | null;
  charged: number; conceded: number; grossPaid: number; refunded: number;
  netPaid: number; outstanding: number;
}

async function getEnrollmentFinancials(f: ReportFilters): Promise<EnrollmentFinancial[]> {
  const params: unknown[] = [f.schoolId, f.academicYearId];
  let where = "e.school_id = $1 AND e.academic_year_id = $2";
  if (f.classLevelId) { params.push(f.classLevelId); where += ` AND e.class_level_id = $${params.length}`; }
  if (f.sectionId) { params.push(f.sectionId); where += ` AND e.section_id = $${params.length}`; }

  const result = await pool.query(
    `SELECT e.id AS enrollment_id, e.class_level_id, cl.name AS class_name, cl.ladder_order,
            e.section_id, sec.name AS section_name, e.outcome, e.is_active, e.admission_type,
            e.created_at AS enrolled_on, e.promotion_batch_id, e.withdrawal_reason,
            COALESCE((SELECT SUM(c.amount) FROM charges c
                      WHERE c.enrollment_id = e.id AND c.reversed_by IS NULL), 0) AS charged,
            COALESCE((SELECT SUM(co.amount) FROM concessions co
                      WHERE co.enrollment_id = e.id AND co.reversed_by IS NULL), 0) AS conceded,
            -- Scoped by charges.enrollment_id first (already indexed),
            -- not "all cleared payments globally, then filter by
            -- charge_id IN (this enrollment's charges)" — that
            -- ordering, measured directly with EXPLAIN ANALYZE against
            -- 5,000 seeded enrollments, took 53+ seconds because it
            -- forced a payments scan filtered only by clearing_status
            -- (no supporting index) inside the per-row nested loop.
            -- This ordering: 21ms for the same 5,000 rows.
            COALESCE((SELECT SUM(a.amount) FROM charges c2
                      JOIN allocations a ON a.charge_id = c2.id
                      JOIN payments p ON p.id = a.payment_id
                      WHERE c2.enrollment_id = e.id
                        AND p.clearing_status = 'cleared' AND p.reversed_by IS NULL), 0) AS gross_paid,
            COALESCE((SELECT SUM(r.amount) FROM refunds r WHERE r.enrollment_id = e.id), 0) AS refunded
     FROM enrollments e
     JOIN class_levels cl ON cl.id = e.class_level_id
     JOIN sections sec ON sec.id = e.section_id
     WHERE ${where}
     ORDER BY cl.ladder_order, sec.name`,
    params,
  );

  return result.rows.map((r) => {
    const charged = Number(r.charged), conceded = Number(r.conceded);
    const grossPaid = Number(r.gross_paid), refunded = Number(r.refunded);
    const netPaid = grossPaid - refunded;
    return {
      enrollment_id: r.enrollment_id, class_level_id: r.class_level_id, class_name: r.class_name,
      ladder_order: r.ladder_order, section_id: r.section_id, section_name: r.section_name,
      outcome: r.outcome, is_active: r.is_active, admission_type: r.admission_type,
      enrolled_on: r.enrolled_on, promotion_batch_id: r.promotion_batch_id,
      withdrawal_reason: r.withdrawal_reason,
      charged, conceded, grossPaid, refunded, netPaid,
      outstanding: charged - conceded - netPaid,
    };
  });
}

// Sensible default buckets — no school-specific data was available to
// justify inventing different ones, so these follow the spec's own
// suggested ranges exactly rather than guessing at something "better".
const AGING_BUCKETS = [
  { label: "No outstanding", min: -Infinity, max: 0 },
  { label: "₹1 – ₹5,000", min: 1, max: 500000 },
  { label: "₹5,001 – ₹10,000", min: 500001, max: 1000000 },
  { label: "₹10,001 – ₹25,000", min: 1000001, max: 2500000 },
  { label: "> ₹25,000", min: 2500001, max: Infinity },
];

function groupBy<T, K extends string>(rows: T[], keyFn: (r: T) => K) {
  const map = new Map<K, T[]>();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return map;
}

export async function getReportsSummary(f: ReportFilters) {
  const rows = await getEnrollmentFinancials(f);
  const active = rows.filter((r) => r.is_active);

  const sum = (list: EnrollmentFinancial[], key: "charged" | "conceded" | "grossPaid" | "refunded" | "netPaid" | "outstanding") =>
    list.reduce((t, r) => t + r[key], 0);

  const projectedFees = sum(rows, "charged");
  const collected = sum(rows, "grossPaid");
  const refundAmount = sum(rows, "refunded");
  const netCollection = sum(rows, "netPaid");
  const concessionAmount = sum(rows, "conceded");
  const outstanding = Math.max(0, sum(rows, "outstanding"));
  const concessionStudents = rows.filter((r) => r.conceded > 0).length;
  const refundStudents = rows.filter((r) => r.refunded > 0).length;
  const outstandingStudents = rows.filter((r) => r.outstanding > 0).length;

  const kpis = {
    projectedFees, collected, outstanding, netCollection, refundAmount, concessionAmount,
    // Net Collectible = what's actually collectible after concessions —
    // the correct denominator for Collection %, since a concession was
    // never collectible in the first place. Using gross projected fees
    // understates collection whenever concessions exist. Both are
    // exposed so the dashboard can show either, but collectionPct/
    // outstandingPct below use the corrected one.
    netCollectibleFees: projectedFees - concessionAmount,
    concessionStudents, concessionPct: rows.length ? (concessionStudents / rows.length) * 100 : 0,
    refundStudents,
    collectionPct: (projectedFees - concessionAmount) > 0
      ? (netCollection / (projectedFees - concessionAmount)) * 100 : 0,
    outstandingPct: (projectedFees - concessionAmount) > 0
      ? (outstanding / (projectedFees - concessionAmount)) * 100 : 0,
  };

  const studentKpis = {
    totalActive: active.length,
    newAdmissions: rows.filter((r) => r.admission_type === "new").length,
    tcIssued: rows.filter((r) => r.outcome === "tc_issued").length,
    left: rows.filter((r) => r.outcome === "left").length,
    outstandingStudents, zeroOutstandingStudents: rows.length - outstandingStudents,
    concessionStudents, refundStudents,
  };

  // By class / by section — grouped in memory from the one result set
  // above, not one query per class or section. "collected" here is net
  // (grossPaid - refunded), deliberately — so this row's own numbers
  // reconcile (projected - concession - collected = pending), matching
  // the spec's own emphasis on reconciliation; grossCollected is still
  // exposed separately for whoever wants the pre-refund figure.
  const byClass = [...groupBy(rows, (r) => r.class_name as any)].map(([className, list]) => ({
    className, students: list.length, projected: sum(list, "charged"),
    collected: sum(list, "netPaid"), grossCollected: sum(list, "grossPaid"),
    pending: Math.max(0, sum(list, "outstanding")), concession: sum(list, "conceded"),
    refund: sum(list, "refunded"), netCollection: sum(list, "netPaid"),
    netCollectible: sum(list, "charged") - sum(list, "conceded"),
    collectionPct: (sum(list, "charged") - sum(list, "conceded")) > 0
      ? (sum(list, "netPaid") / (sum(list, "charged") - sum(list, "conceded"))) * 100 : 0,
    outstandingStudents: list.filter((r) => r.outstanding > 0).length,
    avgOutstanding: list.length ? Math.max(0, sum(list, "outstanding")) / list.length : 0,
    tcLeft: list.filter((r) => r.outcome === "tc_issued" || r.outcome === "left").length,
  }));

  const bySection = [...groupBy(rows, (r) => `${r.class_name}-${r.section_name}` as any)].map(([key, list]) => ({
    classSection: key, className: list[0].class_name, sectionName: list[0].section_name,
    students: list.length, projected: sum(list, "charged"),
    collected: sum(list, "netPaid"), grossCollected: sum(list, "grossPaid"),
    pending: Math.max(0, sum(list, "outstanding")),
    netCollectible: sum(list, "charged") - sum(list, "conceded"),
    collectionPct: (sum(list, "charged") - sum(list, "conceded")) > 0
      ? (sum(list, "netPaid") / (sum(list, "charged") - sum(list, "conceded"))) * 100 : 0,
    outstandingStudents: list.filter((r) => r.outstanding > 0).length,
  }));

  const agingBuckets = AGING_BUCKETS.map((b) => {
    const list = rows.filter((r) => r.outstanding > b.min - 1 && r.outstanding <= b.max);
    return { label: b.label, count: list.length, amount: sum(list, "outstanding") };
  });

  const concessionByClass = [...groupBy(rows.filter((r) => r.conceded > 0), (r) => r.class_name as any)]
    .map(([className, list]) => ({
      className, amount: sum(list, "conceded"), students: list.length,
      avgPerStudent: list.length ? sum(list, "conceded") / list.length : 0,
    }));

  const refundByClass = [...groupBy(rows.filter((r) => r.refunded > 0), (r) => r.class_name as any)]
    .map(([className, list]) => ({ className, amount: sum(list, "refunded"), students: list.length }));

  return {
    kpis, studentKpis, byClass, bySection, agingBuckets, concessionByClass, refundByClass,
    totalEnrollments: rows.length,
  };
}

export async function getCollectionTrend(f: ReportFilters) {
  const params: unknown[] = [f.schoolId, f.academicYearId];
  let where = "e.school_id = $1 AND e.academic_year_id = $2 AND p.clearing_status = 'cleared' AND p.reversed_by IS NULL";
  if (f.classLevelId) { params.push(f.classLevelId); where += ` AND e.class_level_id = $${params.length}`; }
  if (f.sectionId) { params.push(f.sectionId); where += ` AND e.section_id = $${params.length}`; }

  const result = await pool.query(
    `SELECT to_char(p.received_on, 'YYYY-MM') AS month,
            SUM(p.amount) AS amount, COUNT(*) AS payment_count,
            COUNT(DISTINCT p.enrollment_id) AS student_count
     FROM payments p JOIN enrollments e ON e.id = p.enrollment_id
     WHERE ${where}
     GROUP BY 1 ORDER BY 1`,
    params,
  );
  return result.rows.map((r) => ({
    month: r.month, amount: Number(r.amount), paymentCount: Number(r.payment_count),
    studentCount: Number(r.student_count),
  }));
}

export async function getPaymentModeBreakdown(f: ReportFilters) {
  const params: unknown[] = [f.schoolId, f.academicYearId];
  let where = "e.school_id = $1 AND e.academic_year_id = $2 AND p.clearing_status = 'cleared' AND p.reversed_by IS NULL";
  if (f.classLevelId) { params.push(f.classLevelId); where += ` AND e.class_level_id = $${params.length}`; }
  if (f.sectionId) { params.push(f.sectionId); where += ` AND e.section_id = $${params.length}`; }
  if (f.from) { params.push(f.from); where += ` AND p.received_on >= $${params.length}`; }
  if (f.to) { params.push(f.to); where += ` AND p.received_on <= $${params.length}`; }

  const result = await pool.query(
    `SELECT p.mode, SUM(p.amount) AS amount, COUNT(*) AS count
     FROM payments p JOIN enrollments e ON e.id = p.enrollment_id
     WHERE ${where} GROUP BY p.mode ORDER BY amount DESC`,
    params,
  );
  const total = result.rows.reduce((t, r) => t + Number(r.amount), 0);
  return result.rows.map((r) => ({
    mode: r.mode, amount: Number(r.amount), count: Number(r.count),
    pct: total > 0 ? (Number(r.amount) / total) * 100 : 0,
  }));
}

export async function getRefundAnalytics(f: ReportFilters) {
  const params: unknown[] = [f.schoolId, f.academicYearId];
  let classFilter = "";
  if (f.classLevelId) { params.push(f.classLevelId); classFilter += ` AND e.class_level_id = $${params.length}`; }
  if (f.sectionId) { params.push(f.sectionId); classFilter += ` AND e.section_id = $${params.length}`; }

  const requests = await pool.query(
    `SELECT rr.status, COUNT(*) AS count, COALESCE(SUM(rr.amount), 0) AS amount
     FROM refund_requests rr JOIN enrollments e ON e.id = rr.enrollment_id
     WHERE rr.school_id = $1 AND e.academic_year_id = $2 ${classFilter}
     GROUP BY rr.status`,
    params,
  );
  const processed = await pool.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(r.amount), 0) AS amount,
            COUNT(DISTINCT r.enrollment_id) AS students
     FROM refunds r JOIN enrollments e ON e.id = r.enrollment_id
     WHERE r.school_id = $1 AND e.academic_year_id = $2 ${classFilter}`,
    params,
  );
  const byReason = await pool.query(
    `SELECT COALESCE(NULLIF(r.reason, ''), 'Other') AS reason, SUM(r.amount) AS amount, COUNT(*) AS count
     FROM refunds r JOIN enrollments e ON e.id = r.enrollment_id
     WHERE r.school_id = $1 AND e.academic_year_id = $2 ${classFilter}
     GROUP BY 1 ORDER BY amount DESC`,
    params,
  );
  const bySection = await pool.query(
    `SELECT cl.name AS class_name, sec.name AS section_name,
            SUM(r.amount) AS amount, COUNT(DISTINCT r.enrollment_id) AS students
     FROM refunds r JOIN enrollments e ON e.id = r.enrollment_id
     JOIN class_levels cl ON cl.id = e.class_level_id
     JOIN sections sec ON sec.id = e.section_id
     WHERE r.school_id = $1 AND e.academic_year_id = $2 ${classFilter}
     GROUP BY cl.name, cl.ladder_order, sec.name ORDER BY cl.ladder_order, sec.name`,
    params,
  );

  const statusCounts: Record<string, { count: number; amount: number }> = {};
  for (const r of requests.rows) statusCounts[r.status] = { count: Number(r.count), amount: Number(r.amount) };

  return {
    totalRequests: requests.rows.reduce((t, r) => t + Number(r.count), 0),
    pending: statusCounts.pending?.count ?? 0,
    approved: statusCounts.approved?.count ?? 0,
    rejected: statusCounts.rejected?.count ?? 0,
    processedCount: Number(processed.rows[0].count),
    totalRefunded: Number(processed.rows[0].amount),
    studentsRefunded: Number(processed.rows[0].students),
    byReason: byReason.rows.map((r) => ({ reason: r.reason, amount: Number(r.amount), count: Number(r.count) })),
    bySection: bySection.rows.map((r) => ({
      className: r.class_name, sectionName: r.section_name,
      amount: Number(r.amount), students: Number(r.students),
    })),
  };
}

export async function getTcAnalytics(f: ReportFilters) {
  const params: unknown[] = [f.schoolId, f.academicYearId];
  let classFilter = "";
  if (f.classLevelId) { params.push(f.classLevelId); classFilter += ` AND e.class_level_id = $${params.length}`; }
  if (f.sectionId) { params.push(f.sectionId); classFilter += ` AND e.section_id = $${params.length}`; }

  const requests = await pool.query(
    `SELECT tr.status, COUNT(*) AS count
     FROM tc_requests tr JOIN enrollments e ON e.id = tr.enrollment_id
     WHERE tr.school_id = $1 AND e.academic_year_id = $2 ${classFilter}
     GROUP BY tr.status`,
    params,
  );
  const byExitReason = await pool.query(
    `SELECT COALESCE(e.withdrawal_reason, 'Other') AS reason, COUNT(*) AS count, cl.name AS class_name
     FROM enrollments e JOIN class_levels cl ON cl.id = e.class_level_id
     WHERE e.school_id = $1 AND e.academic_year_id = $2 ${classFilter}
       AND e.is_active = false AND e.outcome IN ('left', 'tc_issued')
     GROUP BY 1, cl.name ORDER BY count DESC`,
    params,
  );
  // By academic year — reads the same request-level status per year
  // that already exists for this school, not fabricated to a fixed
  // window (matches getYearComparison's own "bounded by real data"
  // approach).
  const byYear = await pool.query(
    `SELECT ay.name AS year_name, COUNT(*) AS count
     FROM tc_requests tr
     JOIN enrollments e ON e.id = tr.enrollment_id
     JOIN academic_years ay ON ay.id = e.academic_year_id
     WHERE tr.school_id = $1
     GROUP BY ay.name, ay.starts_on ORDER BY ay.starts_on DESC LIMIT 5`,
    [f.schoolId],
  );

  const statusCounts: Record<string, number> = {};
  for (const r of requests.rows) statusCounts[r.status] = Number(r.count);

  return {
    totalRequests: requests.rows.reduce((t, r) => t + Number(r.count), 0),
    pending: statusCounts.pending_clearance ?? 0,
    approved: statusCounts.cleared ?? 0,
    issued: statusCounts.issued ?? 0,
    rejected: statusCounts.rejected ?? 0,
    byExitReason: byExitReason.rows.map((r) => ({ reason: r.reason, count: Number(r.count), className: r.class_name })),
    byYear: byYear.rows.map((r) => ({ year: r.year_name, count: Number(r.count) })),
  };
}

export async function getPromotionAnalytics(f: ReportFilters) {
  // Rewritten after review, then again after adding explicit
  // 'detained' recording to promotion.ts's commit(). The original
  // version joined promotion_batches to every enrollment in the year,
  // so two committed batches for the same from_year_id (a school
  // promoting in more than one sitting — confirmed possible, since
  // commit() takes an arbitrary move subset) double-counted
  // "considered". It also filtered nothing on outcome, so a student
  // who'd withdrawn before promotion ever ran was wrongly counted as
  // "not promoted".
  //
  // Reads outcome directly off each enrollment instead of joining
  // against batches at all — commit() sets exactly one of these per
  // enrollment, once, regardless of how many separate batches a school
  // runs: 'promoted', 'passed_out' (graduated — a real exit, not a
  // concern, kept separate from "not promoted"), 'detained' (now
  // explicitly recorded at commit time for blocked/held-back moves,
  // rather than inferred after the fact from a student simply still
  // being 'pending' — the earlier version's one remaining
  // approximation, now resolved at the source), or 'left'/'tc_issued'
  // (withdrew beforehand, correctly excluded from "considered"
  // entirely). Historical batches committed before 'detained' existed
  // never marked anyone this way, so the existence check below still
  // guards against a year where promotion genuinely hasn't run yet.
  const batchExists = await pool.query(
    `SELECT 1 FROM promotion_batches WHERE school_id = $1 AND from_year_id = $2 AND status = 'committed' LIMIT 1`,
    [f.schoolId, f.academicYearId],
  );
  if (!batchExists.rows[0]) {
    return { considered: 0, promoted: 0, notPromoted: 0, graduated: 0, byClass: [] };
  }

  const params: unknown[] = [f.schoolId, f.academicYearId];
  let where = "e.school_id = $1 AND e.academic_year_id = $2";
  if (f.classLevelId) { params.push(f.classLevelId); where += ` AND e.class_level_id = $${params.length}`; }
  if (f.sectionId) { params.push(f.sectionId); where += ` AND e.section_id = $${params.length}`; }

  const result = await pool.query(
    `SELECT cl.name AS class_name, cl.ladder_order,
            COUNT(*) FILTER (WHERE e.outcome IN ('promoted', 'passed_out', 'detained')) AS considered,
            COUNT(*) FILTER (WHERE e.outcome = 'promoted') AS promoted,
            COUNT(*) FILTER (WHERE e.outcome = 'passed_out') AS graduated,
            COUNT(*) FILTER (WHERE e.outcome = 'detained') AS not_promoted
     FROM enrollments e
     JOIN class_levels cl ON cl.id = e.class_level_id
     WHERE ${where}
     GROUP BY cl.name, cl.ladder_order ORDER BY cl.ladder_order`,
    params,
  );
  const byClass = result.rows.map((r) => ({
    className: r.class_name, considered: Number(r.considered), promoted: Number(r.promoted),
    graduated: Number(r.graduated), notPromoted: Number(r.not_promoted),
    promotionPct: Number(r.considered) > 0 ? (Number(r.promoted) / Number(r.considered)) * 100 : 0,
  }));
  return {
    considered: byClass.reduce((t, r) => t + r.considered, 0),
    promoted: byClass.reduce((t, r) => t + r.promoted, 0),
    graduated: byClass.reduce((t, r) => t + r.graduated, 0),
    notPromoted: byClass.reduce((t, r) => t + r.notPromoted, 0),
    byClass,
  };
}

export async function getAdmissionAnalytics(f: ReportFilters) {
  const params: unknown[] = [f.schoolId, f.academicYearId];
  let where = "e.school_id = $1 AND e.academic_year_id = $2 AND e.admission_type = 'new'";
  if (f.classLevelId) { params.push(f.classLevelId); where += ` AND e.class_level_id = $${params.length}`; }
  if (f.sectionId) { params.push(f.sectionId); where += ` AND e.section_id = $${params.length}`; }

  const trend = await pool.query(
    `SELECT to_char(e.created_at, 'YYYY-MM') AS month, COUNT(*) AS count
     FROM enrollments e WHERE ${where} GROUP BY 1 ORDER BY 1`,
    params,
  );
  const byClass = await pool.query(
    `SELECT cl.name AS class_name, sec.name AS section_name, COUNT(*) AS count
     FROM enrollments e
     JOIN class_levels cl ON cl.id = e.class_level_id
     JOIN sections sec ON sec.id = e.section_id
     WHERE ${where}
     GROUP BY cl.name, cl.ladder_order, sec.name ORDER BY cl.ladder_order, sec.name`,
    params,
  );
  // "Admission cancelled" — the exit_reason category recorded at NOC
  // approval (already stored as the enrollment's own withdrawal_reason,
  // same source the Left/TC screen reads from), not a separate flag.
  // Same class/section filter applied here as everywhere else above,
  // so a filtered view doesn't silently mix in unfiltered cancellations.
  let cancelledWhere = "e.school_id = $1 AND e.academic_year_id = $2 AND e.withdrawal_reason = 'Admission Cancelled'";
  const cancelledParams: unknown[] = [f.schoolId, f.academicYearId];
  if (f.classLevelId) { cancelledParams.push(f.classLevelId); cancelledWhere += ` AND e.class_level_id = $${cancelledParams.length}`; }
  if (f.sectionId) { cancelledParams.push(f.sectionId); cancelledWhere += ` AND e.section_id = $${cancelledParams.length}`; }
  const cancelled = await pool.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(r.refunded), 0) AS refund_amount
     FROM enrollments e
     LEFT JOIN LATERAL (
       SELECT SUM(amount) AS refunded FROM refunds WHERE enrollment_id = e.id
     ) r ON true
     WHERE ${cancelledWhere}`,
    cancelledParams,
  );

  return {
    trend: trend.rows.map((r) => ({ month: r.month, count: Number(r.count) })),
    byClass: byClass.rows.map((r) => ({ className: r.class_name, sectionName: r.section_name, count: Number(r.count) })),
    cancelledCount: Number(cancelled.rows[0].count),
    cancelledRefundAmount: Number(cancelled.rows[0].refund_amount),
  };
}

export async function getDailyCollection(schoolId: string, date: string) {
  const payments = await pool.query(
    `SELECT mode, SUM(amount) AS amount, COUNT(*) AS count,
            MIN(receipt_no) AS first_receipt, MAX(receipt_no) AS last_receipt
     FROM payments
     WHERE school_id = $1 AND received_on = $2 AND clearing_status = 'cleared' AND reversed_by IS NULL
     GROUP BY mode`,
    [schoolId, date],
  );
  const refunds = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS count
     FROM refunds WHERE school_id = $1 AND created_at::date = $2`,
    [schoolId, date],
  );
  const totalCollected = payments.rows.reduce((t, r) => t + Number(r.amount), 0);
  const receiptCount = payments.rows.reduce((t, r) => t + Number(r.count), 0);
  const firstReceipt = payments.rows.map((r) => r.first_receipt).filter(Boolean).sort()[0] ?? null;
  const lastReceipts = payments.rows.map((r) => r.last_receipt).filter(Boolean).sort();
  const lastReceipt = lastReceipts[lastReceipts.length - 1] ?? null;
  const refundsProcessed = Number(refunds.rows[0].amount);

  return {
    date, totalCollected, receiptCount, byMode: payments.rows.map((r) => ({
      mode: r.mode, amount: Number(r.amount), count: Number(r.count),
    })),
    refundsProcessed, refundCount: Number(refunds.rows[0].count),
    netCollection: totalCollected - refundsProcessed,
    firstReceiptNo: firstReceipt, lastReceiptNo: lastReceipt,
  };
}

/**
 * Academic year comparison — reruns the same base summary per year that
 * actually exists for this school (bounded by real data, never
 * fabricated), not a fixed "last 5" that could include years with
 * nothing in them.
 */
export async function getYearComparison(schoolId: string, limitYears = 5) {
  const years = await pool.query(
    `SELECT id, name, starts_on FROM academic_years WHERE school_id = $1
     ORDER BY starts_on DESC LIMIT $2`,
    [schoolId, limitYears],
  );
  const perYear = await Promise.all(
    years.rows.map(async (y) => {
      const summary = await getReportsSummary({ schoolId, academicYearId: y.id });
      const tc = await getTcAnalytics({ schoolId, academicYearId: y.id });
      const promo = await getPromotionAnalytics({ schoolId, academicYearId: y.id });
      return {
        year: y.name, students: summary.totalEnrollments, newAdmissions: summary.studentKpis.newAdmissions,
        projectedFees: summary.kpis.projectedFees, netCollectibleFees: summary.kpis.netCollectibleFees,
        // Net, not gross — so this row reconciles with its own
        // "pending" column exactly like byClass/bySection do, rather
        // than showing a pre-refund figure next to a post-refund one.
        // collectionPct already uses netCollectibleFees as its
        // denominator (fixed at the source in getReportsSummary), so
        // this inherits that correction automatically.
        collected: summary.kpis.netCollection, grossCollected: summary.kpis.collected,
        collectionPct: summary.kpis.collectionPct, pending: summary.kpis.outstanding,
        concession: summary.kpis.concessionAmount, refund: summary.kpis.refundAmount,
        netCollection: summary.kpis.netCollection,
        tcExitCount: summary.studentKpis.tcIssued + summary.studentKpis.left,
        promoted: promo.promoted, notPromoted: promo.notPromoted,
      };
    }),
  );
  return perYear.reverse(); // oldest first, for left-to-right trend reading
}

/**
 * Per-operator audit — reuses audit_log entirely (Phase 14: "do not
 * create a second audit system"). One GROUP BY over the exact action
 * strings already logged throughout the app; no new logging added.
 * Gated more strictly than the rest of Reports (view_audit_log, not
 * view_reports) at the route level, since Viewer holds view_reports
 * but not view_audit_log and shouldn't see who did what.
 */
export async function getOperatorAudit(schoolId: string, from?: string, to?: string) {
  const params: unknown[] = [schoolId];
  let where = "school_id = $1";
  if (from) { params.push(from); where += ` AND created_at >= $${params.length}`; }
  if (to) { params.push(to); where += ` AND created_at <= $${params.length}::date + interval '1 day'`; }

  const result = await pool.query(
    `SELECT user_id, user_name, user_role,
            COUNT(*) FILTER (WHERE action = 'payment.record') AS payments_entered,
            COUNT(*) FILTER (WHERE action = 'refund.create') AS refunds_processed,
            COUNT(*) FILTER (WHERE action = 'concession.grant') AS concessions_created,
            COUNT(*) FILTER (WHERE action = 'tc.clear') AS tc_approvals,
            COUNT(*) FILTER (WHERE action = 'tc.reject') AS tc_rejections,
            COUNT(*) FILTER (WHERE action = 'refund_request.approve') AS refund_approvals,
            COUNT(*) FILTER (WHERE action = 'refund_request.reject') AS refund_rejections,
            COUNT(*) FILTER (WHERE action = 'payment.void') AS payment_reversals,
            COUNT(*) AS total_actions
     FROM audit_log
     WHERE ${where}
     GROUP BY user_id, user_name, user_role
     ORDER BY total_actions DESC`,
    params,
  );

  return result.rows.map((r) => ({
    userId: r.user_id, userName: r.user_name, userRole: r.user_role,
    paymentsEntered: Number(r.payments_entered), refundsProcessed: Number(r.refunds_processed),
    concessionsCreated: Number(r.concessions_created), tcApprovals: Number(r.tc_approvals),
    tcRejections: Number(r.tc_rejections), refundApprovals: Number(r.refund_approvals),
    refundRejections: Number(r.refund_rejections), paymentReversals: Number(r.payment_reversals),
    totalActions: Number(r.total_actions),
  }));
}

/**
 * Exceptions / Risk — every rule here reads only from data already
 * confirmed reliable elsewhere in this file (Phase 12: "do not invent
 * arbitrary business rules; if an exception can't be reliably
 * determined from existing data, don't display it"). Deliberately
 * narrower than the original wishlist: rules needing data this schema
 * doesn't reliably capture (duplicate payment references, receipt
 * gaps) are left out rather than approximated.
 */
export async function getExceptions(f: ReportFilters) {
  const rows = await getEnrollmentFinancials(f);

  const highOutstanding = rows
    .filter((r) => r.outstanding > 2500000) // > ₹25,000 — the same top aging bucket already used above
    .sort((a, b) => b.outstanding - a.outstanding)
    .slice(0, 25)
    .map((r) => ({
      rule: "High Outstanding", severity: "high" as const, enrollmentId: r.enrollment_id,
      className: r.class_name, sectionName: r.section_name, amount: r.outstanding,
      reason: `₹${(r.outstanding / 100).toLocaleString("en-IN")} outstanding`,
    }));

  // Refunded but still owing — the exact case the review called out:
  // a partial refund followed by outstanding still remaining, worth a
  // second look rather than assumed settled.
  const refundedWithOutstanding = rows
    .filter((r) => r.refunded > 0 && r.outstanding > 0)
    .sort((a, b) => b.outstanding - a.outstanding)
    .slice(0, 25)
    .map((r) => ({
      rule: "Refund + Remaining Outstanding", severity: "medium" as const, enrollmentId: r.enrollment_id,
      className: r.class_name, sectionName: r.section_name, amount: r.outstanding,
      reason: `Refunded ₹${(r.refunded / 100).toLocaleString("en-IN")}, still ₹${(r.outstanding / 100).toLocaleString("en-IN")} outstanding`,
    }));

  // Exited (left/TC) while still financially outstanding — a real,
  // reliably-detectable pattern: is_active/outcome and outstanding are
  // both already-trusted fields, just not previously cross-checked
  // against each other.
  const inactiveWithOutstanding = rows
    .filter((r) => !r.is_active && r.outstanding > 0)
    .sort((a, b) => b.outstanding - a.outstanding)
    .slice(0, 25)
    .map((r) => ({
      rule: "Exited With Outstanding Balance", severity: "high" as const, enrollmentId: r.enrollment_id,
      className: r.class_name, sectionName: r.section_name, amount: r.outstanding,
      reason: `${r.withdrawal_reason || r.outcome}, ₹${(r.outstanding / 100).toLocaleString("en-IN")} still owed`,
    }));

  // Unusually large concession — flagged relative to this school's own
  // data (more than 3x the median concession among students who got
  // one), not an arbitrary fixed rupee threshold that wouldn't fit
  // every school's fee scale.
  const concessions = rows.filter((r) => r.conceded > 0).map((r) => r.conceded).sort((a, b) => a - b);
  const medianConcession = concessions.length ? concessions[Math.floor(concessions.length / 2)] : 0;
  const unusualConcessions = medianConcession > 0
    ? rows.filter((r) => r.conceded > medianConcession * 3).sort((a, b) => b.conceded - a.conceded).slice(0, 25)
        .map((r) => ({
          rule: "Unusually Large Concession", severity: "medium" as const, enrollmentId: r.enrollment_id,
          className: r.class_name, sectionName: r.section_name, amount: r.conceded,
          reason: `₹${(r.conceded / 100).toLocaleString("en-IN")} concession, over 3× this school's median of ₹${(medianConcession / 100).toLocaleString("en-IN")}`,
        }))
    : [];

  const pendingTc = await pool.query(
    `SELECT tr.id, s.full_name, cl.name AS class_name, sec.name AS section_name, tr.requested_on
     FROM tc_requests tr JOIN enrollments e ON e.id = tr.enrollment_id
     JOIN students s ON s.id = e.student_id
     JOIN class_levels cl ON cl.id = e.class_level_id JOIN sections sec ON sec.id = e.section_id
     WHERE tr.school_id = $1 AND tr.status = 'pending_clearance' ORDER BY tr.requested_on ASC LIMIT 25`,
    [f.schoolId],
  );
  const pendingRefunds = await pool.query(
    `SELECT rr.id, s.full_name, cl.name AS class_name, sec.name AS section_name, rr.amount, rr.requested_on
     FROM refund_requests rr JOIN enrollments e ON e.id = rr.enrollment_id
     JOIN students s ON s.id = e.student_id
     JOIN class_levels cl ON cl.id = e.class_level_id JOIN sections sec ON sec.id = e.section_id
     WHERE rr.school_id = $1 AND rr.status = 'pending' ORDER BY rr.requested_on ASC LIMIT 25`,
    [f.schoolId],
  );

  const pendingApprovals = [
    ...pendingTc.rows.map((r) => ({
      rule: "Pending TC Approval", severity: "low" as const, enrollmentId: null,
      className: r.class_name, sectionName: r.section_name, amount: 0,
      reason: `${r.full_name} — requested ${new Date(r.requested_on).toLocaleDateString("en-IN")}`,
    })),
    ...pendingRefunds.rows.map((r) => ({
      rule: "Pending Refund Approval", severity: "low" as const, enrollmentId: null,
      className: r.class_name, sectionName: r.section_name, amount: Number(r.amount),
      reason: `${r.full_name} — ₹${(Number(r.amount) / 100).toLocaleString("en-IN")} requested`,
    })),
  ];

  return {
    highOutstanding, refundedWithOutstanding, inactiveWithOutstanding, unusualConcessions, pendingApprovals,
    totalExceptions: highOutstanding.length + refundedWithOutstanding.length + inactiveWithOutstanding.length
      + unusualConcessions.length + pendingApprovals.length,
  };
}
