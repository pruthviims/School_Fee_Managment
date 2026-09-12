// NOC / Management Clearance PDF — the document this application
// actually issues when a student's exit is approved; the official
// Transfer Certificate remains a separate, manual process through the
// government portal, per the business requirement this exists to
// support. Same jsPDF + jspdf-autotable conventions as tc.js and
// receipt.js: plain new jsPDF() (A4 portrait, millimetres), explicit
// column widths summing to the content width, no decorative outer
// border competing with the table for space.
//
// Built entirely from GET /students/tc-requests/:id/noc-document-data's
// own snapshot, including the financial_snapshot captured at the exact
// moment of approval — never recomputed live, since a refund recorded
// afterward could otherwise make this document disagree with itself.

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { displayDate, inrPlain } from "./lib";

const LEFT = 14;
const RIGHT = 196; // A4 is 210mm wide; same left/right margin as receipt.js and tc.js
const WIDTH = RIGHT - LEFT;

const EXIT_REASON_LABEL = {
  tc: "TC", admission_cancelled: "Admission Cancelled", dropout: "Dropout",
  transferred: "Transferred to Another School", other: "Other",
};

export function buildNocPdf(noc) {
  const doc = new jsPDF(); // defaults: A4, portrait, millimetres
  const snapshot = noc.financial_snapshot || {};
  const outstanding = snapshot.outstanding || 0;
  // The distinction the business requirement is built around: this is
  // explicitly NOT a TC, and must not be titled or read like one — and
  // it must not claim "No Dues" when money is actually still owed.
  const title = outstanding > 0 ? "NOC / MANAGEMENT CLEARANCE" : "NO DUES / CLEARANCE CERTIFICATE";

  doc.setTextColor(20, 20, 20);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(noc.school_name || "School", LEFT, 18);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 105);
  const addrLines = doc.splitTextToSize(noc.school_address || "", 110);
  doc.text(addrLines, LEFT, 24);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12.5);
  doc.setTextColor(20, 20, 20);
  doc.text(title, RIGHT, 16, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.text(`No. ${noc.noc_number || "—"}`, RIGHT, 22, { align: "right" });
  doc.text(`Date: ${displayDate(noc.cleared_on)}`, RIGHT, 28, { align: "right" });

  doc.setDrawColor(30, 30, 35);
  doc.setLineWidth(0.6);
  doc.line(LEFT, 33, RIGHT, 33);

  // Student identity — same bordered-grid language as tc.js and
  // receipt.js, so a school issuing any of the three document types
  // gets one consistent look.
  autoTable(doc, {
    startY: 39,
    margin: { left: LEFT, right: 210 - RIGHT },
    theme: "grid",
    styles: { fontSize: 9, cellPadding: 2.3, lineColor: [225, 225, 230], lineWidth: 0.2,
      textColor: [20, 20, 20] },
    body: [
      ["Student Name", noc.full_name, "Admission No.", noc.admission_no],
      ["Class", `${noc.class_name}-${noc.section_name}`, "Academic Year", noc.academic_year_name],
    ],
    columnStyles: {
      0: { fontStyle: "bold", cellWidth: 34, textColor: [100, 100, 105] },
      1: { cellWidth: 57 },
      2: { fontStyle: "bold", cellWidth: 34, textColor: [100, 100, 105] },
      3: { cellWidth: 57 },
    },
  });

  // Exit details — reason, date, and management's own remarks, in the
  // school's actual wording rather than a generic sentence.
  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 6,
    margin: { left: LEFT, right: 210 - RIGHT },
    theme: "grid",
    styles: { fontSize: 9, cellPadding: 2.5, lineColor: [225, 225, 230], lineWidth: 0.2,
      textColor: [20, 20, 20] },
    body: [
      ["Exit Reason", EXIT_REASON_LABEL[noc.exit_reason] || noc.exit_reason || "—"],
      ["Date of Exit", displayDate(noc.last_day)],
      ["Management Remarks", noc.clearance_note || "—"],
    ],
    columnStyles: {
      0: { fontStyle: "bold", cellWidth: 45, textColor: [100, 100, 105] },
      1: { cellWidth: WIDTH - 45 },
    },
  });

  // Financial position at the moment of approval — never hidden, never
  // recomputed live. Outstanding is shown plainly even when it's the
  // whole reason this isn't a "No Dues" certificate.
  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 6,
    margin: { left: LEFT, right: 210 - RIGHT },
    theme: "grid",
    head: [["Financial Position", ""]],
    body: [
      ["Total Fees", inrPlain(snapshot.charged || 0)],
      ["Total Paid", inrPlain(snapshot.grossPaid || 0)],
      ["Total Refunds", inrPlain(snapshot.refunded || 0)],
      ["Net Paid", inrPlain(snapshot.netPaid || 0)],
      ["Outstanding", outstanding > 0 ? inrPlain(outstanding) : "₹0 — Paid in full"],
    ],
    styles: { fontSize: 9, cellPadding: 2.5, lineColor: [225, 225, 230], lineWidth: 0.2 },
    headStyles: { fillColor: [245, 245, 248], textColor: [30, 30, 30], fontStyle: "bold", fontSize: 8.5 },
    columnStyles: {
      0: { fontStyle: "bold", cellWidth: 45, textColor: [100, 100, 105] },
      1: { cellWidth: WIDTH - 45 },
    },
    didParseCell: (data) => {
      if (data.row.index === 4 && data.column.index === 1) {
        data.cell.styles.fontStyle = "bold";
        data.cell.styles.textColor = outstanding > 0 ? [180, 60, 50] : [20, 120, 85];
      }
    },
  });

  // Refund details — only shown at all if a refund actually happened,
  // rather than a "Refund Amount: ₹0" line cluttering the common case.
  if ((noc.refunds || []).length > 0) {
    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 6,
      margin: { left: LEFT, right: 210 - RIGHT },
      theme: "grid",
      head: [["Refund Details", "Date", "Amount"]],
      body: noc.refunds.map((r) => [
        `${r.receipt_no || "—"}${r.reason ? ` — ${r.reason}` : ""}`,
        displayDate(r.created_at), inrPlain(r.amount),
      ]),
      styles: { fontSize: 8.5, cellPadding: 2.4, lineColor: [225, 225, 230], lineWidth: 0.2,
        textColor: [70, 70, 75] },
      headStyles: { fillColor: [245, 245, 248], textColor: [30, 30, 30], fontStyle: "bold", fontSize: 7.5 },
      columnStyles: {
        0: { cellWidth: 100 },
        1: { cellWidth: 42 },
        2: { cellWidth: 40, halign: "right" },
      },
    });
  }

  // Audit trail — who requested, who approved, and when, per the
  // business requirement that this be answerable later.
  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 6,
    margin: { left: LEFT, right: 210 - RIGHT },
    theme: "grid",
    styles: { fontSize: 8.5, cellPadding: 2.3, lineColor: [225, 225, 230], lineWidth: 0.2,
      textColor: [70, 70, 75] },
    body: [
      ["Requested By", noc.requested_by_name || "—", "Requested On", displayDate(noc.requested_on)],
      ["Approved By", noc.cleared_by_name || "—", "Approved On", displayDate(noc.cleared_on)],
    ],
    columnStyles: {
      0: { fontStyle: "bold", cellWidth: 34, textColor: [100, 100, 105] },
      1: { cellWidth: 57 },
      2: { fontStyle: "bold", cellWidth: 34, textColor: [100, 100, 105] },
      3: { cellWidth: 57 },
    },
  });

  let y = doc.lastAutoTable.finalY + 14;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(110, 110, 115);
  doc.text(
    "This NOC confirms management's approval to proceed with exit / TC processing. It is not a Transfer Certificate.",
    LEFT, y);

  doc.setDrawColor(60, 60, 70);
  doc.setLineWidth(0.3);
  doc.line(RIGHT - 55, y + 4, RIGHT, y + 4);
  doc.setFontSize(8);
  doc.setTextColor(90, 90, 95);
  doc.text("Principal / Head of Institution", RIGHT, y + 9, { align: "right" });

  return doc;
}

export function downloadNoc(noc) {
  const doc = buildNocPdf(noc);
  doc.save(`${String(noc.noc_number || "noc").replace(/\//g, "-")}.pdf`);
}
