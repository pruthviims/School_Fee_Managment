/**
 * Bulk import of an existing student roll.
 *
 * A school's first upload comes out of whatever they were using before —
 * a spreadsheet a clerk has maintained by hand for nine years. It will
 * have merged headers, blank rows, dates in four formats, duplicate
 * admission numbers, and class names written five different ways.
 *
 * So the pipeline is: parse -> map columns -> validate -> DRY RUN ->
 * commit. Nothing touches Student until an admin looks at the errors and
 * confirms — stageImport only ever writes ImportRow rows.
 */

import Papa from "papaparse";
import { pool } from "../db/index.js";
import { generateChargesBulk } from "./billing.js";
import { recordPaymentsBulk } from "./collection.js";
import type { PoolClient } from "pg";

export class ImportServiceError extends Error {}

/**
 * [IMPORT] batch=<id> phase=<phase> rows=<n> durationMs=<ms>
 *
 * Deliberately excludes anything from a row's own data — names, phone
 * numbers, emails, addresses, payment amounts — logging only the batch
 * id (an opaque UUID, not identifying on its own), the phase name, a
 * row count, and how long that phase took. Enough to see where time is
 * actually going in Vercel's logs without putting student PII in a log
 * stream that outlives this request.
 */
function logPhase(batchId: string, phase: string, rows: number, startedAt: number) {
  console.log(`[IMPORT] batch=${batchId} phase=${phase} rows=${rows} durationMs=${Date.now() - startedAt}`);
}

interface StudentBulkRow {
  admissionNo: string; fullName: string; dateOfBirth: string | null; gender: string;
  bloodGroup: string; contactType: string; fatherName: string; fatherPhone: string;
  fatherEmail: string; motherName: string; motherPhone: string; motherEmail: string;
  guardianRelationship: string; guardianName: string; guardianPhone: string;
  guardianEmail: string; address: string;
}

/**
 * All of a batch's new students in a single INSERT instead of one per
 * row — the same shape as generateChargesBulk and recordPaymentsBulk
 * before it. Returns admission number -> student id rather than
 * relying on RETURNING preserving input order: Postgres doesn't
 * guarantee row order for a set-based unnest()-driven INSERT the way
 * it would for a single-row one, so admission_no (already proven
 * unique within this batch by stageImport's own validation, both
 * against duplicates in the file and against existing students) is
 * used as the actual join key instead — correct regardless of what
 * order the rows come back in.
 */
async function createStudentsBulk(
  schoolId: string, rows: StudentBulkRow[], createdBy: string | null, client: PoolClient,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (rows.length === 0) return map;

  const result = await client.query(
    `INSERT INTO students
       (school_id, admission_no, full_name, date_of_birth, gender, blood_group,
        contact_type, father_name, father_phone, father_email,
        mother_name, mother_phone, mother_email, guardian_relationship,
        guardian_name, guardian_phone, guardian_email, address, created_by)
     SELECT $1, admission_no, full_name, date_of_birth, gender, blood_group, contact_type,
            father_name, father_phone, father_email, mother_name, mother_phone, mother_email,
            guardian_relationship, guardian_name, guardian_phone, guardian_email, address, $2
     FROM unnest(
       $3::text[], $4::text[], $5::date[], $6::text[], $7::text[], $8::text[], $9::text[],
       $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[],
       $16::text[], $17::text[], $18::text[], $19::text[]
     ) AS t(admission_no, full_name, date_of_birth, gender, blood_group, contact_type,
            father_name, father_phone, father_email, mother_name, mother_phone, mother_email,
            guardian_relationship, guardian_name, guardian_phone, guardian_email, address)
     RETURNING id, admission_no`,
    [
      schoolId, createdBy,
      rows.map((r) => r.admissionNo), rows.map((r) => r.fullName), rows.map((r) => r.dateOfBirth),
      rows.map((r) => r.gender), rows.map((r) => r.bloodGroup), rows.map((r) => r.contactType),
      rows.map((r) => r.fatherName), rows.map((r) => r.fatherPhone), rows.map((r) => r.fatherEmail),
      rows.map((r) => r.motherName), rows.map((r) => r.motherPhone), rows.map((r) => r.motherEmail),
      rows.map((r) => r.guardianRelationship), rows.map((r) => r.guardianName),
      rows.map((r) => r.guardianPhone), rows.map((r) => r.guardianEmail), rows.map((r) => r.address),
    ],
  );
  for (const row of result.rows) map.set(row.admission_no, row.id);
  return map;
}

interface EnrollmentBulkRow {
  admissionNo: string; // join key back to the student created above
  classLevelId: string; sectionId: string; streamId: string | null; rollNo: number | null;
}

/**
 * The enrollment sibling of createStudentsBulk, same reasoning: one
 * INSERT for every enrollment in the batch, mapped back by student id
 * rather than assumed RETURNING order. Safe here specifically because
 * every enrollment in this list belongs to a student createStudentsBulk
 * just created fresh in this same transaction — each student id is
 * guaranteed to appear exactly once, so student id -> enrollment id is
 * a true 1:1 mapping, not an approximation.
 */
async function createEnrollmentsBulk(
  schoolId: string, academicYearId: string, rows: EnrollmentBulkRow[],
  studentIdByAdmissionNo: Map<string, string>, createdBy: string | null, client: PoolClient,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (rows.length === 0) return map;

  const studentIds = rows.map((r) => studentIdByAdmissionNo.get(r.admissionNo)!);

  const result = await client.query(
    `INSERT INTO enrollments
       (school_id, student_id, academic_year_id, class_level_id, section_id, stream_id,
        roll_no, admission_type, created_by)
     SELECT $1, student_id, $2, class_level_id, section_id, stream_id, roll_no, 'carry_over', $3
     FROM unnest(
       $4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[], $8::int[]
     ) AS t(student_id, class_level_id, section_id, stream_id, roll_no)
     -- Imported students were already at the school; they are not new
     -- admissions and must not be charged an admission fee — the
     -- 'carry_over' admission_type is what selectChargeableLines uses
     -- (via generateChargesBulk below) to correctly skip any one-time
     -- (admission) fee line. Same rule as the row-by-row version this
     -- replaces, just no longer a per-row literal.
     RETURNING id, student_id`,
    [
      schoolId, academicYearId, createdBy,
      studentIds, rows.map((r) => r.classLevelId), rows.map((r) => r.sectionId),
      rows.map((r) => r.streamId), rows.map((r) => r.rollNo),
    ],
  );
  for (const row of result.rows) map.set(row.student_id, row.id);
  return map;
}

/**
 * Links every import_row back to the student it produced, in one
 * UPDATE ... FROM instead of one per row — the same purpose the
 * original per-row UPDATE served (a row that's already been committed
 * shows which student it became, e.g. if the batch needs auditing
 * later), just no longer paying for it once per row.
 */
async function updateImportRowsBulk(
  pairs: { rowId: string; studentId: string }[], client: PoolClient,
): Promise<void> {
  if (pairs.length === 0) return;
  await client.query(
    `UPDATE import_rows SET student_id = v.student_id
     FROM unnest($1::uuid[], $2::uuid[]) AS v(row_id, student_id)
     WHERE import_rows.id = v.row_id`,
    [pairs.map((p) => p.rowId), pairs.map((p) => p.studentId)],
  );
}

// What we need, and the header spellings seen in the wild.
const FIELDS: Record<string, string[]> = {
  admission_no: ["admission no", "admission number", "adm no", "adm.no",
    "admno", "reg no", "registration no", "sl no"],
  full_name: ["name", "student name", "name of student", "full name", "student"],
  class_name: ["class", "std", "standard", "grade", "class name"],
  section: ["section", "sec", "div", "division"],
  roll_no: ["roll no", "roll", "roll number"],
  date_of_birth: ["dob", "date of birth", "birth date", "d.o.b"],
  gender: ["gender", "sex"],
  blood_group: ["blood group", "blood grp", "bg", "blood type"],
  // father_name/mother_name are checked first in suggestColumnMap below
  // (see the note there) so a column literally titled "Father Name"
  // claims that dedicated field rather than the older, more generic
  // guardian_name — which still exists for a sheet that only has one
  // undifferentiated parent/guardian contact column, not one per parent.
  father_name: ["father name", "father's name", "fathers name"],
  father_phone: ["father phone", "father's phone", "father mobile", "father contact"],
  father_email: ["father email", "father's email"],
  mother_name: ["mother name", "mother's name", "mothers name"],
  mother_phone: ["mother phone", "mother's phone", "mother mobile", "mother contact"],
  mother_email: ["mother email", "mother's email"],
  guardian_relationship: ["relationship", "guardian relationship", "relation to student", "relation"],
  guardian_name: ["parent name", "guardian name", "parent", "guardian"],
  guardian_phone: ["phone", "mobile", "contact", "phone no",
    "mobile no", "contact number"],
  guardian_email: ["email", "email id", "e-mail"],
  address: ["address", "residential address"],
  stream: ["stream", "combination", "group"],
  bus_stop: ["bus stop", "stop", "transport stop", "pickup point"],
  amount_paid: ["amount paid", "paid so far", "amount paid so far",
    "payments done so far", "paid amount", "fees paid"],
};

const REQUIRED = ["admission_no", "full_name", "class_name"];

// "1st PU", "I PUC", "STD VIII", "8th", "Class 8" all mean one thing.
const ROMAN: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
};
const ROMAN_BY_VALUE: Record<number, string> = Object.fromEntries(
  Object.entries(ROMAN).map(([k, v]) => [v, k.toUpperCase()]),
);

function norm(s: string): string {
  return (s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Guess which uploaded column is which. The admin can override every guess — never import on a guess alone. */
export function suggestColumnMap(headers: string[]): Record<string, number> {
  const mapping: Record<string, number> = {};
  const used = new Set<number>();
  for (const [field, aliases] of Object.entries(FIELDS)) {
    const normAliases = aliases.map(norm);
    for (let i = 0; i < headers.length; i++) {
      if (used.has(i)) continue;
      const h = norm(headers[i]);
      if (h === norm(field) || normAliases.includes(h)) {
        mapping[field] = i;
        used.add(i);
        break;
      }
    }
  }
  return mapping;
}

/** Map a free-text class label onto a canonical ladder name. Returns "" when it can't be resolved. */
export function normaliseClass(raw: string): string {
  let t = norm(raw);
  if (!t) return "";
  t = t.replace(/^(class|std|standard|grade)\s+/, "");
  t = t.replace(/\s+(class|std|standard)$/, "");

  if (["pre lkg", "prelkg", "pre kg", "prekg", "nursery", "play home",
    "playhome", "pre nursery"].includes(t)) return "Pre-LKG";
  if (["lkg", "l k g", "jr kg", "junior kg"].includes(t)) return "LKG";
  if (["ukg", "u k g", "sr kg", "senior kg"].includes(t)) return "UKG";

  if (/^(1|1st|i)\s*(pu|puc|pum)$/.test(t)) return "1st PU";
  if (/^(2|2nd|ii)\s*(pu|puc|pum)$/.test(t)) return "2nd PU";
  if (["11", "11th", "xi"].includes(t)) return "1st PU";
  if (["12", "12th", "xii"].includes(t)) return "2nd PU";

  const m = t.match(/^(\d{1,2})(st|nd|rd|th)?$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 10) return ROMAN_BY_VALUE[n];
  }
  if (t in ROMAN) return t.toUpperCase();
  return "";
}

export function normalisePhone(raw: string): string {
  let digits = (raw || "").replace(/\D/g, "");
  if (digits.length > 10 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length > 10 && digits.startsWith("0")) digits = digits.replace(/^0+/, "");
  return digits;
}

const KNOWN_BLOOD_GROUPS = new Set(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]);

/** "M"/"Male"/"F"/"Female" map directly; anything else non-blank becomes "other" rather than an error. */
export function normaliseGender(raw: string): "male" | "female" | "other" | null {
  const t = (raw || "").trim().toLowerCase();
  if (!t) return null;
  if (["m", "male", "boy"].includes(t)) return "male";
  if (["f", "female", "girl"].includes(t)) return "female";
  return "other";
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

interface DateFormat {
  regex: RegExp;
  extract: (m: RegExpMatchArray) => { year: number; month: number; day: number } | null;
}

// Tried in this exact order — Indian sheets are overwhelmingly day-first,
// so %d/%m/%Y is tried before %m/%d/%Y, which only ever matches what
// day-first couldn't (an invalid month in the day-first reading). This
// is why "03/04/2015" reads as 3 April, not March 4.
const DATE_FORMATS: DateFormat[] = [
  { regex: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, extract: (m) => ({ day: +m[1], month: +m[2], year: +m[3] }) },
  { regex: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, extract: (m) => ({ day: +m[1], month: +m[2], year: +m[3] }) },
  { regex: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, extract: (m) => ({ year: +m[1], month: +m[2], day: +m[3] }) },
  { regex: /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, extract: (m) => ({ day: +m[1], month: +m[2], year: +m[3] }) },
  { regex: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, extract: (m) => ({ day: +m[1], month: +m[2], year: 2000 + +m[3] }) },
  {
    regex: /^(\d{1,2})-([A-Za-z]{3,})-(\d{4})$/,
    extract: (m) => {
      const mon = MONTH_NAMES[m[2].toLowerCase().slice(0, 3)];
      return mon ? { day: +m[1], month: mon, year: +m[3] } : null;
    },
  },
  {
    regex: /^(\d{1,2}) ([A-Za-z]{3,}) (\d{4})$/,
    extract: (m) => {
      const mon = MONTH_NAMES[m[2].toLowerCase().slice(0, 3)];
      return mon ? { day: +m[1], month: mon, year: +m[3] } : null;
    },
  },
  { regex: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, extract: (m) => ({ month: +m[1], day: +m[2], year: +m[3] }) },
];

export function parseDate(raw: string): string | null {
  const t = (raw || "").trim();
  if (!t) return null;

  for (const fmt of DATE_FORMATS) {
    const m = t.match(fmt.regex);
    if (!m) continue;
    const parts = fmt.extract(m);
    if (!parts) continue;
    let { year, month, day } = parts;
    if (!validDate(year, month, day)) continue;

    const currentYear = new Date().getFullYear();
    if (year > currentYear) year -= 100;
    if (!validDate(year, month, day)) continue; // guards Feb 29 shifting across a leap year
    return isoDate(year, month, day);
  }
  return null;
}

/** Read CSV, skipping the blank and title rows real files start with. */
export function readRows(content: string): { headers: string[]; body: string[][] } {
  const parsed = Papa.parse<string[]>(content, { skipEmptyLines: false });
  const allRows = (parsed.data as string[][]).filter(
    (r) => r.some((c) => (c || "").trim()),
  );
  if (allRows.length === 0) throw new ImportServiceError("That file has no readable rows.");

  // The header is the first row with the most non-empty cells in the
  // first five — schools often put the school name on line 1.
  const scanLimit = Math.min(5, allRows.length);
  let headIdx = 0;
  let bestCount = -1;
  for (let i = 0; i < scanLimit; i++) {
    const count = allRows[i].filter((c) => (c || "").trim()).length;
    if (count > bestCount) { bestCount = count; headIdx = i; }
  }

  return { headers: allRows[headIdx], body: allRows.slice(headIdx + 1) };
}

export interface StageImportInput {
  schoolId: string;
  academicYearId: string;
  filename: string;
  content: string;
  columnMap?: Record<string, number>;
  createdBy?: string | null;
}

/** Parse, validate, and hold. Writes ImportRow only — never Student. */
export async function stageImport(input: StageImportInput): Promise<unknown> {
  const { headers, body } = readRows(input.content);
  const columnMap = input.columnMap ?? suggestColumnMap(headers);

  const missing = REQUIRED.filter((f) => !(f in columnMap));
  if (missing.length > 0) {
    throw new ImportServiceError(
      "These columns could not be found: " +
      missing.map((f) => f.replace(/_/g, " ")).join(", ") +
      ". Map them by hand and try again.",
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const batchResult = await client.query(
      `INSERT INTO import_batches
         (school_id, academic_year_id, filename, column_map, status, total_rows, created_by)
       VALUES ($1, $2, $3, $4, 'validated', $5, $6)
       RETURNING *`,
      [input.schoolId, input.academicYearId, input.filename, JSON.stringify(columnMap),
       body.length, input.createdBy ?? null],
    );
    const batch = batchResult.rows[0];

    const classesResult = await client.query(
      `SELECT name FROM class_levels WHERE school_id = $1`, [input.schoolId],
    );
    const knownClasses = new Set(classesResult.rows.map((r) => r.name));

    // Same rule enforced everywhere else a student gets enrolled
    // (New Admission, Class Promotion, transport assignment): a class
    // with no priced fee_structure line at all refuses the row outright,
    // rather than admitting for free. Checked once per academic year
    // here, not per row.
    const pricedResult = await client.query(
      `SELECT DISTINCT cl.name FROM fee_structures fs
       JOIN class_levels cl ON cl.id = fs.class_level_id
       WHERE fs.school_id = $1 AND fs.academic_year_id = $2 AND fs.amount > 0`,
      [input.schoolId, input.academicYearId],
    );
    const pricedClasses = new Set(pricedResult.rows.map((r) => r.name));

    const existingResult = await client.query(
      `SELECT admission_no FROM students WHERE school_id = $1`, [input.schoolId],
    );
    const existingAdm = new Set(existingResult.rows.map((r) => r.admission_no));
    const seenAdm = new Set<string>();

    const stopsResult = await client.query(
      `SELECT LOWER(rs.name) AS name FROM route_stops rs WHERE rs.school_id = $1`,
      [input.schoolId],
    );
    const knownStops = new Set(stopsResult.rows.map((r) => r.name));

    let valid = 0;

    for (let offset = 0; offset < body.length; offset++) {
      const row = body[offset];
      const cell = (field: string): string => {
        const i = columnMap[field];
        if (i === undefined || i >= row.length) return "";
        return (row[i] || "").trim();
      };

      const errors: string[] = [];
      const warnings: string[] = [];
      const raw: Record<string, string> = {};
      for (const field of Object.keys(columnMap)) raw[field] = cell(field);

      const adm = cell("admission_no");
      const name = cell("full_name");
      const klassRaw = cell("class_name");
      const klass = normaliseClass(klassRaw);

      if (!adm) {
        errors.push("Admission number is blank.");
      } else if (seenAdm.has(adm)) {
        errors.push(`Admission number ${adm} appears twice in this file.`);
      } else if (existingAdm.has(adm)) {
        errors.push(`Admission number ${adm} is already in the system.`);
      } else {
        seenAdm.add(adm);
      }

      if (!name) {
        errors.push("Student name is blank.");
      } else if (name.length < 2) {
        errors.push(`Name '${name}' looks incomplete.`);
      }

      if (!klass) {
        errors.push(
          `Could not read the class '${klassRaw}'. ` +
          "Use Pre-LKG, LKG, UKG, I to X, 1st PU or 2nd PU.",
        );
      } else if (!knownClasses.has(klass)) {
        errors.push(`${klass} is not set up for this school yet.`);
      } else if (!pricedClasses.has(klass)) {
        errors.push(`${klass} has no fees set up yet for this year. Set up Fee Structure for it first.`);
      }

      const section = (cell("section") || "A").toUpperCase().slice(0, 10);

      const dobRaw = cell("date_of_birth");
      const dob = parseDate(dobRaw);
      if (dobRaw && !dob) warnings.push(`Could not read the date '${dobRaw}'. Left blank.`);

      const genderRaw = cell("gender");
      const gender = normaliseGender(genderRaw);
      if (!genderRaw) {
        warnings.push("No gender given. Left blank — can be filled in later from the student's profile.");
      } else if (!gender) {
        warnings.push(`Could not read gender '${genderRaw}'. Use Male, Female, or Other. Left blank.`);
      }

      const bloodGroup = cell("blood_group").toUpperCase().replace(/\s+/g, "");
      if (bloodGroup && !KNOWN_BLOOD_GROUPS.has(bloodGroup)) {
        warnings.push(`Blood group '${cell("blood_group")}' isn't a standard group — kept as entered.`);
      }

      const checkPhone = (field: string, label: string) => {
        const raw = cell(field);
        const normalised = normalisePhone(raw);
        if (raw && normalised.length !== 10) {
          warnings.push(`${label} phone '${raw}' is not 10 digits. Kept as is.`);
        }
        return normalised;
      };
      const fatherPhone = checkPhone("father_phone", "Father's");
      const motherPhone = checkPhone("mother_phone", "Mother's");
      const guardianPhoneGeneric = checkPhone("guardian_phone", "Guardian");

      // Which of Parents/Guardian applies is inferred from whichever
      // columns actually have data — a school's existing roster may
      // record just one parent, both, or a non-parent guardian, and
      // bulk-importing historical data shouldn't force the same
      // both-required rule New Admission applies to a fresh entry.
      const fatherName = cell("father_name");
      const motherName = cell("mother_name");
      const guardianRelationship = cell("guardian_relationship");
      const guardianNameRaw = cell("guardian_name");
      const contactType = (fatherName || motherName) ? "parents" : "guardian";
      if (!fatherName && !motherName && !guardianNameRaw) {
        warnings.push("No parent or guardian name given. Fee reminders will have no contact.");
      }

      const amountPaidRaw = cell("amount_paid");
      let amountPaidRupees = 0;
      if (amountPaidRaw) {
        const parsed = Number(amountPaidRaw.replace(/[,₹\s]/g, ""));
        if (!Number.isFinite(parsed) || parsed < 0) {
          warnings.push(`Could not read amount paid '${amountPaidRaw}'. Treated as 0.`);
        } else {
          amountPaidRupees = parsed;
        }
      }

      const stopName = cell("bus_stop");
      if (stopName && !knownStops.has(stopName.toLowerCase())) {
        warnings.push(`Bus stop '${stopName}' is not on any route. Transport not assigned.`);
      }

      raw._class = klass;
      raw._section = section;
      raw._dob = dob ?? "";
      raw._gender = gender ?? "";
      raw._blood_group = bloodGroup;
      raw._father_phone = fatherPhone;
      raw._mother_phone = motherPhone;
      raw._guardian_phone = guardianPhoneGeneric;
      raw._contact_type = contactType;
      raw._amount_paid_paise = String(Math.round(amountPaidRupees * 100));

      await client.query(
        `INSERT INTO import_rows (school_id, batch_id, line_no, raw, errors, warnings)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.schoolId, batch.id, offset + 1, JSON.stringify(raw),
         JSON.stringify(errors), JSON.stringify(warnings)],
      );
      if (errors.length === 0) valid++;
    }

    const updated = await client.query(
      `UPDATE import_batches SET valid_rows = $1 WHERE id = $2 RETURNING *`,
      [valid, batch.id],
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

/**
 * Creates students, enrollments, and — now that a class actually has
 * fees set up for it (see the zero-fee-blocking check below, the same
 * one New Admission already enforces) — their charges too, exactly
 * like a normal admission would generate. Confirmed with the client:
 * importing a roll used to deliberately stop at the records, on the
 * theory that billing was a separate decision made later — but
 * nothing else in the app ever actually took that later step, so an
 * imported student showed as owing nothing at all. If the sheet also
 * says how much they've already paid this year, that gets recorded as
 * a real payment against those same charges, so the balance reflects
 * where they actually stand, not a blank slate.
 */
export async function commitImport(
  batchId: string, { skipInvalid = true, committedBy = null }:
    { skipInvalid?: boolean; committedBy?: string | null } = {},
): Promise<{ created: number; skipped: number; unpriced: string[] }> {
  const totalStart = Date.now();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let t = Date.now();
    const batchResult = await client.query(`SELECT * FROM import_batches WHERE id = $1 FOR UPDATE`,
      [batchId]);
    const batch = batchResult.rows[0];
    if (!batch) throw new ImportServiceError("Import batch not found.");
    if (batch.status !== "validated") {
      throw new ImportServiceError("This batch has already been committed or cancelled.");
    }
    logPhase(batchId, "load_batch", 1, t);

    // generateCharges (used per-row before this became a bulk operation)
    // refused a closed academic year on its own, every time it was
    // called. generateChargesBulk doesn't carry that check internally —
    // it's meant to run once per operation, not once per enrollment —
    // so it has to be checked once, explicitly, here instead. Checked
    // before any row is processed, not only once charge generation is
    // reached: the whole commit rolls back together either way, but
    // failing before doing any work is strictly better than failing
    // after creating students and enrollments that only get undone.
    const yearResult = await client.query(
      `SELECT status, name FROM academic_years WHERE id = $1`, [batch.academic_year_id],
    );
    if (yearResult.rows[0]?.status === "closed") {
      throw new ImportServiceError(`${yearResult.rows[0].name} is closed; no new charges may be posted.`);
    }

    t = Date.now();
    const rowsResult = await client.query(
      `SELECT * FROM import_rows WHERE batch_id = $1 ORDER BY line_no`, [batchId],
    );
    const rows = rowsResult.rows;
    const bad = rows.filter((r) => (r.errors as unknown[]).length > 0);
    if (bad.length > 0 && !skipInvalid) {
      throw new ImportServiceError(
        `${bad.length} rows still have errors. Fix them or choose to skip.`,
      );
    }
    logPhase(batchId, "load_rows", rows.length, t);

    t = Date.now();
    const classesResult = await client.query(
      `SELECT id, name, requires_stream FROM class_levels WHERE school_id = $1`, [batch.school_id],
    );
    const classesByName = new Map(classesResult.rows.map((c) => [c.name, c]));

    const streamsResult = await client.query(
      `SELECT id, name FROM streams WHERE school_id = $1`, [batch.school_id],
    );
    const streamsByLowerName = new Map(streamsResult.rows.map((s) => [s.name.toLowerCase(), s]));

    // Same rule New Admission already enforces: a class with no priced
    // fee_structure line at all doesn't get charges generated for it —
    // computed once here for every class in the file, rather than
    // re-querying per row.
    const pricedResult = await client.query(
      `SELECT DISTINCT class_level_id FROM fee_structures
       WHERE school_id = $1 AND academic_year_id = $2 AND amount > 0`,
      [batch.school_id, batch.academic_year_id],
    );
    const pricedClassIds = new Set(pricedResult.rows.map((r) => r.class_level_id));
    logPhase(batchId, "load_reference_data", classesResult.rows.length + streamsResult.rows.length, t);

    // ---- Pass 1: pure in-memory derivation, plus section resolution ----
    // (the only DB work here — a dedicated, tiny cache keyed by class +
    // section name, not one query per row; see the comment below).
    // Nothing here creates a student, an enrollment, or touches
    // import_rows yet — everything needed for those is collected into
    // plain arrays first, so each of those becomes exactly one bulk
    // operation afterward instead of many small ones interleaved with
    // this derivation logic.
    t = Date.now();
    const studentRows: StudentBulkRow[] = [];
    const enrollmentRows: EnrollmentBulkRow[] = [];
    const rowIdByAdmissionNo = new Map<string, string>();
    const classByAdmissionNo = new Map<string, { id: string; name: string }>();
    const enrollmentRowByAdmissionNo = new Map<string, EnrollmentBulkRow>();
    const pendingAmountByAdmissionNo = new Map<string, number>();
    const unpricedClassNames = new Set<string>();
    // Sections repeat far more than they vary — an entire class's worth
    // of rows shares the same handful of section names — so each
    // distinct (class, section name) pair is created at most once here,
    // not re-attempted with the same ON CONFLICT UPDATE for every row
    // that happens to land in a section a previous row already created.
    const sectionIdByKey = new Map<string, string>();

    for (const row of rows) {
      if ((row.errors as unknown[]).length > 0) continue;
      const raw = row.raw as Record<string, string>;

      const klass = classesByName.get(raw._class)!;
      const contactType = raw._contact_type === "parents" ? "parents" : "guardian";
      // Same derivation New Admission uses: the primary contact every
      // other screen reads (guardian_name/phone/email) comes from
      // whichever parent is actually reachable when Parents applies,
      // or the guardian's own details otherwise — father checked first
      // only as a deterministic tie-break, not a statement about who
      // the real contact is.
      const primaryName = contactType === "guardian" ? (raw.guardian_name ?? "")
        : ((raw.father_name || raw.mother_name) ?? "");
      const primaryPhone = contactType === "guardian" ? (raw._guardian_phone ?? "")
        : ((raw._father_phone || raw._mother_phone) ?? "");
      const primaryEmail = contactType === "guardian" ? (raw.guardian_email ?? "")
        : ((raw.father_email || raw.mother_email) ?? "");

      const sectionKey = `${klass.id}:${raw._section}`;
      let sectionId = sectionIdByKey.get(sectionKey);
      if (!sectionId) {
        const sectionResult = await client.query(
          `INSERT INTO sections (school_id, academic_year_id, class_level_id, name, capacity)
           VALUES ($1, $2, $3, $4, 100)
           ON CONFLICT (school_id, academic_year_id, class_level_id, name) DO UPDATE
             SET name = EXCLUDED.name
           RETURNING id`,
          [batch.school_id, batch.academic_year_id, klass.id, raw._section],
        );
        sectionId = sectionResult.rows[0].id;
        sectionIdByKey.set(sectionKey, sectionId!);
      }

      let streamId: string | null = null;
      if (klass.requires_stream) {
        const key = (raw.stream ?? "").trim().toLowerCase();
        if (key) {
          streamId = streamsByLowerName.get(key)?.id ??
            [...streamsByLowerName.entries()].find(([k]) => k.includes(key))?.[1]?.id ?? null;
        }
      }
      const rollNo = /^\d+$/.test(raw.roll_no ?? "") ? parseInt(raw.roll_no, 10) : null;
      const admissionNo = raw.admission_no ?? "";

      studentRows.push({
        admissionNo, fullName: raw.full_name ?? "", dateOfBirth: raw._dob || null,
        gender: raw._gender ?? "", bloodGroup: raw._blood_group ?? "", contactType,
        fatherName: raw.father_name ?? "", fatherPhone: raw._father_phone ?? "",
        fatherEmail: raw.father_email ?? "", motherName: raw.mother_name ?? "",
        motherPhone: raw._mother_phone ?? "", motherEmail: raw.mother_email ?? "",
        guardianRelationship: raw.guardian_relationship ?? "", guardianName: primaryName,
        guardianPhone: primaryPhone, guardianEmail: primaryEmail, address: raw.address ?? "",
      });
      enrollmentRows.push({ admissionNo, classLevelId: klass.id, sectionId: sectionId!, streamId, rollNo });
      enrollmentRowByAdmissionNo.set(admissionNo, enrollmentRows[enrollmentRows.length - 1]);
      rowIdByAdmissionNo.set(admissionNo, row.id);
      classByAdmissionNo.set(admissionNo, klass);
      if (pricedClassIds.has(klass.id)) {
        const amountPaidPaise = Number(raw._amount_paid_paise ?? "0");
        if (amountPaidPaise > 0) pendingAmountByAdmissionNo.set(admissionNo, amountPaidPaise);
      } else {
        unpricedClassNames.add(klass.name);
      }
    }
    logPhase(batchId, "sections", sectionIdByKey.size, t);

    t = Date.now();
    const studentIdByAdmissionNo = await createStudentsBulk(
      batch.school_id, studentRows, committedBy, client,
    );
    logPhase(batchId, "students", studentRows.length, t);

    t = Date.now();
    const enrollmentIdByStudentId = await createEnrollmentsBulk(
      batch.school_id, batch.academic_year_id, enrollmentRows, studentIdByAdmissionNo, committedBy, client,
    );
    logPhase(batchId, "enrollments", enrollmentRows.length, t);

    t = Date.now();
    const importRowPairs = [...studentIdByAdmissionNo.entries()].map(([admissionNo, studentId]) => ({
      rowId: rowIdByAdmissionNo.get(admissionNo)!, studentId,
    }));
    await updateImportRowsBulk(importRowPairs, client);
    logPhase(batchId, "update_import_rows", importRowPairs.length, t);

    // ---- Charges and payments: pure in-memory assembly, then the two
    // bulk operations that already existed before this pass. ----
    const enrollmentsForCharges: { enrollmentId: string; schoolId: string; academicYearId: string;
      classLevelId: string; streamId: string | null; admissionType: string }[] = [];
    const pendingPayments: { enrollmentId: string; amountPaidPaise: number }[] = [];
    for (const [admissionNo, studentId] of studentIdByAdmissionNo) {
      const klass = classByAdmissionNo.get(admissionNo)!;
      if (!pricedClassIds.has(klass.id)) continue;
      const enrollmentId = enrollmentIdByStudentId.get(studentId)!;
      const enrollmentRow = enrollmentRowByAdmissionNo.get(admissionNo)!;
      enrollmentsForCharges.push({
        enrollmentId, schoolId: batch.school_id, academicYearId: batch.academic_year_id,
        classLevelId: klass.id, streamId: enrollmentRow.streamId, admissionType: "carry_over",
      });
      const amountPaidPaise = pendingAmountByAdmissionNo.get(admissionNo);
      if (amountPaidPaise) pendingPayments.push({ enrollmentId, amountPaidPaise });
    }

    t = Date.now();
    await generateChargesBulk(enrollmentsForCharges, { createdBy: committedBy, client });
    logPhase(batchId, "charges", enrollmentsForCharges.length, t);

    t = Date.now();
    await recordPaymentsBulk(
      pendingPayments.map((p) => ({
        enrollmentId: p.enrollmentId, schoolId: batch.school_id, amount: p.amountPaidPaise,
        mode: "cash", instrumentRef: "Opening balance from import", collectedBy: committedBy,
      })),
      { client },
    );
    logPhase(batchId, "payments", pendingPayments.length, t);

    t = Date.now();
    await client.query(
      `UPDATE import_batches SET status = 'committed', committed_at = now() WHERE id = $1`,
      [batchId],
    );
    logPhase(batchId, "finalize_batch", 1, t);

    t = Date.now();
    await client.query("COMMIT");
    logPhase(batchId, "commit", 1, t);

    logPhase(batchId, "total", rows.length, totalStart);
    return { created: studentIdByAdmissionNo.size, skipped: bad.length, unpriced: [...unpricedClassNames] };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}


/** The blank sheet to hand a school that has nothing usable. */
export function templateCsv(): string {
  const cols = ["Admission No", "Name", "Class", "Section", "Roll No",
    "DOB", "Gender", "Blood Group",
    "Father Name", "Father Phone", "Father Email",
    "Mother Name", "Mother Phone", "Mother Email",
    "Guardian Relationship", "Guardian Name", "Phone", "Email",
    "Address", "Stream", "Bus Stop", "Amount Paid So Far"];
  const example = ["2026/0001", "Ananya Krishnamurthy", "VIII", "A", "1",
    "14/03/2012", "F", "O+",
    "R. Krishnamurthy", "9845012345", "father@example.com",
    "S. Krishnamurthy", "9845012346", "mother@example.com",
    "", "", "", "",
    "12 MG Road, Bengaluru", "", "Jayanagar 4th Block", "15000"];
  return Papa.unparse([cols, example]);
}
