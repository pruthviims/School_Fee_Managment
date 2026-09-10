// TC (Transfer Certificate) PDF, drawn client-side with jsPDF +
// jspdf-autotable, following the exact same conventions as receipt.js:
// plain new jsPDF() (A4 portrait, millimetres), every table given
// explicit column widths that sum to the content width, no decorative
// outer border competing with the table for space.
//
// Built entirely from the TC request's own document-data snapshot
// (server/routes/students.ts's /tc-requests/:id/document-data), which
// only serves data once a request has actually reached 'issued' — so
// this can't accidentally be called for a request still pending
// clearance.

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { displayDate } from "./lib";

const LEFT = 14;
const RIGHT = 196; // A4 is 210mm wide; same left/right margin as receipt.js
const WIDTH = RIGHT - LEFT;

export function buildTcPdf(tc) {
  const doc = new jsPDF(); // defaults: A4, portrait, millimetres

  doc.setTextColor(20, 20, 20);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(tc.school_name || "School", LEFT, 18);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 105);
  const addrLines = doc.splitTextToSize(tc.school_address || "", 110);
  doc.text(addrLines, LEFT, 24);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(20, 20, 20);
  doc.text("TRANSFER CERTIFICATE", RIGHT, 16, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.text(`No. ${tc.tc_number}`, RIGHT, 22, { align: "right" });
  doc.text(`Date of issue: ${displayDate(tc.issued_on)}`, RIGHT, 28, { align: "right" });

  doc.setDrawColor(30, 30, 35);
  doc.setLineWidth(0.6);
  doc.line(LEFT, 33, RIGHT, 33);

  // Student identity — same bordered-grid language as receipt.js's own
  // student block, so a school issuing both document types gets a
  // consistent look rather than two different table styles.
  autoTable(doc, {
    startY: 39,
    margin: { left: LEFT, right: 210 - RIGHT },
    theme: "grid",
    styles: { fontSize: 9, cellPadding: 2.3, lineColor: [225, 225, 230], lineWidth: 0.2,
      textColor: [20, 20, 20] },
    body: [
      ["Student Name", tc.full_name, "Admission No.", tc.admission_no],
      ["Guardian Name", tc.guardian_name || "—", "Date of Birth",
        tc.date_of_birth ? displayDate(tc.date_of_birth) : "—"],
      ["Class Studied", tc.class_name, "Academic Year", tc.academic_year_name],
    ],
    columnStyles: {
      0: { fontStyle: "bold", cellWidth: 34, textColor: [100, 100, 105] },
      1: { cellWidth: 57 },
      2: { fontStyle: "bold", cellWidth: 34, textColor: [100, 100, 105] },
      3: { cellWidth: 57 },
    },
  });

  // Departure details — the substance of the certificate: why, when,
  // conduct, and the finance clearance that gated this document from
  // ever being issuable in the first place.
  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 6,
    margin: { left: LEFT, right: 210 - RIGHT },
    theme: "grid",
    styles: { fontSize: 9, cellPadding: 2.5, lineColor: [225, 225, 230], lineWidth: 0.2,
      textColor: [20, 20, 20] },
    body: [
      ["Date of Leaving", displayDate(tc.last_day)],
      ["Reason for Leaving", tc.reason || "—"],
      ["Conduct", tc.conduct || "—"],
      ["Qualified for Promotion", tc.qualified_for_promotion === true ? "Yes"
        : tc.qualified_for_promotion === false ? "No" : "—"],
      ["Fee Dues", tc.clearance_note || "Cleared"],
      ...(tc.remarks ? [["Remarks", tc.remarks]] : []),
    ],
    columnStyles: {
      0: { fontStyle: "bold", cellWidth: 55, textColor: [100, 100, 105] },
      1: { cellWidth: WIDTH - 55 },
    },
  });

  let y = doc.lastAutoTable.finalY + 14;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(110, 110, 115);
  doc.text("This is a computer-generated Transfer Certificate.", LEFT, y);

  doc.setDrawColor(60, 60, 70);
  doc.setLineWidth(0.3);
  doc.line(RIGHT - 55, y - 2, RIGHT, y - 2);
  doc.setFontSize(8);
  doc.setTextColor(90, 90, 95);
  doc.text("Principal / Head of Institution", RIGHT, y + 3, { align: "right" });

  return doc;
}

export function downloadTcCertificate(tc) {
  const doc = buildTcPdf(tc);
  doc.save(`${String(tc.tc_number).replace(/\//g, "-")}.pdf`);
}
