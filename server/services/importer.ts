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

export class ImportServiceError extends Error {}

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
  guardian_name: ["parent name", "father name", "guardian name",
    "father's name", "parent", "guardian"],
  guardian_phone: ["phone", "mobile", "contact", "phone no",
    "mobile no", "contact number"],
  guardian_email: ["email", "email id", "e-mail"],
  address: ["address", "residential address"],
  stream: ["stream", "combination", "group"],
  bus_stop: ["bus stop", "stop", "transport stop", "pickup point"],
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
      }

      const section = (cell("section") || "A").toUpperCase().slice(0, 10);

      const dobRaw = cell("date_of_birth");
      const dob = parseDate(dobRaw);
      if (dobRaw && !dob) warnings.push(`Could not read the date '${dobRaw}'. Left blank.`);

      const phoneRaw = cell("guardian_phone");
      const phone = normalisePhone(phoneRaw);
      if (phoneRaw && phone.length !== 10) {
        warnings.push(`Phone '${phoneRaw}' is not 10 digits. Kept as is.`);
      }
      if (!cell("guardian_name")) {
        warnings.push("No guardian name. Fee reminders will have no contact.");
      }

      const stopName = cell("bus_stop");
      if (stopName && !knownStops.has(stopName.toLowerCase())) {
        warnings.push(`Bus stop '${stopName}' is not on any route. Transport not assigned.`);
      }

      raw._class = klass;
      raw._section = section;
      raw._dob = dob ?? "";
      raw._phone = phone;

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
 * Create students and enrollments from a validated batch. Deliberately
 * does NOT generate charges — importing a roll is a records exercise;
 * billing them is a separate, explicit decision the admin makes once the
 * fee structure is confirmed correct.
 */
export async function commitImport(
  batchId: string, { skipInvalid = true, committedBy = null }:
    { skipInvalid?: boolean; committedBy?: string | null } = {},
): Promise<{ created: number; skipped: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const batchResult = await client.query(`SELECT * FROM import_batches WHERE id = $1 FOR UPDATE`,
      [batchId]);
    const batch = batchResult.rows[0];
    if (!batch) throw new ImportServiceError("Import batch not found.");
    if (batch.status !== "validated") {
      throw new ImportServiceError("This batch has already been committed or cancelled.");
    }

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

    const classesResult = await client.query(
      `SELECT id, name, requires_stream FROM class_levels WHERE school_id = $1`, [batch.school_id],
    );
    const classesByName = new Map(classesResult.rows.map((c) => [c.name, c]));

    const streamsResult = await client.query(
      `SELECT id, name FROM streams WHERE school_id = $1`, [batch.school_id],
    );
    const streamsByLowerName = new Map(streamsResult.rows.map((s) => [s.name.toLowerCase(), s]));

    let created = 0;

    for (const row of rows) {
      if ((row.errors as unknown[]).length > 0) continue;
      const raw = row.raw as Record<string, string>;

      const klass = classesByName.get(raw._class)!;

      const sectionResult = await client.query(
        `INSERT INTO sections (school_id, academic_year_id, class_level_id, name, capacity)
         VALUES ($1, $2, $3, $4, 40)
         ON CONFLICT (school_id, academic_year_id, class_level_id, name) DO UPDATE
           SET name = EXCLUDED.name
         RETURNING id`,
        [batch.school_id, batch.academic_year_id, klass.id, raw._section],
      );
      const sectionId = sectionResult.rows[0].id;

      const studentResult = await client.query(
        `INSERT INTO students
           (school_id, admission_no, full_name, date_of_birth, gender,
            guardian_name, guardian_phone, guardian_email, address, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [batch.school_id, raw.admission_no ?? "", raw.full_name ?? "", raw._dob || null,
         raw.gender ?? "", raw.guardian_name ?? "", raw._phone ?? "",
         raw.guardian_email ?? "", raw.address ?? "", committedBy],
      );
      const studentId = studentResult.rows[0].id;

      let streamId: string | null = null;
      if (klass.requires_stream) {
        const key = (raw.stream ?? "").trim().toLowerCase();
        if (key) {
          streamId = streamsByLowerName.get(key)?.id ??
            [...streamsByLowerName.entries()].find(([k]) => k.includes(key))?.[1]?.id ?? null;
        }
      }

      const rollNo = /^\d+$/.test(raw.roll_no ?? "") ? parseInt(raw.roll_no, 10) : null;

      await client.query(
        `INSERT INTO enrollments
           (school_id, student_id, academic_year_id, class_level_id, section_id, stream_id,
            roll_no, admission_type, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'carry_over', $8)`,
        // Imported students were already at the school; they are not new
        // admissions and must not be charged an admission fee.
        [batch.school_id, studentId, batch.academic_year_id, klass.id, sectionId, streamId,
         rollNo, committedBy],
      );

      await client.query(`UPDATE import_rows SET student_id = $1 WHERE id = $2`, [studentId, row.id]);
      created++;
    }

    await client.query(
      `UPDATE import_batches SET status = 'committed', committed_at = now() WHERE id = $1`,
      [batchId],
    );

    await client.query("COMMIT");
    return { created, skipped: bad.length };
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
    "DOB", "Gender", "Guardian Name", "Phone", "Email",
    "Address", "Stream", "Bus Stop"];
  const example = ["2026/0001", "Ananya Krishnamurthy", "VIII", "A", "1",
    "14/03/2012", "F", "R. Krishnamurthy", "9845012345",
    "parent@example.com", "12 MG Road, Bengaluru", "", "Jayanagar 4th Block"];
  return Papa.unparse([cols, example]);
}
