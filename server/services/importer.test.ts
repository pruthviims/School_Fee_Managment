import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../db/index.js";
import {
  ImportServiceError, commitImport, normaliseClass, normalisePhone, parseDate,
  readRows, stageImport, suggestColumnMap, templateCsv,
} from "./importer.js";
import { createSchool, resetDb } from "../tests/helpers.js";
import { createAcademicYear, createClassLevel, resetFeeDomain } from "../tests/fixtures.js";

let school: any;
let year: any;

beforeEach(async () => {
  await resetFeeDomain();
  await resetDb();
  school = await createSchool({ short_code: "import-test" });
  year = await createAcademicYear(school.id);
  await createClassLevel(school.id, { name: "VIII", ladder_order: 8 });
  await createClassLevel(school.id, { name: "1st PU", ladder_order: 11, stage: "puc", requires_stream: true });
});

afterAll(async () => {
  await pool.end();
});

describe("normaliseClass", () => {
  it.each([
    ["VIII", "VIII"], ["8", "VIII"], ["8th", "VIII"], ["Class 8", "VIII"], ["STD VIII", "VIII"],
    ["viii", "VIII"], ["Standard 8", "VIII"],
    ["1st PU", "1st PU"], ["I PUC", "1st PU"], ["11", "1st PU"], ["11th", "1st PU"], ["XI", "1st PU"],
    ["2nd PU", "2nd PU"], ["II PUC", "2nd PU"], ["12th", "2nd PU"],
    ["LKG", "LKG"], ["Jr KG", "LKG"], ["UKG", "UKG"], ["Sr KG", "UKG"],
    ["Pre-LKG", "Pre-LKG"], ["Nursery", "Pre-LKG"],
    ["", ""], ["Grade 15", ""], ["banana", ""],
  ])("normalises %s to %s", (input, expected) => {
    expect(normaliseClass(input)).toBe(expected);
  });
});

describe("normalisePhone", () => {
  it("strips a +91 country code", () => {
    expect(normalisePhone("+91 98450 12345")).toBe("9845012345");
  });
  it("strips a leading 0 (STD-style dialing prefix)", () => {
    expect(normalisePhone("09845012345")).toBe("9845012345");
  });
  it("leaves a plain 10-digit number alone", () => {
    expect(normalisePhone("9845012345")).toBe("9845012345");
  });
  it("strips non-digit punctuation", () => {
    expect(normalisePhone("98450-12345")).toBe("9845012345");
  });
});

describe("parseDate", () => {
  it("reads an ambiguous d/m/y date as day-first", () => {
    expect(parseDate("03/04/2015")).toBe("2015-04-03"); // 3 April, not March 4
  });
  it("falls back to month-first only when day-first is impossible", () => {
    expect(parseDate("13/25/2015")).toBeNull(); // neither reading is valid
    expect(parseDate("03/25/2015")).toBe("2015-03-25"); // day-first fails (month=25 invalid) -> month-first
  });
  it("reads an unambiguous dash-separated date", () => {
    expect(parseDate("14-03-2012")).toBe("2012-03-14");
  });
  it("reads ISO format", () => {
    expect(parseDate("2012-03-14")).toBe("2012-03-14");
  });
  it("reads a dot-separated date", () => {
    expect(parseDate("14.03.2012")).toBe("2012-03-14");
  });
  it("reads a 2-digit year and shifts it back a century only when the literal reading would be in the future", () => {
    // 2000+12 = 2012, already in the past — no shift needed.
    expect(parseDate("14/03/12")).toBe("2012-03-14");
    // 2000+30 = 2030 is in the future for a birth date — shifts to 1930.
    expect(parseDate("14/03/30")).toBe("1930-03-14");
  });
  it("reads a month-name date", () => {
    expect(parseDate("14-Mar-2012")).toBe("2012-03-14");
    expect(parseDate("14 Mar 2012")).toBe("2012-03-14");
  });
  it("returns null for garbage or an impossible date", () => {
    expect(parseDate("not a date")).toBeNull();
    expect(parseDate("31/02/2012")).toBeNull(); // no such day
    expect(parseDate("")).toBeNull();
  });
});

describe("suggestColumnMap", () => {
  it("matches common header spelling variants", () => {
    const headers = ["Adm No", "Student Name", "Std", "Sec", "Father's Name", "Mobile No"];
    const map = suggestColumnMap(headers);
    expect(map.admission_no).toBe(0);
    expect(map.full_name).toBe(1);
    expect(map.class_name).toBe(2);
    expect(map.section).toBe(3);
    // "Father's Name" now claims the dedicated father_name field, not
    // the older, more generic guardian_name — a sheet that only has
    // one undifferentiated parent/guardian column (no "Father"/
    // "Mother" split) still maps to guardian_name correctly, covered
    // separately below.
    expect(map.father_name).toBe(4);
    expect(map.guardian_phone).toBe(5);
  });

  it("still maps a generic, undifferentiated parent/guardian column when there's no father/mother split", () => {
    const headers = ["Adm No", "Student Name", "Std", "Sec", "Parent Name", "Mobile No"];
    const map = suggestColumnMap(headers);
    expect(map.guardian_name).toBe(4);
    expect(map.father_name).toBeUndefined();
  });

  it("never maps the same column to two fields", () => {
    const headers = ["Name", "Class"];
    const map = suggestColumnMap(headers);
    const used = Object.values(map);
    expect(new Set(used).size).toBe(used.length);
  });
});

describe("readRows", () => {
  it("skips a title row above the real header", () => {
    const csv = "My School — 2026-27 Roll\nAdm No,Name,Class\n2026/1,Test,VIII\n";
    const { headers, body } = readRows(csv);
    expect(headers).toEqual(["Adm No", "Name", "Class"]);
    expect(body).toEqual([["2026/1", "Test", "VIII"]]);
  });

  it("throws on a file with no readable rows", () => {
    expect(() => readRows("\n\n \n")).toThrow(ImportServiceError);
  });
});

describe("templateCsv", () => {
  it("produces a header row and one example row", () => {
    const csv = templateCsv();
    const { headers, body } = readRows(csv);
    expect(headers[0]).toBe("Admission No");
    expect(body).toHaveLength(1);
  });
});

describe("stageImport", () => {
  it("flags a duplicate admission number within the same file", async () => {
    const csv = "Adm No,Name,Class\n2026/1,Test One,VIII\n2026/1,Test Two,VIII\n";
    const batch = await stageImport({
      schoolId: school.id, academicYearId: year.id, filename: "roll.csv", content: csv,
    }) as any;
    expect(batch.valid_rows).toBe(1); // first row valid, second flagged as duplicate

    const rows = await pool.query(`SELECT * FROM import_rows WHERE batch_id = $1 ORDER BY line_no`,
      [batch.id]);
    expect(rows.rows[1].errors[0]).toContain("appears twice");
  });

  it("flags a class that isn't set up for this school", async () => {
    const csv = "Adm No,Name,Class\n2026/1,Test,XV\n";
    const batch = await stageImport({
      schoolId: school.id, academicYearId: year.id, filename: "roll.csv", content: csv,
    }) as any;
    expect(batch.valid_rows).toBe(0);
  });

  it("flags an admission number already in the system", async () => {
    await pool.query(
      `INSERT INTO students (school_id, admission_no, full_name) VALUES ($1, '2025/1', 'Existing')`,
      [school.id],
    );
    const csv = "Adm No,Name,Class\n2025/1,Test,VIII\n";
    const batch = await stageImport({
      schoolId: school.id, academicYearId: year.id, filename: "roll.csv", content: csv,
    }) as any;
    expect(batch.valid_rows).toBe(0);
  });

  it("warns but doesn't error on an unparseable date or short phone", async () => {
    const csv = "Adm No,Name,Class,DOB,Phone\n2026/1,Test,VIII,not-a-date,12345\n";
    const batch = await stageImport({
      schoolId: school.id, academicYearId: year.id, filename: "roll.csv", content: csv,
    }) as any;
    expect(batch.valid_rows).toBe(1); // still valid — these are warnings, not errors

    const rows = await pool.query(`SELECT * FROM import_rows WHERE batch_id = $1`, [batch.id]);
    expect(rows.rows[0].warnings.some((w: string) => w.includes("Could not read the date"))).toBe(true);
  });

  it("refuses to stage when required columns can't be found", async () => {
    const csv = "Foo,Bar\n1,2\n";
    await expect(stageImport({
      schoolId: school.id, academicYearId: year.id, filename: "roll.csv", content: csv,
    })).rejects.toThrow(ImportServiceError);
  });
});

describe("commitImport", () => {
  it("creates students and enrollments from valid rows, skipping invalid ones", async () => {
    const csv = "Adm No,Name,Class,Section\n" +
      "2026/1,Good Student,VIII,A\n" +
      "2026/1,Duplicate Adm,VIII,A\n"; // second row will be flagged as a dup within-file
    const batch = await stageImport({
      schoolId: school.id, academicYearId: year.id, filename: "roll.csv", content: csv,
    }) as any;

    const result = await commitImport(batch.id);
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);

    const student = await pool.query(`SELECT * FROM students WHERE admission_no = '2026/1'`);
    expect(student.rows).toHaveLength(1);
    expect(student.rows[0].full_name).toBe("Good Student");
  });

  it("marks imported students as carry_over, never charged an admission fee", async () => {
    const csv = "Adm No,Name,Class\n2026/1,Test,VIII\n";
    const batch = await stageImport({
      schoolId: school.id, academicYearId: year.id, filename: "roll.csv", content: csv,
    }) as any;
    await commitImport(batch.id);

    const enrollment = await pool.query(
      `SELECT admission_type FROM enrollments e
       JOIN students s ON s.id = e.student_id WHERE s.admission_no = '2026/1'`,
    );
    expect(enrollment.rows[0].admission_type).toBe("carry_over");
  });

  it("creates the section if it doesn't already exist", async () => {
    const csv = "Adm No,Name,Class,Section\n2026/1,Test,VIII,Z\n";
    const batch = await stageImport({
      schoolId: school.id, academicYearId: year.id, filename: "roll.csv", content: csv,
    }) as any;
    await commitImport(batch.id);

    const section = await pool.query(
      `SELECT * FROM sections WHERE academic_year_id = $1 AND name = 'Z'`, [year.id],
    );
    expect(section.rows).toHaveLength(1);
  });

  it("matches a stream by fuzzy name for a class that requires one", async () => {
    // The fuzzy match looks for the (short) CSV text as a substring of the
    // (fuller) canonical stream name — not the other way around — so the
    // stream name here needs to be the longer string.
    await pool.query(`INSERT INTO streams (school_id, name) VALUES ($1, 'Science PCMB')`, [school.id]);
    const csv = "Adm No,Name,Class,Stream\n2026/1,Test,1st PU,PCMB\n";
    const batch = await stageImport({
      schoolId: school.id, academicYearId: year.id, filename: "roll.csv", content: csv,
    }) as any;
    await commitImport(batch.id);

    const enrollment = await pool.query(
      `SELECT st.name AS stream_name FROM enrollments e
       JOIN streams st ON st.id = e.stream_id
       JOIN students s ON s.id = e.student_id WHERE s.admission_no = '2026/1'`,
    );
    expect(enrollment.rows[0].stream_name).toBe("Science PCMB");
  });

  it("matches a stream by an exact (case-insensitive) name too", async () => {
    await pool.query(`INSERT INTO streams (school_id, name) VALUES ($1, 'Commerce')`, [school.id]);
    const csv = "Adm No,Name,Class,Stream\n2026/1,Test,1st PU,commerce\n";
    const batch = await stageImport({
      schoolId: school.id, academicYearId: year.id, filename: "roll.csv", content: csv,
    }) as any;
    await commitImport(batch.id);

    const enrollment = await pool.query(
      `SELECT st.name AS stream_name FROM enrollments e
       JOIN streams st ON st.id = e.stream_id
       JOIN students s ON s.id = e.student_id WHERE s.admission_no = '2026/1'`,
    );
    expect(enrollment.rows[0].stream_name).toBe("Commerce");
  });

  it("refuses to commit an already-committed batch a second time", async () => {
    const csv = "Adm No,Name,Class\n2026/1,Test,VIII\n";
    const batch = await stageImport({
      schoolId: school.id, academicYearId: year.id, filename: "roll.csv", content: csv,
    }) as any;
    await commitImport(batch.id);
    await expect(commitImport(batch.id)).rejects.toThrow(ImportServiceError);
  });

  it("refuses to commit with errors present when skipInvalid is false", async () => {
    const csv = "Adm No,Name,Class\n,Test,VIII\n"; // blank admission number
    const batch = await stageImport({
      schoolId: school.id, academicYearId: year.id, filename: "roll.csv", content: csv,
    }) as any;
    await expect(commitImport(batch.id, { skipInvalid: false })).rejects.toThrow(ImportServiceError);
  });
});
