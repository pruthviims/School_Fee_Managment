/**
 * The promotion engine: rolling a whole school up one rung of the
 * ladder. Three phases, never one button:
 *
 *   preview()       -> proposed moves, with balances, nothing written
 *   (the office adjusts exclusions, sections, and PUC streams)
 *   assignSections() -> fills in the section for each move
 *   commit()        -> one transaction, tagged with a PromotionBatch id
 *   reverseBatch()  -> undo, allowed only while the target year is PLANNING
 *
 * The branch that breaks naive implementations: X -> 1st PUC is not
 * automatic. Many students leave for another board or college, and
 * those who stay must choose a stream. Any class level flagged
 * requires_explicit_optin is excluded from the default proposal and has
 * to be opted in per student.
 *
 * A ProposedMove crosses an HTTP boundary between preview and commit (the
 * office reviews and adjusts it client-side), so it's a plain
 * serializable object with a `kind` discriminator rather than the three
 * separate Python lists the Django version kept in one process — and
 * commit() never trusts a client-supplied "this is actionable" flag,
 * recomputing it server-side from the move's own fields.
 */

import { pool } from "../db/index.js";
import { generateChargesBulk } from "./billing.js";
import { getBulkEnrollmentLedgers, getEnrollmentLedger } from "./ledger.js";

export class PromotionError extends Error {}

export interface ProposedMove {
  kind: "promote" | "graduate" | "blocked";
  enrollmentId: string;
  studentId: string;
  admissionNo: string;
  studentName: string;
  fromClassName: string;
  fromSectionName: string;
  toClassId: string | null;
  toClassName: string | null;
  toSectionId: string | null;
  streamId: string | null;
  balance: number;
  needsStream: boolean;
  needsOptin: boolean;
  blockedReason: string;
}

export function isActionable(move: ProposedMove): boolean {
  return move.kind === "promote" && move.toClassId !== null && !move.blockedReason &&
    !move.needsOptin && !(move.needsStream && move.streamId === null);
}

export interface PromotionPreview {
  fromYearId: string;
  toYearId: string;
  moves: ProposedMove[];
  graduating: ProposedMove[];
  blocked: ProposedMove[];
}

export function previewSummary(preview: PromotionPreview) {
  const promotable = preview.moves.filter(isActionable).length;
  const totalArrears = preview.moves
    .filter((m) => m.balance > 0)
    .reduce((sum, m) => sum + m.balance, 0);
  return {
    promotable,
    needsDecision: preview.moves.length - promotable,
    graduating: preview.graduating.length,
    blocked: preview.blocked.length,
    totalArrearsPaise: totalArrears,
  };
}

/** Compute proposed moves. Writes nothing. */
export async function preview(
  { fromYearId, toYearId, blockOnDues = false, excludeEnrollmentIds = [] }:
  { fromYearId: string; toYearId: string; blockOnDues?: boolean; excludeEnrollmentIds?: string[] },
): Promise<PromotionPreview> {
  const yearsResult = await pool.query(
    `SELECT id, school_id, starts_on FROM academic_years WHERE id = ANY($1::uuid[])`,
    [[fromYearId, toYearId]],
  );
  const fromYear = yearsResult.rows.find((r) => r.id === fromYearId);
  const toYear = yearsResult.rows.find((r) => r.id === toYearId);
  if (!fromYear || !toYear) throw new PromotionError("Academic year not found.");
  if (fromYear.school_id !== toYear.school_id) {
    throw new PromotionError("Cannot promote across schools.");
  }
  if (toYear.starts_on <= fromYear.starts_on) {
    throw new PromotionError("Target year must follow the source year.");
  }

  const exclude = new Set(excludeEnrollmentIds);
  const result: PromotionPreview = { fromYearId, toYearId, moves: [], graduating: [], blocked: [] };

  const enrollmentsResult = await pool.query(
    `SELECT e.id, e.student_id, e.stream_id, e.outcome,
            s.admission_no, s.full_name AS student_name,
            cl.id AS class_id, cl.name AS class_name, cl.ladder_order,
            cl.is_terminal, sec.name AS section_name
     FROM enrollments e
     JOIN students s ON s.id = e.student_id
     JOIN class_levels cl ON cl.id = e.class_level_id
     JOIN sections sec ON sec.id = e.section_id
     WHERE e.academic_year_id = $1 AND e.is_active = true
       AND e.outcome NOT IN ('tc_issued', 'left')
     ORDER BY cl.ladder_order, sec.name, e.roll_no NULLS LAST`,
    [fromYearId],
  );

  // Both of these used to be looked up per row inside the loop below —
  // a real N+1 for a school with a real student count, since every
  // enrolled student (not just the ones actually moving) got its own
  // balance calculation and its own "what's the next class up" query.
  // Neither actually depends on anything per-row that isn't already
  // known up front: every class ladder rung is looked up here once
  // regardless of how many students are in it, and every enrollment's
  // balance is computed in a single query instead of one call each.
  const classLevelsResult = await pool.query(
    `SELECT id, name, ladder_order, requires_stream, requires_explicit_optin
     FROM class_levels WHERE school_id = $1`,
    [fromYear.school_id],
  );
  const classLevelsByLadderOrder = new Map(classLevelsResult.rows.map((c) => [c.ladder_order, c]));

  const enrollmentIds = enrollmentsResult.rows
    .filter((row) => !exclude.has(row.id))
    .map((row) => row.id);
  const ledgers = await getBulkEnrollmentLedgers(enrollmentIds);

  for (const row of enrollmentsResult.rows) {
    if (exclude.has(row.id)) continue;

    const balance = ledgers.get(row.id)?.balance ?? 0;
    const base = {
      enrollmentId: row.id, studentId: row.student_id, admissionNo: row.admission_no,
      studentName: row.student_name, fromClassName: row.class_name,
      fromSectionName: row.section_name, balance,
    };

    if (row.outcome === "detained") {
      result.blocked.push({
        ...base, kind: "blocked", toClassId: row.class_id, toClassName: row.class_name,
        toSectionId: null, streamId: null, needsStream: false, needsOptin: false,
        blockedReason: "Detained — repeats the same class.",
      });
      continue;
    }

    if (row.is_terminal) {
      result.graduating.push({
        ...base, kind: "graduate", toClassId: null, toClassName: null, toSectionId: null,
        streamId: null, needsStream: false, needsOptin: false,
        blockedReason: "Completes schooling — becomes alumni.",
      });
      continue;
    }

    const next = classLevelsByLadderOrder.get(row.ladder_order + 1);
    if (!next) {
      result.blocked.push({
        ...base, kind: "blocked", toClassId: null, toClassName: null, toSectionId: null,
        streamId: null, needsStream: false, needsOptin: false,
        blockedReason: `No class configured above ${row.class_name}.`,
      });
      continue;
    }

    let needsStream = next.requires_stream;
    let streamId: string | null = null;
    // Same stream carries forward automatically (1st PUC -> 2nd PUC).
    if (next.requires_stream && row.stream_id) {
      streamId = row.stream_id;
      needsStream = false;
    }

    let blockedReason = "";
    if (blockOnDues && balance > 0) {
      blockedReason = `Outstanding dues of ${(balance / 100).toFixed(2)}; school policy blocks promotion.`;
    }

    const move: ProposedMove = {
      ...base, kind: blockedReason ? "blocked" : "promote",
      toClassId: next.id, toClassName: next.name, toSectionId: null, streamId,
      needsStream, needsOptin: next.requires_explicit_optin, blockedReason,
    };
    (blockedReason ? result.blocked : result.moves).push(move);
  }

  return result;
}

/**
 * Fill in toSectionId on each move.
 *   "keep"    — same section name if it exists in the target class, else balance.
 *   "balance" — round-robin into the least-full sections.
 * Schools reshuffle sections deliberately, so this is always overridable
 * per student — the office can hand-edit toSectionId before commit.
 */
export async function assignSections(
  moves: ProposedMove[],
  { toYearId, strategy = "keep" }: { toYearId: string; strategy?: "keep" | "balance" },
): Promise<ProposedMove[]> {
  if (strategy !== "keep" && strategy !== "balance") {
    throw new PromotionError(`Unknown section strategy: ${strategy}`);
  }

  const sectionsByClass = new Map<string, { id: string; name: string; capacity: number }[]>();
  const counts = new Map<string, number>();

  for (const move of moves) {
    if (move.kind !== "promote" || !move.toClassId) continue;

    if (!sectionsByClass.has(move.toClassId)) {
      const available = await pool.query(
        `SELECT id, name, capacity FROM sections
         WHERE academic_year_id = $1 AND class_level_id = $2 ORDER BY name`,
        [toYearId, move.toClassId],
      );
      if (available.rows.length === 0) {
        throw new PromotionError(
          `No sections configured for ${move.toClassName} in this year.`,
        );
      }
      sectionsByClass.set(move.toClassId, available.rows);
      for (const s of available.rows) {
        const countResult = await pool.query(
          `SELECT COUNT(*) FROM enrollments WHERE section_id = $1`, [s.id],
        );
        counts.set(s.id, Number(countResult.rows[0].count));
      }
    }

    const available = sectionsByClass.get(move.toClassId)!;
    let chosen: { id: string; name: string; capacity: number } | undefined;

    if (strategy === "keep") {
      const sameName = available.find((s) => s.name === move.fromSectionName);
      if (sameName && (counts.get(sameName.id) ?? 0) < sameName.capacity) {
        chosen = sameName;
      }
    }
    if (!chosen) {
      chosen = [...available].sort((a, b) =>
        (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0) || a.name.localeCompare(b.name),
      )[0];
    }

    move.toSectionId = chosen.id;
    counts.set(chosen.id, (counts.get(chosen.id) ?? 0) + 1);
  }

  return moves;
}

/**
 * Execute the rollover in a single transaction, tagged with a batch id.
 * Order matters: arrears carry-forward reads the OLD enrollment's
 * balance, so it must run before any charges are posted to the new one.
 */
export async function commit(
  { fromYearId, toYearId, moves, carryArrears = true, generateNewCharges = true, committedBy = null }:
  {
    fromYearId: string; toYearId: string; moves: ProposedMove[];
    carryArrears?: boolean; generateNewCharges?: boolean; committedBy?: string | null;
  },
): Promise<unknown> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const toYearResult = await client.query(
      `SELECT id, school_id, status, starts_on FROM academic_years WHERE id = $1 FOR UPDATE`, [toYearId],
    );
    const toYear = toYearResult.rows[0];
    if (!toYear) throw new PromotionError("Target year not found.");
    if (toYear.status === "closed") throw new PromotionError("Target year is closed.");

    const actionable = moves.filter(isActionable);
    if (actionable.length === 0) throw new PromotionError("No actionable moves — nothing to commit.");

    const missingSection = actionable.filter((m) => !m.toSectionId);
    if (missingSection.length > 0) {
      throw new PromotionError(
        `${missingSection.length} moves have no section assigned. Run assignSections first.`,
      );
    }

    // Same reasoning as New Admission's own check: promoting students
    // into a class whose fees were never actually set up for the target
    // year would otherwise silently generate zero-rupee charges — far
    // more likely a forgotten setup step than an intentional free class.
    // Checked once for every distinct target class in this batch, not
    // per-move, since the same unpriced class would otherwise fail
    // identically for every student moving into it.
    const targetClassIds = [...new Set(actionable.map((m) => m.toClassId))];
    const pricedResult = await client.query(
      `SELECT DISTINCT class_level_id FROM fee_structures
       WHERE school_id = $1 AND academic_year_id = $2 AND class_level_id = ANY($3) AND amount > 0`,
      [toYear.school_id, toYearId, targetClassIds],
    );
    const pricedClassIds = new Set(pricedResult.rows.map((r) => r.class_level_id));
    const unpriced = targetClassIds.filter((id) => !pricedClassIds.has(id));
    if (unpriced.length > 0) {
      throw new PromotionError(
        "One or more target classes have no fees set up yet for this academic year. " +
        "Set up Fee Structure for them first.",
      );
    }

    const batchResult = await client.query(
      `INSERT INTO promotion_batches
         (school_id, from_year_id, to_year_id, status, committed_at, committed_by,
          carry_forward_arrears, created_by)
       VALUES ($1, $2, $3, 'committed', now(), $4, $5, $4)
       RETURNING *`,
      [toYear.school_id, fromYearId, toYearId, committedBy, carryArrears],
    );
    const batch = batchResult.rows[0];

    // The single biggest cost in this whole operation used to be here:
    // carryForwardArrears (called once per student) is itself 5 queries
    // just to compute one balance (getEnrollmentLedger), plus a few
    // more to load both enrollments and check for an existing arrear —
    // for a real promotion batch, that's the dominant share of what
    // made this take over a minute. Replicating its exact logic here,
    // batched, rather than modifying the shared function other callers
    // (a standalone TC/withdrawal reconciliation, for instance) still
    // rely on for a single enrollment at a time.
    //
    // Two things make batching this safe rather than just faster:
    // every "from" enrollment shares the same fromYearId (already a
    // parameter here, no per-student lookup needed for the year's own
    // name), and every "to" enrollment is one this same call is about
    // to INSERT fresh a few lines below — so the "does an arrear
    // already exist for it" check carryForwardArrears normally does is
    // structurally impossible to be true here and is correctly omitted,
    // not merely skipped for speed.
    let fromYearName = "";
    if (carryArrears) {
      const fromYearResult = await client.query(
        `SELECT name FROM academic_years WHERE id = $1`, [fromYearId],
      );
      fromYearName = fromYearResult.rows[0]?.name ?? "";
    }
    const fromLedgers = carryArrears
      ? await getBulkEnrollmentLedgers(actionable.map((m) => m.enrollmentId), client)
      : new Map();

    const enrollmentsForCharges: { enrollmentId: string; schoolId: string; academicYearId: string;
      classLevelId: string; streamId: string | null; admissionType: string }[] = [];
    const arrearRows: { enrollmentId: string; balance: number }[] = [];

    for (const move of actionable) {
      const newEnrollment = await client.query(
        `INSERT INTO enrollments
           (school_id, student_id, academic_year_id, class_level_id, section_id,
            stream_id, admission_type, outcome, promotion_batch_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'carry_over', 'pending', $7, $8)
         RETURNING id`,
        [toYear.school_id, move.studentId, toYearId, move.toClassId, move.toSectionId,
         move.streamId, batch.id, committedBy],
      );
      const newEnrollmentId = newEnrollment.rows[0].id;

      // Read the old balance BEFORE new charges land on the student —
      // satisfied here by fromLedgers already having been computed, in
      // full, before this loop (and therefore before any new-year
      // charge exists for anyone), not merely before this one student's
      // own charges specifically.
      if (carryArrears) {
        const balance = fromLedgers.get(move.enrollmentId)?.balance ?? 0;
        if (balance > 0) arrearRows.push({ enrollmentId: newEnrollmentId, balance });
      }
      if (generateNewCharges) {
        enrollmentsForCharges.push({
          enrollmentId: newEnrollmentId, schoolId: toYear.school_id, academicYearId: toYearId,
          classLevelId: move.toClassId!, streamId: move.streamId, admissionType: "carry_over",
        });
      }
    }

    if (arrearRows.length > 0) {
      await client.query(
        `INSERT INTO charges
           (school_id, enrollment_id, fee_head_id, head_name, amount, term_no,
            due_on, source, is_arrear, source_year_id, created_by)
         SELECT $1, enrollment_id, NULL, $2, amount, 1, $3, 'arrear', true, $4, $5
         FROM unnest($6::uuid[], $7::bigint[]) AS t(enrollment_id, amount)`,
        [toYear.school_id, `Arrears carried forward (${fromYearName})`, toYear.starts_on,
         fromYearId, committedBy,
         arrearRows.map((r) => r.enrollmentId), arrearRows.map((r) => r.balance)],
      );
    }

    await generateChargesBulk(enrollmentsForCharges, { createdBy: committedBy, client });

    await client.query(
      `UPDATE enrollments SET outcome = 'promoted', is_active = false WHERE id = ANY($1::uuid[])`,
      [actionable.map((m) => m.enrollmentId)],
    );

    // Terminal-class students exit to alumni rather than a new enrollment.
    const graduating = moves.filter((m) => m.kind === "graduate");
    if (graduating.length > 0) {
      await client.query(
        `UPDATE enrollments SET outcome = 'passed_out', is_active = false WHERE id = ANY($1::uuid[])`,
        [graduating.map((m) => m.enrollmentId)],
      );
      await client.query(
        `UPDATE students SET status = 'alumni' WHERE id = ANY($1::uuid[])`,
        [graduating.map((m) => m.studentId)],
      );
    }

    await client.query("COMMIT");
    return batch;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Undo a rollover. Only while the target year is still PLANNING — once
 * fees have been collected against the new year, unwinding would orphan
 * receipts.
 */
export async function reverseBatch(batchId: string): Promise<unknown> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const batchResult = await client.query(
      `SELECT pb.*, ay.status AS to_year_status FROM promotion_batches pb
       JOIN academic_years ay ON ay.id = pb.to_year_id
       WHERE pb.id = $1 FOR UPDATE`,
      [batchId],
    );
    const batch = batchResult.rows[0];
    if (!batch) throw new PromotionError("Promotion batch not found.");
    if (batch.status !== "committed") throw new PromotionError("Only a committed batch can be reversed.");
    if (batch.to_year_status !== "planning") {
      throw new PromotionError(
        "Target year is no longer in planning; reverse is unsafe. " +
        "Correct individual enrollments instead.",
      );
    }

    const newEnrollments = await client.query(
      `SELECT id, student_id FROM enrollments WHERE promotion_batch_id = $1`, [batchId],
    );
    const newEnrollmentIds = newEnrollments.rows.map((r) => r.id);

    const paidCheck = await client.query(
      `SELECT 1 FROM payments WHERE enrollment_id = ANY($1::uuid[]) LIMIT 1`,
      [newEnrollmentIds],
    );
    if (paidCheck.rows.length > 0) {
      throw new PromotionError("Payments already recorded against this batch; cannot reverse.");
    }

    // Only structure/arrear charges can exist here — nothing paid, by
    // the check above — so this never deletes a charge with money
    // against it. Same operations as before (delete this batch's
    // charges, reactivate whichever old enrollment each student came
    // from, delete this batch's enrollments), just each done once
    // across every enrollment in the batch instead of once per
    // enrollment — undoing a batch that promoted a whole school used to
    // mean 4 queries for every single student in it.
    if (newEnrollmentIds.length > 0) {
      await client.query(`DELETE FROM charges WHERE enrollment_id = ANY($1::uuid[])`, [newEnrollmentIds]);

      const studentIds = newEnrollments.rows.map((r) => r.student_id);
      const previousResult = await client.query(
        `SELECT id FROM enrollments WHERE student_id = ANY($1::uuid[]) AND academic_year_id = $2`,
        [studentIds, batch.from_year_id],
      );
      const previousIds = previousResult.rows.map((r) => r.id);
      if (previousIds.length > 0) {
        await client.query(
          `UPDATE enrollments SET outcome = 'pending', is_active = true WHERE id = ANY($1::uuid[])`,
          [previousIds],
        );
      }

      await client.query(`DELETE FROM enrollments WHERE id = ANY($1::uuid[])`, [newEnrollmentIds]);
    }

    const updated = await client.query(
      `UPDATE promotion_batches SET status = 'reversed' WHERE id = $1 RETURNING *`,
      [batchId],
    );
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
