// Refund receipt PDF — deliberately its own file rather than folded
// into receipt.js, following the same reasoning the spec itself gave:
// a refund receipt must never be mistaken for a fee receipt. Same
// jsPDF + jspdf-autotable conventions as receipt.js and tc.js: plain
// new jsPDF() (A4 portrait, millimetres), explicit column widths
// summing to the content width, no decorative outer border.
//
// Built entirely from GET /students/refunds/:id/receipt-data's own
// snapshot — school, student, class/section/year, and the refund
// itself — matching how receipt.js is built from the payment's own
// document-data rather than live app state.

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { displayDate, inrPlain } from "./lib";

const LEFT = 14;
const RIGHT = 196; // A4 is 210mm wide; same left/right margin as receipt.js
const WIDTH = RIGHT - LEFT;

function modeLabel(mode) {
  return { cash: "Cash", upi: "UPI", card: "Card", netbanking: "Net banking",
    neft: "NEFT", cheque: "Cheque", dd: "Demand Draft" }[mode] || mode;
}

export function buildRefundReceiptPdf(refund) {
  const doc = new jsPDF(); // defaults: A4, portrait, millimetres

  doc.setTextColor(20, 20, 20);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(refund.school_name || "School", LEFT, 18);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 105);
  const addrLines = doc.splitTextToSize(refund.school_address || "", 110);
  doc.text(addrLines, LEFT, 24);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(20, 20, 20);
  doc.text("REFUND RECEIPT", RIGHT, 16, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.text(`No. ${refund.receipt_no || "—"}`, RIGHT, 22, { align: "right" });
  doc.text(`Date: ${displayDate(refund.created_at)}`, RIGHT, 28, { align: "right" });

  doc.setDrawColor(30, 30, 35);
  doc.setLineWidth(0.6);
  doc.line(LEFT, 33, RIGHT, 33);

  // Student identity — same bordered-grid language as receipt.js and
  // tc.js, so a school issuing all three document types gets one
  // consistent look.
  autoTable(doc, {
    startY: 39,
    margin: { left: LEFT, right: 210 - RIGHT },
    theme: "grid",
    styles: { fontSize: 9, cellPadding: 2.3, lineColor: [225, 225, 230], lineWidth: 0.2,
      textColor: [20, 20, 20] },
    body: [
      ["Student", refund.student_name, "Admission No.", refund.admission_no],
      ["Class", `${refund.class_name}-${refund.section_name}`, "Academic Year", refund.year_name],
    ],
    columnStyles: {
      0: { fontStyle: "bold", cellWidth: 30, textColor: [100, 100, 105] },
      1: { cellWidth: 61 },
      2: { fontStyle: "bold", cellWidth: 30, textColor: [100, 100, 105] },
      3: { cellWidth: 61 },
    },
  });

  // The refund itself — amount, mode, reference, reason, and the three
  // people involved on the school's side plus who actually received
  // the money. approver_name and received_by are plain text fields (an
  // approver or a parent isn't necessarily a portal user), refunded_by
  // is the actual logged-in account that processed it.
  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 6,
    margin: { left: LEFT, right: 210 - RIGHT },
    theme: "grid",
    styles: { fontSize: 9, cellPadding: 2.5, lineColor: [225, 225, 230], lineWidth: 0.2,
      textColor: [20, 20, 20] },
    body: [
      ["Refund Amount", inrPlain(refund.amount)],
      ["Mode", modeLabel(refund.mode) + (refund.instrument_ref ? ` — ref. ${refund.instrument_ref}` : "")],
      ["Reason", refund.reason || "—"],
      ["Approved By", refund.approver_name || "—"],
      ["Processed By", refund.refunded_by_name || "—"],
      ["Received By", refund.received_by || "—"],
    ],
    columnStyles: {
      0: { fontStyle: "bold", cellWidth: 45, textColor: [100, 100, 105] },
      1: { cellWidth: WIDTH - 45 },
    },
  });

  let y = doc.lastAutoTable.finalY + 14;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(110, 110, 115);
  doc.text("This is a computer-generated refund receipt.", LEFT, y);

  doc.setDrawColor(60, 60, 70);
  doc.setLineWidth(0.3);
  doc.line(RIGHT - 55, y - 2, RIGHT, y - 2);
  doc.setFontSize(8);
  doc.setTextColor(90, 90, 95);
  doc.text("Authorised signatory", RIGHT, y + 3, { align: "right" });

  return doc;
}

export function downloadRefundReceipt(refund) {
  const doc = buildRefundReceiptPdf(refund);
  const name = String(refund.receipt_no || "refund-receipt").replace(/\//g, "-");
  doc.save(`${name}.pdf`);
}
