import { pool } from "../db/index.js";

export async function resetFeeDomain() {
  // Order matters: children before parents. accounts tables (memberships,
  // users, schools) are reset separately in accounts tests — this covers
  // everything the billing/admissions/promotion domain adds.
  await pool.query(`
    TRUNCATE allocations, payments, charges, concessions, invoices,
             transport_assignments, import_rows, import_batches,
             enrollments, students,
             transport_fares, route_stops, bus_routes,
             fee_structures, fee_heads,
             sections, streams, class_levels, academic_years,
             promotion_batches, document_counters
    RESTART IDENTITY CASCADE
  `);
}

export async function createAcademicYear(
  schoolId: string,
  overrides: Partial<{ name: string; starts_on: string; ends_on: string; status: string }> = {},
) {
  const result = await pool.query(
    `INSERT INTO academic_years (school_id, name, starts_on, ends_on, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [schoolId, overrides.name ?? "2026-27", overrides.starts_on ?? "2026-06-01",
     overrides.ends_on ?? "2027-03-31", overrides.status ?? "active"],
  );
  return result.rows[0];
}

export async function createClassLevel(
  schoolId: string,
  overrides: Partial<{ name: string; ladder_order: number; stage: string; is_terminal: boolean; requires_stream: boolean }> = {},
) {
  const result = await pool.query(
    `INSERT INTO class_levels (school_id, name, ladder_order, stage, is_terminal, requires_stream)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [schoolId, overrides.name ?? "VIII", overrides.ladder_order ?? 8,
     overrides.stage ?? "middle", overrides.is_terminal ?? false, overrides.requires_stream ?? false],
  );
  return result.rows[0];
}

export async function createSection(
  schoolId: string, academicYearId: string, classLevelId: string, name = "A",
) {
  const result = await pool.query(
    `INSERT INTO sections (school_id, academic_year_id, class_level_id, name)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [schoolId, academicYearId, classLevelId, name],
  );
  return result.rows[0];
}

export async function createFeeHead(
  schoolId: string,
  overrides: Partial<{ name: string; is_optional: boolean; is_one_time: boolean; display_order: number }> = {},
) {
  const result = await pool.query(
    `INSERT INTO fee_heads (school_id, name, is_optional, is_one_time, display_order)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [schoolId, overrides.name ?? "Tuition fee", overrides.is_optional ?? false,
     overrides.is_one_time ?? false, overrides.display_order ?? 0],
  );
  return result.rows[0];
}

export async function createFeeStructureLine(
  schoolId: string, academicYearId: string, classLevelId: string, feeHeadId: string,
  overrides: Partial<{ amount: number; term_no: number; due_on: string; stream_id: string | null }> = {},
) {
  const result = await pool.query(
    `INSERT INTO fee_structures
       (school_id, academic_year_id, class_level_id, fee_head_id, stream_id,
        amount, term_no, due_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [schoolId, academicYearId, classLevelId, feeHeadId, overrides.stream_id ?? null,
     overrides.amount ?? 400000, overrides.term_no ?? 1, overrides.due_on ?? "2026-06-15"],
  );
  return result.rows[0];
}

export async function createStudent(
  schoolId: string,
  overrides: Partial<{ admission_no: string; full_name: string }> = {},
) {
  const result = await pool.query(
    `INSERT INTO students (school_id, admission_no, full_name)
     VALUES ($1, $2, $3) RETURNING *`,
    [schoolId, overrides.admission_no ?? `ADM-${Date.now()}-${Math.random()}`,
     overrides.full_name ?? "Test Student"],
  );
  return result.rows[0];
}

export async function createEnrollment(
  schoolId: string, studentId: string, academicYearId: string,
  classLevelId: string, sectionId: string,
  overrides: Partial<{ admission_type: string }> = {},
) {
  const result = await pool.query(
    `INSERT INTO enrollments
       (school_id, student_id, academic_year_id, class_level_id, section_id, admission_type)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [schoolId, studentId, academicYearId, classLevelId, sectionId,
     overrides.admission_type ?? "new"],
  );
  return result.rows[0];
}
