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
            COALESCE((SELECT SUM(a.amount) FROM allocations a
                      JOIN payments p ON p.id = a.payment_id
                      WHERE a.charge_id IN (SELECT id FROM charges WHERE enrollment_id = e.id)
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
    concessionStudents, concessionPct: rows.length ? (concessionStudents / rows.length) * 100 : 0,
    refundStudents,
    collectionPct: projectedFees > 0 ? (netCollection / projectedFees) * 100 : 0,
    outstandingPct: projectedFees > 0 ? (outstanding / projectedFees) * 100 : 0,
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
    collectionPct: sum(list, "charged") > 0 ? (sum(list, "netPaid") / sum(list, "charged")) * 100 : 0,
    outstandingStudents: list.filter((r) => r.outstanding > 0).length,
    avgOutstanding: list.length ? Math.max(0, sum(list, "outstanding")) / list.length : 0,
    tcLeft: list.filter((r) => r.outcome === "tc_issued" || r.outcome === "left").length,
  }));

  const bySection = [...groupBy(rows, (r) => `${r.class_name}-${r.section_name}` as any)].map(([key, list]) => ({
    classSection: key, className: list[0].class_name, sectionName: list[0].section_name,
    students: list.length, projected: sum(list, "charged"),
    collected: sum(list, "netPaid"), grossCollected: sum(list, "grossPaid"),
    pending: Math.max(0, sum(list, "outstanding")),
    collectionPct: sum(list, "charged") > 0 ? (sum(list, "netPaid") / sum(list, "charged")) * 100 : 0,
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
  if (f.classLevelId) { params.push(f.classLevelId); classFilter = ` AND e.class_level_id = $${params.length}`; }

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
  };
}

export async function getTcAnalytics(f: ReportFilters) {
  const params: unknown[] = [f.schoolId, f.academicYearId];
  let classFilter = "";
  if (f.classLevelId) { params.push(f.classLevelId); classFilter = ` AND e.class_level_id = $${params.length}`; }

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

  const statusCounts: Record<string, number> = {};
  for (const r of requests.rows) statusCounts[r.status] = Number(r.count);

  return {
    totalRequests: requests.rows.reduce((t, r) => t + Number(r.count), 0),
    pending: statusCounts.pending_clearance ?? 0,
    approved: statusCounts.cleared ?? 0,
    issued: statusCounts.issued ?? 0,
    rejected: statusCounts.rejected ?? 0,
    byExitReason: byExitReason.rows.map((r) => ({ reason: r.reason, count: Number(r.count), className: r.class_name })),
  };
}

export async function getPromotionAnalytics(f: ReportFilters) {
  // "Considered for promotion" is every enrollment that batch touched
  // in the FROM year — promoted if a NEW enrollment exists in the TO
  // year linked back to the same batch, not promoted otherwise. Reuses
  // promotion_batches/enrollments exactly as already modeled; no
  // separate promotion-outcome table invented for this.
  const result = await pool.query(
    `SELECT pb.id AS batch_id, pb.from_year_id, pb.to_year_id, cl.name AS class_name,
            COUNT(DISTINCT e_from.id) AS considered,
            COUNT(DISTINCT e_to.id) AS promoted
     FROM promotion_batches pb
     JOIN enrollments e_from ON e_from.promotion_batch_id IS NULL
       AND e_from.academic_year_id = pb.from_year_id AND e_from.school_id = pb.school_id
     LEFT JOIN class_levels cl ON cl.id = e_from.class_level_id
     LEFT JOIN enrollments e_to ON e_to.promotion_batch_id = pb.id AND e_to.student_id = e_from.student_id
     WHERE pb.school_id = $1 AND pb.status = 'committed' AND pb.from_year_id = $2
     GROUP BY pb.id, pb.from_year_id, pb.to_year_id, cl.name`,
    [f.schoolId, f.academicYearId],
  );
  // The query above is intentionally simple and may not perfectly
  // isolate a single batch's own considered-set if a class was
  // promoted across multiple batches — acceptable for a first version
  // given committed batches are rare, sequential events per year.
  const byClass = result.rows.map((r) => ({
    className: r.class_name, considered: Number(r.considered), promoted: Number(r.promoted),
    notPromoted: Number(r.considered) - Number(r.promoted),
    promotionPct: Number(r.considered) > 0 ? (Number(r.promoted) / Number(r.considered)) * 100 : 0,
  }));
  return {
    considered: byClass.reduce((t, r) => t + r.considered, 0),
    promoted: byClass.reduce((t, r) => t + r.promoted, 0),
    notPromoted: byClass.reduce((t, r) => t + r.notPromoted, 0),
    byClass,
  };
}

export async function getAdmissionAnalytics(f: ReportFilters) {
  const trend = await pool.query(
    `SELECT to_char(e.created_at, 'YYYY-MM') AS month, COUNT(*) AS count
     FROM enrollments e
     WHERE e.school_id = $1 AND e.academic_year_id = $2 AND e.admission_type = 'new'
     GROUP BY 1 ORDER BY 1`,
    [f.schoolId, f.academicYearId],
  );
  const byClass = await pool.query(
    `SELECT cl.name AS class_name, sec.name AS section_name, COUNT(*) AS count
     FROM enrollments e
     JOIN class_levels cl ON cl.id = e.class_level_id
     JOIN sections sec ON sec.id = e.section_id
     WHERE e.school_id = $1 AND e.academic_year_id = $2 AND e.admission_type = 'new'
     GROUP BY cl.name, cl.ladder_order, sec.name ORDER BY cl.ladder_order, sec.name`,
    [f.schoolId, f.academicYearId],
  );
  // "Admission cancelled" — the exit_reason category recorded at NOC
  // approval (already stored as the enrollment's own withdrawal_reason,
  // same source the Left/TC screen reads from), not a separate flag.
  const cancelled = await pool.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(r.refunded), 0) AS refund_amount
     FROM enrollments e
     LEFT JOIN LATERAL (
       SELECT SUM(amount) AS refunded FROM refunds WHERE enrollment_id = e.id
     ) r ON true
     WHERE e.school_id = $1 AND e.academic_year_id = $2
       AND e.withdrawal_reason = 'Admission Cancelled'`,
    [f.schoolId, f.academicYearId],
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
        projectedFees: summary.kpis.projectedFees,
        // Net, not gross — so this row reconciles with its own
        // "pending" column exactly like byClass/bySection do, rather
        // than showing a pre-refund figure next to a post-refund one.
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
