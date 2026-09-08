import React, { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "./api";
import {
  AlertTriangle,
  ArrowRight,
  Bus,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileSpreadsheet,
  GraduationCap,
  History,
  Image as ImageIcon,
  IndianRupee,
  Mail,
  Percent,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  UserPlus,
  Users,
  Wallet,
  X,
} from "lucide-react";
import {
  ACADEMIC_YEARS,
  CLASSES,
  CONCESSION_REASONS,
  IMPORT_FIELDS,
  PAYMENT_MODES,
  SAMPLE_MESSY_CSV,
  STAGE_LABELS,
  TEMPLATE_CSV,
  TERMS,
  TRANSPORT_ID,
  allStops,
  amountInWords,
  computeFee,
  displayDate,
  fareRange,
  inYear,
  inr,
  isTerminalClass,
  needsOptIn,
  nextAdmissionNo,
  nextClassName,
  nextReceiptNo,
  oneTimeTotal,
  paidByStudent,
  parseCSV,
  recurringTotal,
  splitHeader,
  suggestColumnMap,
  validateRows,
} from "./lib";
import { downloadReceipt } from "./receipt";

/* ---------------- shared bits ---------------- */

export const panel = "bg-white rounded-2xl border border-slate-100 shadow-[0_1px_3px_rgba(15,23,41,0.04)]";
const eyebrow = "eyebrow text-slate-400";
const field =
  "w-full bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm font-medium outline-none focus:border-brand-500 transition";
const cellInput =
  "w-full bg-transparent border border-transparent hover:border-slate-200 focus:border-brand-500 focus:bg-white rounded-lg px-2 py-1.5 text-sm font-medium outline-none transition";
const primary =
  "bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-bold rounded-xl px-5 py-2.5 flex items-center gap-2 shadow-[0_8px_20px_-8px_rgba(91,61,245,0.8)] transition";
const ghost =
  "bg-white border border-slate-200 hover:border-brand-500 hover:text-brand-600 text-slate-600 text-sm font-semibold rounded-xl px-4 py-2.5 flex items-center gap-2 transition";
const th = "text-left eyebrow text-slate-400 px-5 py-3 border-b border-slate-100";

export function PageHead({ title, subtitle, children }) {
  return (
    <div className="flex flex-wrap justify-between items-start gap-4 mb-6">
      <div>
        <h1 className="text-[30px] font-extrabold tracking-tight leading-tight">{title}</h1>
        <p className="text-slate-500 mt-1 max-w-2xl">{subtitle}</p>
      </div>
      <div className="flex flex-wrap gap-2.5">{children}</div>
    </div>
  );
}

export function StatCard({ icon: Icon, tint, label, value, note, noteTint }) {
  return (
    <div className={`${panel} p-6`}>
      <div className="flex items-center gap-3 mb-4">
        <div className={`w-11 h-11 rounded-xl grid place-items-center ${tint}`}>
          <Icon size={19} />
        </div>
        <span className="eyebrow text-slate-400">{label}</span>
      </div>
      <p className="text-[34px] font-extrabold tracking-tight leading-none tabular-nums">{value}</p>
      <p className={`eyebrow mt-2 ${noteTint || "text-slate-400"}`}>{note}</p>
    </div>
  );
}

function uid() {
  return `id${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * A select styled to read as a filter, not a form field: tinted background
 * and border, custom chevron (the native one is too faint against the
 * panel background to notice at a glance), and an "active" state so a
 * filter that's actually narrowing the list looks different from one left
 * at its default "All ..." value.
 */
export function FilterSelect({ value, onChange, disabled, active, className = "", children }) {
  return (
    <div className={`relative ${className}`}>
      <select value={value} onChange={onChange} disabled={disabled}
        className={`appearance-none w-full pl-3.5 pr-9 py-2.5 rounded-xl text-sm font-bold outline-none border-2 transition ${
          disabled
            ? "bg-slate-50 border-slate-100 text-slate-300 cursor-not-allowed"
            : active
              ? "bg-brand-50 border-brand-400 text-brand-700"
              : "bg-white border-slate-200 text-slate-600 hover:border-brand-300"
        }`}>
        {children}
      </select>
      <ChevronDown size={16}
        className={`pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 ${
          disabled ? "text-slate-300" : active ? "text-brand-500" : "text-slate-400"}`} />
    </div>
  );
}

/**
 * A student's concession — type toggle, value, reason, and (when the
 * student rides a bus) whether the discount extends to transport too.
 * Used identically in the payment modal and the Fee Collection
 * table; `compact` only changes sizing, never the fields or the update
 * logic, so the two surfaces can't drift out of sync with each other.
 */
// Concession reasons shown in the UI map onto the backend's fixed enum,
// with the fuller label kept as the concession's note — "Single parent"
// and "Financial hardship" both land on the "hardship" enum value, so
// the note is what actually distinguishes them again on redisplay.
const REASON_TO_ENUM = {
  "Sibling discount": "sibling",
  "Staff ward": "staff_ward",
  "RTE quota": "rte",
  "Merit scholarship": "merit",
  "Single parent": "hardship",
  "Financial hardship": "hardship",
  "Other": "other",
};

function reasonLabelForConcession(row) {
  if (row?.note && CONCESSION_REASONS.includes(row.note)) return row.note;
  const fallback = Object.entries(REASON_TO_ENUM).find(([, enumValue]) => enumValue === row?.reason);
  return fallback ? fallback[0] : "";
}

/**
 * A concession is an append-only grant/reversal ledger on the backend,
 * not a single mutable value — see server/routes/students.ts. This
 * editor still presents it as "one concession per student", matching
 * how the office actually thinks about it, but underneath: changing the
 * amount or reason reverses whatever's currently active and grants a
 * new one, rather than editing history in place. Percent-vs-flat and
 * "include transport" are pure client-side entry conveniences — only
 * the resulting rupee amount is ever sent to the backend, and once
 * granted, that amount is frozen (the same property charges already
 * have), so editing later is a real reverse-and-regrant, not a silent
 * recompute against today's fee.
 */
export function ConcessionEditor({ enrollmentId, grossPaise, transportPaise, onChanged, compact = false }) {
  const [active, setActive] = useState(null);
  const [type, setType] = useState("amount");
  const [value, setValue] = useState("");
  const [reasonLabel, setReasonLabel] = useState("");
  const [approverName, setApproverName] = useState("");
  const [includeTransport, setIncludeTransport] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refetch() {
    const list = await api.get(`/students/enrollments/${enrollmentId}/concessions`);
    const current = list.find((c) => !c.reversed_by) || null;
    setActive(current);
    if (current) {
      // Always shown back as a flat amount — that's what's actually
      // stored. Percent is only ever a way of computing a new grant.
      setType("amount");
      setValue(String(Math.round(current.amount / 100)));
      setReasonLabel(reasonLabelForConcession(current));
      setApproverName(current.approver_name || "");
    } else {
      setType("amount"); setValue(""); setReasonLabel(""); setApproverName(""); setIncludeTransport(false);
    }
  }
  useEffect(() => { refetch(); }, [enrollmentId]); // eslint-disable-line

  const appliedPaise = active ? active.amount : 0;

  async function commit(nextValue, nextReasonLabel, nextIncludeTransport, nextType, nextApproverName) {
    const numeric = Math.max(0, +nextValue || 0);
    const base = nextIncludeTransport ? grossPaise : grossPaise - transportPaise;
    const amountPaise = nextType === "percent"
      ? Math.round((base * Math.min(100, numeric)) / 100)
      : Math.min(base, Math.round(numeric * 100));

    setBusy(true);
    try {
      if (active) await api.post(`/students/concessions/${active.id}/reverse`, {});
      if (amountPaise > 0) {
        await api.post(`/students/enrollments/${enrollmentId}/concessions`, {
          amount: amountPaise,
          reason: REASON_TO_ENUM[nextReasonLabel] || "other",
          note: nextReasonLabel,
          approver_name: nextApproverName.trim(),
        });
      }
      await refetch();
      if (onChanged) onChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not update the concession.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={compact ? "" : "px-6 py-5 border-b border-slate-100"}>
      {!compact && (
        <div className="flex items-center justify-between mb-2">
          <label className="eyebrow text-slate-400">Concession</label>
          {appliedPaise > 0 && (
            <span className="text-xs font-bold text-amber-600">−{inr(appliedPaise / 100)} applied</span>
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <button disabled={busy}
          onClick={() => { setType(type === "percent" ? "amount" : "percent"); setValue(""); }}
          className={`shrink-0 rounded-lg border text-slate-500 font-bold hover:border-brand-500 hover:text-brand-600 ${
            compact ? "w-8 h-8 border-slate-200 text-xs" : "w-10 h-10 border-2 border-slate-200 text-sm"}`}
          title="Switch between a percentage and a flat amount">
          {type === "amount" ? "₹" : "%"}
        </button>
        <input inputMode="numeric" value={value} placeholder="0" disabled={busy}
          className={`border rounded-lg text-right tabular-nums outline-none focus:border-brand-500 font-semibold ${
            compact ? "w-20 border-slate-200 px-2.5 py-1.5 text-sm" : "w-24 border-2 border-slate-200 px-3 py-2.5 text-sm font-bold"}`}
          onChange={(e) => {
            let v = Math.max(0, +e.target.value || 0);
            if (type !== "amount") v = Math.min(100, v);
            setValue(v || "");
          }}
          onBlur={(e) => commit(e.target.value, reasonLabel, includeTransport, type, approverName)} />
        <select
          className={`bg-white border rounded-lg outline-none focus:border-brand-500 text-sm font-medium flex-1 min-w-0 ${
            compact ? "border-slate-200 px-2 py-1.5" : "border-2 border-slate-200 px-3 py-2.5"}`}
          value={reasonLabel} disabled={!(+value > 0) || busy}
          onChange={(e) => { setReasonLabel(e.target.value); commit(value, e.target.value, includeTransport, type, approverName); }}>
          <option value="">{compact ? "Reason —" : "Reason (optional)"}</option>
          {CONCESSION_REASONS.map((r) => <option key={r}>{r}</option>)}
        </select>
      </div>
      {+value > 0 && (
        <input value={approverName} placeholder="Approved by (management name)" disabled={busy}
          className={`w-full border rounded-lg outline-none focus:border-brand-500 text-xs font-medium mt-1.5 ${
            compact ? "border-slate-200 px-2 py-1.5" : "border-2 border-slate-200 px-3 py-2"}`}
          onChange={(e) => setApproverName(e.target.value)}
          onBlur={(e) => commit(value, reasonLabel, includeTransport, type, e.target.value)} />
      )}
      {+value > 0 && transportPaise > 0 && (
        <label className="flex items-center gap-1.5 mt-1.5 text-[11px] font-semibold text-slate-400">
          <input type="checkbox" checked={includeTransport} disabled={busy}
            onChange={(e) => {
              setIncludeTransport(e.target.checked);
              commit(value, reasonLabel, e.target.checked, type, approverName);
            }} />
          Also discount transport
        </label>
      )}
    </div>
  );
}

/**
 * Always-available "how much does this one student owe" lookup, meant to
 * live in the sidebar so it works from any screen without navigating to
 * Fee Collection and searching there first. Selecting a result opens the
 * same PaymentModal every other entry point uses, rather than building a
 * second, view-only balance display that would need to be kept in sync.
 */
export function QuickBalanceSearch({ state, onSelect }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = q.length >= 2
    ? state.students
        .filter((s) => inYear(s, state.year))
        .filter((s) => s.name.toLowerCase().includes(q) || s.admissionNo.toLowerCase().includes(q))
        .slice(0, 6)
    : [];

  return (
    <div className="px-5 pt-4 pb-4 border-b border-slate-50 relative">
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Quick balance check…"
          className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-8 pr-7 py-2.5 text-sm font-semibold outline-none focus:border-brand-400 focus:bg-white transition" />
        {query && (
          <button onClick={() => setQuery("")} aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500">
            <X size={14} />
          </button>
        )}
      </div>

      {q.length >= 2 && (
        <div className="absolute left-5 right-5 mt-1.5 bg-white border border-slate-200 rounded-xl shadow-lg z-30 overflow-hidden max-h-72 overflow-y-auto">
          {matches.length === 0 ? (
            <p className="px-3 py-3 text-xs text-slate-400 font-semibold">
              No students match "{query}".
            </p>
          ) : matches.map((s) => {
            const fee = computeFee(s, state);
            const balance = fee.net - paidByStudent(state, s);
            return (
              <button key={s.id}
                onClick={() => { onSelect(s); setQuery(""); }}
                className="w-full flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-slate-50 text-left border-b border-slate-50 last:border-0">
                <span className="min-w-0">
                  <span className="block text-sm font-bold truncate">{s.name}</span>
                  <span className="block eyebrow text-slate-400 truncate">
                    {s.className}{s.section ? `-${s.section}` : ""} · {s.admissionNo}
                  </span>
                </span>
                <span className={`text-sm font-extrabold tabular-nums shrink-0 ${
                  balance > 0 ? "text-red-500" : balance < 0 ? "text-amber-600" : "text-emerald-600"}`}>
                  {balance > 0 ? inr(balance) : balance < 0 ? `+${inr(-balance)}` : "Paid up"}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/* School and admin                                                    */
/* ================================================================== */

export function SchoolScreen({ state, save }) {
  const [form, setForm] = useState({ ...state.school });
  const [saved, setSaved] = useState(false);
  const [logoError, setLogoError] = useState("");
  const [logoBusy, setLogoBusy] = useState(false);
  const fileRef = useRef(null);
  const set = (k) => (e) => { setForm({ ...form, [k]: e.target.value }); setSaved(false); };

  // Its own immediate action, not bundled into "Save changes" below —
  // the logo is real, backend-stored data now (schools.logo_data_url,
  // chosen over object storage for a self-hosted, few-school deployment
  // — see server/routes/school.ts), while the rest of this form is
  // still local-only. Uploading or removing it takes effect right away
  // rather than waiting on a separate save click for a field that isn't
  // even part of the same save path anymore.
  async function uploadLogo(dataUrl) {
    setLogoError("");
    setLogoBusy(true);
    try {
      const result = await api.patch("/school/logo", { logo_data_url: dataUrl });
      setForm((f) => ({ ...f, logo: result.logo_data_url }));
      save({ ...state, school: { ...state.school, logo: result.logo_data_url } });
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : "Could not save that logo.");
    } finally {
      setLogoBusy(false);
    }
  }

  function handleLogoFile(file) {
    setLogoError("");
    if (!file) return;
    if (!file.type.startsWith("image/")) return setLogoError("Choose an image file (PNG, JPG, SVG).");
    if (file.size > 500 * 1024) return setLogoError("Keep the logo under 500KB.");
    const reader = new FileReader();
    reader.onload = () => uploadLogo(String(reader.result));
    reader.onerror = () => setLogoError("Could not read that file.");
    reader.readAsDataURL(file);
  }

  return (
    <div>
      <PageHead title="School Profile"
        subtitle="The details printed on every bill and receipt, and the account that manages them." />

      <div className={`${panel} p-6 grid sm:grid-cols-2 gap-5 max-w-3xl`}>
        <div className="sm:col-span-2">
          <label className={eyebrow}>School logo</label>
          <div className="flex items-center gap-4 mt-2">
            <div className="w-16 h-16 rounded-xl border border-slate-200 bg-slate-50 grid place-items-center overflow-hidden shrink-0">
              {form.logo
                ? <img src={form.logo} alt="School logo" className="w-full h-full object-contain" />
                : <ImageIcon size={22} className="text-slate-300" />}
            </div>
            <div>
              <div className="flex items-center gap-3">
                <button type="button" disabled={logoBusy} onClick={() => fileRef.current?.click()}
                  className={ghost}>
                  <Upload size={14} /> {logoBusy ? "Saving…" : form.logo ? "Change logo" : "Upload logo"}
                </button>
                {form.logo && (
                  <button type="button" disabled={logoBusy}
                    onClick={() => uploadLogo("")}
                    className="text-xs font-semibold text-slate-400 hover:text-red-500 disabled:opacity-50">
                    Remove
                  </button>
                )}
              </div>
              <p className="text-[11px] text-slate-400 mt-1.5 max-w-xs">
                Shown on the login screen once the correct School ID is typed.
                PNG or JPG, under 500KB.
              </p>
              {logoError && <p className="text-xs font-semibold text-red-500 mt-1">{logoError}</p>}
            </div>
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => { handleLogoFile(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
        </div>

        <div className="sm:col-span-2">
          <label className={eyebrow}>School name</label>
          <input className={`${field} mt-2`} value={form.name} onChange={set("name")} />
        </div>
        <div>
          <label className={eyebrow}>School ID</label>
          <input className={`${field} mt-2 bg-slate-50 text-slate-400`} value={form.code} disabled />
        </div>
        <div>
          <label className={eyebrow}>Academic year</label>
          <select className={`${field} mt-2`} value={state.year}
            onChange={(e) => save({ ...state, year: e.target.value })}>
            {ACADEMIC_YEARS.map((y) => <option key={y}>{y}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className={eyebrow}>Address</label>
          <textarea rows={2} className={`${field} mt-2`} value={form.address} onChange={set("address")} />
        </div>
        <div>
          <label className={eyebrow}>Administrator</label>
          <input className={`${field} mt-2`} value={form.adminName} onChange={set("adminName")} />
        </div>
        <div>
          <label className={eyebrow}>Admin mail ID</label>
          <input className={`${field} mt-2`} value={form.adminEmail} onChange={set("adminEmail")} />
        </div>
        <div className="sm:col-span-2 flex items-center gap-3 pt-1">
          <button className={primary}
            onClick={() => { save({ ...state, school: { ...state.school, ...form } }); setSaved(true); }}>
            Save changes
          </button>
          {saved && (
            <span className="text-sm font-semibold text-emerald-600 flex items-center gap-1">
              <Check size={15} /> Saved
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Transport                                                           */
/* ================================================================== */

export function TransportScreen({ state, academicYears }) {
  const [routes, setRoutes] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [stopsByRoute, setStopsByRoute] = useState({}); // routeId -> stops[]
  const [fares, setFares] = useState([]); // every fare for the current year
  const [riders, setRiders] = useState([]); // [{stop_id, riders}]
  const [loading, setLoading] = useState(true);

  const year = academicYears.find((y) => y.name === state.year);

  async function refetchFaresAndRiders(yearId) {
    if (!yearId) { setFares([]); setRiders([]); return; }
    const [f, r] = await Promise.all([
      api.get(`/transport/fares?academic_year_id=${yearId}`),
      api.get(`/transport/riders?academic_year_id=${yearId}`),
    ]);
    setFares(f);
    setRiders(r);
  }

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([
        api.get("/transport/routes").then(setRoutes),
        refetchFaresAndRiders(year?.id),
      ]);
      setLoading(false);
    })();
  }, [year?.id]); // eslint-disable-line

  async function fetchStopsFor(routeId) {
    const stops = await api.get(`/transport/routes/${routeId}/stops`);
    setStopsByRoute((prev) => ({ ...prev, [routeId]: stops }));
  }

  function toggleOpen(routeId) {
    if (openId === routeId) { setOpenId(null); return; }
    setOpenId(routeId);
    if (!stopsByRoute[routeId]) fetchStopsFor(routeId);
  }

  async function addRoute() {
    try {
      const created = await api.post("/transport/routes", {
        code: `R-${String(routes.length + 1).padStart(2, "0")}`, name: "",
      });
      setRoutes((prev) => [...prev, created]);
      setStopsByRoute((prev) => ({ ...prev, [created.id]: [] }));
      setOpenId(created.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not add that route.");
    }
  }

  async function patchRoute(routeId, changes) {
    try {
      const updated = await api.patch(`/transport/routes/${routeId}`, changes);
      setRoutes((prev) => prev.map((r) => (r.id === routeId ? updated : r)));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not update that route.");
    }
  }

  async function removeRoute(routeId) {
    try {
      await api.delete(`/transport/routes/${routeId}`);
      setRoutes((prev) => prev.filter((r) => r.id !== routeId));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not remove that route.");
    }
  }

  async function addStop(routeId) {
    try {
      const stops = stopsByRoute[routeId] || [];
      const created = await api.post(`/transport/routes/${routeId}/stops`, {
        name: "", sequence: stops.length + 1,
      });
      setStopsByRoute((prev) => ({ ...prev, [routeId]: [...(prev[routeId] || []), created] }));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not add that stop.");
    }
  }

  async function patchStop(routeId, stopId, changes) {
    try {
      const updated = await api.patch(`/transport/stops/${stopId}`, changes);
      setStopsByRoute((prev) => ({
        ...prev, [routeId]: prev[routeId].map((s) => (s.id === stopId ? updated : s)),
      }));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not update that stop.");
    }
  }

  async function removeStop(routeId, stopId) {
    try {
      await api.delete(`/transport/stops/${stopId}`);
      setStopsByRoute((prev) => ({ ...prev, [routeId]: prev[routeId].filter((s) => s.id !== stopId) }));
      setFares((prev) => prev.filter((f) => f.stop_id !== stopId));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not remove that stop.");
    }
  }

  // Fares are a separate, year-scoped backend concept now — not a flat
  // property on the stop — since the same stop can (and does) cost a
  // different amount from one academic year to the next. Create-or-
  // update based on whether one already exists for this stop and year.
  async function setFare(stopId, rupees) {
    if (!year) return;
    const amount = Math.max(0, Math.round(rupees || 0)) * 100;
    const existing = fares.find((f) => f.stop_id === stopId);
    try {
      if (existing) {
        const updated = await api.patch(`/transport/fares/${existing.id}`, { amount });
        setFares((prev) => prev.map((f) => (f.id === existing.id ? updated : f)));
      } else if (amount > 0) {
        const created = await api.post("/transport/fares", {
          academic_year_id: year.id, stop_id: stopId, amount,
          due_on: String(year.starts_on).slice(0, 10),
        });
        setFares((prev) => [...prev, created]);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not save that fare.");
    }
  }

  const riderCountFor = (stopId) => riders.find((r) => r.stop_id === stopId)?.riders || 0;
  const fareFor = (stopId) => fares.find((f) => f.stop_id === stopId)?.amount || 0;
  const allFares = fares.map((f) => f.amount).filter(Boolean);
  const totalRiders = riders.reduce((sum, r) => sum + r.riders, 0);

  if (loading) {
    return (
      <div>
        <PageHead title="Bus Routes" subtitle="Loading…" />
        <div className={`${panel} p-16 text-center text-slate-400 font-semibold`}>Loading…</div>
      </div>
    );
  }

  return (
    <div>
      <PageHead title="Bus Routes"
        subtitle="Transport is a fee component, but its amount depends on where the child boards — so it is priced per stop, not per class.">
        <button className={primary} onClick={addRoute}><Plus size={16} /> Add Route</button>
      </PageHead>

      <div className="grid sm:grid-cols-3 gap-5 mb-6">
        <StatCard icon={Bus} tint="bg-brand-50 text-brand-600" label="Routes"
          value={routes.length} note="In service" />
        <StatCard icon={Users} tint="bg-emerald-50 text-emerald-600" label="Riders"
          value={totalRiders} note={`This year (${state.year})`} noteTint="text-emerald-600" />
        <StatCard icon={IndianRupee} tint="bg-amber-50 text-amber-600" label="Fare range"
          value={allFares.length ? `${inr(Math.min(...allFares) / 100)}–${inr(Math.max(...allFares) / 100)}` : "—"}
          note="Yearly, per stop" noteTint="text-amber-600" />
      </div>

      {routes.length === 0 ? (
        <div className={`${panel} border-dashed p-12 text-center`}>
          <Bus className="mx-auto text-slate-300 mb-3" size={30} />
          <p className="font-bold text-slate-700">No routes yet</p>
          <p className="text-sm text-slate-500 mt-1 mb-5">
            Add a route, then list its stops with a yearly fare for each.
          </p>
          <button className={`${primary} mx-auto`} onClick={addRoute}><Plus size={16} /> Add Route</button>
        </div>
      ) : (
        <div className="space-y-3">
          {routes.map((r) => {
            const open = openId === r.id;
            const stops = stopsByRoute[r.id] || [];
            const routeFares = stops.map((s) => fareFor(s.id)).filter(Boolean);
            return (
              <div key={r.id} className={`${panel} overflow-hidden ${open ? "border-brand-200" : ""}`}>
                <button className="w-full flex items-center gap-3 px-5 py-4 hover:bg-slate-50/70 text-left"
                  onClick={() => toggleOpen(r.id)}>
                  {open ? <ChevronDown size={17} className="text-slate-300" />
                        : <ChevronRight size={17} className="text-slate-300" />}
                  <span className="w-10 h-10 rounded-xl bg-brand-50 text-brand-600 grid place-items-center font-bold text-xs tabular-nums">
                    {r.code.replace("R-", "")}
                  </span>
                  <span className="font-bold flex-1">{r.name || "Untitled route"}</span>
                  <span className="text-xs font-semibold text-slate-400">
                    {open ? `${stops.length} ${stops.length === 1 ? "stop" : "stops"}` : ""}
                    {routeFares.length > 0 && ` · ${inr(Math.min(...routeFares) / 100)}–${inr(Math.max(...routeFares) / 100)}`}
                  </span>
                </button>

                {open && (
                  <div className="border-t border-slate-100 p-5">
                    <div className="grid sm:grid-cols-3 gap-4 mb-5">
                      {[["Route code", "code", "R-01"], ["Route name", "name", "Kanakapura Road"],
                        ["Vehicle number", "vehicle_no", "KA 01 AB 1234"], ["Driver", "driver_name", ""],
                        ["Driver phone", "driver_phone", ""], ["Seats", "seats", "40"]].map(([lbl, key, ph]) => (
                        <div key={key}>
                          <label className={eyebrow}>{lbl}</label>
                          <input className={`${field} mt-2`} defaultValue={r[key]} placeholder={ph}
                            key={`${r.id}-${key}-${r[key]}`}
                            onBlur={(e) => {
                              const next = key === "seats" ? +e.target.value || 0 : e.target.value;
                              if (next !== r[key]) patchRoute(r.id, { [key]: next });
                            }} />
                        </div>
                      ))}
                    </div>

                    <div className="rounded-xl border border-slate-100 overflow-hidden">
                      <table className="w-full">
                        <thead className="bg-slate-50/70">
                          <tr>
                            <th className={th} style={{ width: "40%" }}>Stop</th>
                            <th className={th}>Pickup</th>
                            <th className={`${th} text-right`}>Yearly fare</th>
                            <th className={`${th} text-right`}>Riders</th>
                            <th className={th} />
                          </tr>
                        </thead>
                        <tbody>
                          {stops.map((s) => (
                            <tr key={s.id} className="border-b border-slate-50 last:border-0">
                              <td className="px-4 py-1.5">
                                <input className={cellInput} defaultValue={s.name} placeholder="Jayanagar 4th Block"
                                  key={`${s.id}-name-${s.name}`}
                                  onBlur={(e) => { if (e.target.value !== s.name) patchStop(r.id, s.id, { name: e.target.value }); }} />
                              </td>
                              <td className="px-4 py-1.5">
                                <input className={cellInput} defaultValue={s.pickup_time || ""} placeholder="7:20 am"
                                  key={`${s.id}-time-${s.pickup_time}`}
                                  onBlur={(e) => {
                                    const next = e.target.value || null;
                                    if (next !== s.pickup_time) patchStop(r.id, s.id, { pickup_time: next });
                                  }} />
                              </td>
                              <td className="px-4 py-1.5">
                                <input className={`${cellInput} text-right tabular-nums`} inputMode="numeric"
                                  defaultValue={fareFor(s.id) ? fareFor(s.id) / 100 : ""} placeholder="0"
                                  key={`${s.id}-fare-${fareFor(s.id)}`}
                                  onBlur={(e) => setFare(s.id, +e.target.value)} />
                              </td>
                              <td className="px-4 py-1.5 text-right text-sm font-semibold text-slate-400 tabular-nums">
                                {riderCountFor(s.id) || "—"}
                              </td>
                              <td className="px-4 py-1.5 text-right">
                                <button className="text-slate-300 hover:text-red-500"
                                  onClick={() => removeStop(r.id, s.id)} aria-label="Remove stop">
                                  <Trash2 size={15} />
                                </button>
                              </td>
                            </tr>
                          ))}
                          {stops.length === 0 && (
                            <tr><td colSpan={5} className="px-4 py-5 text-sm text-slate-400">No stops yet.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>

                    <div className="flex gap-2 mt-4">
                      <button className={ghost} onClick={() => addStop(r.id)}>
                        <Plus size={15} /> Add stop
                      </button>
                      <button className="text-sm font-semibold text-red-500 hover:bg-red-50 border border-slate-200 hover:border-red-200 rounded-xl px-4 py-2.5 flex items-center gap-2"
                        onClick={() => removeRoute(r.id)}>
                        <Trash2 size={15} /> Delete route
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/* Fee structure                                                       */
/* ================================================================== */

function dueOnForTerm(termNo, year) {
  // year.starts_on may come back as a plain "2026-06-01" or a full ISO
  // timestamp like "2026-06-01T00:00:00.000Z" (pg parses date columns as
  // JS Date objects, which JSON.stringify renders as a full timestamp) —
  // slicing to the date portion first handles either shape correctly.
  const datePart = String(year.starts_on).slice(0, 10);
  const start = new Date(`${datePart}T00:00:00Z`);
  start.setUTCMonth(start.getUTCMonth() + (termNo - 1) * 4);
  return start.toISOString().slice(0, 10);
}

export function FeeScreen({ state, save, classLevels, feeHeads, academicYears, refreshFeeHeads }) {
  // Pre-LKG is always ladder_order 1, so classLevels[0] — sorted by
  // ladder_order from the backend — is always Pre-LKG, matching the
  // requested default.
  const [active, setActive] = useState(classLevels[0]?.name || "");
  const [rawLines, setRawLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copyOpen, setCopyOpen] = useState(false);

  const activeClass = classLevels.find((c) => c.name === active);
  const year = academicYears.find((y) => y.name === state.year);
  const range = fareRange(state.routes);
  // Transport still lives in local state — bus fares aren't wired to the
  // real backend yet (transport_fares has no frontend screen of its own
  // so far), so this one row is deliberately still the old behavior.
  const localRows = state.structure[active] || [];
  const hasTransport = localRows.some((r) => r.id === TRANSPORT_ID);

  async function refetch() {
    if (!activeClass || !year) return;
    setLoading(true);
    try {
      const lines = await api.get(
        `/setup/fee-structure?academic_year_id=${year.id}&class_level_id=${activeClass.id}`);
      setRawLines(lines);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not load the fee structure.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refetch(); }, [active, state.year, classLevels, academicYears]); // eslint-disable-line

  // The same {id, name, terms, oneTime} shape this screen has always
  // rendered — id is the fee_head's id (shared across classes), each
  // term entry carries both the rupee amount for display and the real
  // line's id underneath, so an edit knows whether to PATCH or POST.
  const rows = feeHeads.map((head) => ({
    id: head.id,
    name: head.name,
    oneTime: head.is_one_time,
    terms: [1, 2, 3].map((t) => {
      const line = rawLines.find((l) => l.fee_head_id === head.id && l.term_no === t);
      return { amount: line ? line.amount / 100 : 0, lineId: line?.id ?? null };
    }),
  }));

  async function setTermAmount(headId, termIdx, rupees) {
    const amount = Math.max(0, Math.round(rupees || 0));
    const row = rows.find((r) => r.id === headId);
    const cell = row.terms[termIdx];
    try {
      if (cell.lineId && amount === 0) {
        await api.delete(`/setup/fee-structure/${cell.lineId}`);
      } else if (cell.lineId) {
        await api.patch(`/setup/fee-structure/${cell.lineId}`, { amount: amount * 100 });
      } else if (amount > 0) {
        await api.post("/setup/fee-structure", {
          academic_year_id: year.id, class_level_id: activeClass.id, fee_head_id: headId,
          amount: amount * 100, term_no: termIdx + 1, due_on: dueOnForTerm(termIdx + 1, year),
        });
      } else {
        return; // nothing to do — was 0, still 0
      }
      await refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not save that amount.");
    }
  }

  async function toggleOneTime(headId, current) {
    try {
      await api.patch(`/setup/fee-heads/${headId}`, { is_one_time: !current });
      await refreshFeeHeads();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not update that fee.");
    }
  }

  async function renameHead(headId, name) {
    if (!name.trim()) return;
    try {
      await api.patch(`/setup/fee-heads/${headId}`, { name: name.trim() });
      await refreshFeeHeads();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not rename that fee.");
    }
  }

  async function addComponent() {
    const name = window.prompt("Name this fee component (e.g. \"Computer lab fee\"):");
    if (!name || !name.trim()) return;
    try {
      await api.post("/setup/fee-heads", { name: name.trim(), display_order: feeHeads.length + 1 });
      await refreshFeeHeads();
      await refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not add that component.");
    }
  }

  async function removeComponent(row) {
    try {
      // Try to remove the fee head entirely first — if it's never been
      // priced for any class or charged to any student, this really is a
      // full delete (the backend's own foreign keys guarantee that, not
      // a check duplicated here). If something else does depend on it —
      // another class still prices it, or it's already real school
      // history — the backend correctly refuses with 409, and this
      // falls back to just clearing THIS class's own price lines,
      // leaving the shared head alone for whoever still needs it.
      let fullyDeleted = true;
      try {
        await api.delete(`/setup/fee-heads/${row.id}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) fullyDeleted = false;
        else throw err;
      }
      if (!fullyDeleted) {
        for (const t of row.terms) if (t.lineId) await api.delete(`/setup/fee-structure/${t.lineId}`);
      }
      await refreshFeeHeads();
      await refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not remove that component.");
    }
  }

  function toggleTransport() {
    if (hasTransport) save({ ...state, structure: { ...state.structure, [active]: localRows.filter((r) => r.id !== TRANSPORT_ID) } });
    else save({ ...state, structure: { ...state.structure, [active]: [...localRows, { id: TRANSPORT_ID, name: "Transport fee", terms: [0, 0, 0], oneTime: false }] } });
  }

  async function copyTo(targetNames) {
    try {
      for (const targetName of targetNames) {
        const targetClass = classLevels.find((c) => c.name === targetName);
        if (!targetClass) continue;
        for (const row of rows) {
          for (let i = 0; i < 3; i++) {
            const rupees = row.terms[i].amount;
            if (rupees <= 0) continue;
            try {
              await api.post("/setup/fee-structure", {
                academic_year_id: year.id, class_level_id: targetClass.id, fee_head_id: row.id,
                amount: rupees * 100, term_no: i + 1, due_on: dueOnForTerm(i + 1, year),
              });
            } catch { /* a line may already exist for that class — skip it, not fatal */ }
          }
        }
      }
      setCopyOpen(false);
      await refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not copy to those classes.");
    }
  }

  if (!year || classLevels.length === 0) {
    return (
      <div>
        <PageHead title="Fee Structure" subtitle="Setting up…" />
        <div className={`${panel} p-10 text-center text-slate-400`}>Loading class list…</div>
      </div>
    );
  }

  return (
    <div>
      <PageHead title="Fee Structure"
        subtitle={`What each class is charged for ${state.year}, split across three terms. These amounts are copied onto a student when they enrol.`}>
        <button className={ghost} onClick={() => setCopyOpen(!copyOpen)}>Copy to other classes</button>
      </PageHead>

      {copyOpen && (
        <CopyPanel active={active} classLevels={classLevels} onCopy={copyTo} onCancel={() => setCopyOpen(false)} />
      )}

      <div className="grid lg:grid-cols-[200px_1fr] gap-5 items-start">
        <nav className={`${panel} p-2 max-h-[70vh] overflow-y-auto`}>
          {classLevels.map((c) => {
            const on = c.name === active;
            return (
              <button key={c.id} onClick={() => setActive(c.name)}
                className={`w-full flex justify-between items-center gap-2 px-3 py-2 rounded-xl text-left text-sm transition ${
                  on ? "bg-brand-600 text-white font-bold shadow-[0_6px_16px_-8px_rgba(91,61,245,0.9)]"
                     : "text-slate-600 font-semibold hover:bg-slate-50"}`}>
                <span>{c.name}</span>
              </button>
            );
          })}
        </nav>

        <div className={`${panel} min-w-0 overflow-hidden`}>
          <div className="px-6 py-5 border-b border-slate-100">
            <h2 className="text-lg font-extrabold">{active}</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              {STAGE_LABELS[activeClass?.stage] || activeClass?.stage} ·{" "}
              <b className="text-slate-700 tabular-nums">
                {inr(rows.filter((r) => !r.oneTime).reduce((sum, r) => sum + r.terms.reduce((s, t) => s + t.amount, 0), 0))}
              </b> a year
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[660px]">
              <thead className="bg-slate-50/70">
                <tr>
                  <th className={th}>Component</th>
                  {TERMS.map((t) => <th key={t} className={`${th} text-right`}>Term {t}</th>)}
                  <th className={`${th} text-right`}>Year</th>
                  <th className={th}>Charged</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody>
                {hasTransport && (
                  <tr className="border-b border-slate-50 bg-amber-50/40">
                    <td className="px-5 py-3">
                      <span className="text-sm font-bold flex items-center gap-2">
                        <Bus size={15} className="text-amber-500" /> Transport fee
                      </span>
                    </td>
                    <td colSpan={3} className="px-5 py-3 text-sm font-semibold text-amber-700">
                      Set per bus stop, not per class
                    </td>
                    <td className="px-5 py-3 text-right text-sm font-bold tabular-nums text-amber-700">
                      {range ? `${inr(range.min)}–${inr(range.max)}` : "no fares set"}
                    </td>
                    <td className="px-5 py-3 text-xs font-semibold text-slate-400">Riders only</td>
                    <td className="px-5 py-3 text-right">
                      <button className="text-slate-300 hover:text-red-500" onClick={toggleTransport}
                        aria-label="Remove transport component"><Trash2 size={15} /></button>
                    </td>
                  </tr>
                )}
                {rows.map((r) => {
                  const total = r.terms.reduce((a, t) => a + t.amount, 0);
                  return (
                    <tr key={r.id} className="border-b border-slate-50">
                      <td className="px-5 py-1.5">
                        <input className={cellInput} defaultValue={r.name} placeholder="Name this component"
                          key={`${r.id}-name-${r.name}`}
                          onBlur={(e) => renameHead(r.id, e.target.value)} />
                      </td>
                      {TERMS.map((t, i) => (
                        <td key={t} className="px-5 py-1.5">
                          <input className={`${cellInput} text-right tabular-nums`} inputMode="numeric"
                            defaultValue={r.terms[i].amount || ""} placeholder="0"
                            key={`${r.id}-${i}-${r.terms[i].amount}`}
                            onBlur={(e) => setTermAmount(r.id, i, +e.target.value)} />
                        </td>
                      ))}
                      <td className="px-5 py-1.5 text-right text-sm font-bold tabular-nums">{inr(total)}</td>
                      <td className="px-5 py-1.5">
                        <button onClick={() => toggleOneTime(r.id, r.oneTime)}
                          className={`text-[11px] font-bold rounded-lg px-2.5 py-1 border whitespace-nowrap ${
                            r.oneTime ? "border-brand-200 bg-brand-50 text-brand-600"
                                      : "border-slate-200 text-slate-400 hover:border-slate-300"}`}>
                          {r.oneTime ? "New admissions" : "Every year"}
                        </button>
                      </td>
                      <td className="px-5 py-1.5 text-right">
                        <button className="text-slate-300 hover:text-red-500"
                          onClick={() => removeComponent(r)}
                          aria-label={`Remove ${r.name}`}><Trash2 size={15} /></button>
                      </td>
                    </tr>
                  );
                })}
                {loading && (
                  <tr><td colSpan={6} className="px-5 py-6 text-center text-sm text-slate-400">Loading…</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap gap-2 px-5 py-4 border-t border-slate-100">
            <button className={ghost} onClick={addComponent}>
              <Plus size={15} /> Add component
            </button>
            {!hasTransport && (
              <button className={ghost} onClick={toggleTransport}>
                <Bus size={15} /> Add transport
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CopyPanel({ active, classLevels, onCopy, onCancel }) {
  const [picked, setPicked] = useState([]);
  return (
    <div className={`${panel} p-5 mb-5`}>
      <p className="text-sm font-semibold text-slate-600 mb-3">
        Copy {active}'s amounts onto these classes (existing lines for a class/term already set are left alone):
      </p>
      <div className="flex flex-wrap gap-2 mb-4">
        {classLevels.filter((c) => c.name !== active).map((c) => (
          <button key={c.id}
            onClick={() => setPicked(picked.includes(c.name)
              ? picked.filter((x) => x !== c.name) : [...picked, c.name])}
            className={`text-xs font-bold rounded-lg px-3 py-1.5 border ${
              picked.includes(c.name) ? "bg-brand-600 border-brand-600 text-white"
                                      : "border-slate-200 text-slate-500 hover:border-slate-300"}`}>
            {c.name}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <button className={primary} disabled={!picked.length} onClick={() => onCopy(picked)}>
          Copy to {picked.length || "no"} {picked.length === 1 ? "class" : "classes"}
        </button>
        <button className={ghost} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Admissions — promote from the previous year, or add a new student   */
/* ================================================================== */

// Mirrors server/services/promotion.ts::isActionable — the server
// recomputes this from the same fields regardless of what's sent, so
// this is purely for deciding what the UI shows as ready, not a
// security boundary duplicated insecurely on the client.
function isActionable(move) {
  return move.kind === "promote" && move.toClassId !== null && !move.blockedReason &&
    !move.needsOptin && !(move.needsStream && !move.streamId);
}

/**
 * Real preview -> assign-sections -> commit against the backend, kept to
 * one move at a time to match the existing "promote whoever's at the
 * counter right now" workflow rather than a batch operation. Two
 * deliberate scope limits, not oversights: a class requiring a stream
 * (1st PU -> 2nd PU) shows but isn't actionable yet — the old app never
 * had a stream concept at all, so this isn't a regression, just not
 * built out yet; and graduating (terminal-class) students are shown for
 * visibility only — the backend's commit() refuses a batch with no
 * promotable move in it, so processing a graduation with nobody else to
 * promote alongside it needs its own follow-up.
 */
export function PromoteTab({ academicYears, classLevels, ensureUnassignedSection, refreshAcademicYears }) {
  // Every real year is a valid "From" candidate — "To" is no longer an
  // independent choice, so there's nothing left to filter priorYears
  // against. Most recent first, since that's the year promotion is
  // almost always run from.
  const priorYears = [...academicYears]
    .sort((a, b) => (String(a.starts_on).slice(0, 10) < String(b.starts_on).slice(0, 10) ? 1 : -1));

  const [sourceYearPick, setSourceYearPick] = useState("");
  const sourceYearName = sourceYearPick || priorYears[0]?.name || "";
  const fromYear = academicYears.find((y) => y.name === sourceYearName);

  // "To" is computed from "From", not picked freely — the very next
  // year on the ladder, June to March, one calendar year after From
  // starts. If that year doesn't exist yet, there's nothing to select
  // until it's created — which can now happen right here, rather than
  // sending the office to Fees Setup or the top bar first.
  const expectedNextYear = fromYear ? (() => {
    const startYear = Number(String(fromYear.starts_on).slice(0, 4)) + 1;
    return {
      name: `${startYear}-${String(startYear + 1).slice(-2)}`,
      starts_on: `${startYear}-06-01`, ends_on: `${startYear + 1}-03-31`,
    };
  })() : null;
  const toYear = expectedNextYear ? academicYears.find((y) => y.name === expectedNextYear.name) : null;
  const [creatingYear, setCreatingYear] = useState(false);

  async function createNextYear() {
    if (!expectedNextYear) return;
    setCreatingYear(true);
    try {
      await api.post("/setup/academic-years", { ...expectedNextYear, status: "planning" });
      await refreshAcademicYears();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not create that academic year.");
    } finally {
      setCreatingYear(false);
    }
  }

  const [classFilter, setClassFilter] = useState("");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState(null); // {moves, graduating, blocked, summary}
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [justPromoted, setJustPromoted] = useState(null);
  const [error, setError] = useState("");

  async function refetchPreview() {
    if (!fromYear || !toYear) { setPreview(null); return; }
    setLoading(true);
    setError("");
    try {
      const result = await api.post("/promotion/preview", {
        from_year_id: fromYear.id, to_year_id: toYear.id,
      });
      setPreview(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the promotion preview.");
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refetchPreview(); }, [fromYear?.id, toYear?.id]); // eslint-disable-line

  async function promoteOne(move, confirmOptIn) {
    setBusyId(move.enrollmentId);
    setError("");
    try {
      // The target class may never have had a section created in the
      // target year at all yet (no admission has landed there either) —
      // the same "Unassigned" placeholder New Admission uses covers this,
      // rather than assign-sections failing outright with nowhere to put
      // the very first student promoted into a class.
      await ensureUnassignedSection(move.toClassId, toYear.id);
      const toConfirm = confirmOptIn ? { ...move, needsOptin: false } : move;
      const assigned = await api.post("/promotion/assign-sections", {
        to_year_id: toYear.id, moves: [toConfirm],
      });
      await api.post("/promotion/commit", {
        from_year_id: fromYear.id, to_year_id: toYear.id, moves: assigned.moves,
      });
      setJustPromoted({ name: move.studentName, target: move.toClassName });
      await refetchPreview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not promote that student.");
    } finally {
      setBusyId(null);
    }
  }

  const classNamesInPreview = preview
    ? [...new Set(preview.moves.concat(preview.blocked).map((m) => m.fromClassName))]
        .sort((a, b) => (classLevels.find((c) => c.name === a)?.ladder_order ?? 0)
                       - (classLevels.find((c) => c.name === b)?.ladder_order ?? 0))
    : [];

  const q = query.trim().toLowerCase();
  const matches = (m) => !q || m.studentName.toLowerCase().includes(q) || m.admissionNo.toLowerCase().includes(q);
  const byClass = (list) => classFilter ? list.filter((m) => m.fromClassName === classFilter) : list;
  const visibleMoves = preview ? byClass(preview.moves).filter(matches) : [];
  const graduating = preview ? byClass(preview.graduating).filter(matches) : [];

  if (!priorYears.length) {
    return (
      <div>
        <PageHead title="Class Promotion"
          subtitle="Bring continuing students into the next year from last year's roll." />
        <div className={`${panel} border-dashed p-12 text-center`}>
          <Sparkles className="mx-auto text-slate-300 mb-3" size={26} />
          <p className="font-bold text-slate-700">No previous year to promote from</p>
          <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
            Promotion needs a prior year's roll already in the system. Import that
            roll under First Time Import, or use New Admission for students
            joining now.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHead title="Class Promotion"
        subtitle={`Bring continuing students from ${sourceYearName} into ${toYear?.name || expectedNextYear?.name}, one at a time as they're found.`} />

      {justPromoted && (
        <div className="mb-5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-2xl px-5 py-4 text-sm font-semibold">
          Promoted {justPromoted.name} to {justPromoted.target}.
        </div>
      )}
      {error && (
        <div className="mb-5 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-2xl px-5 py-4 text-sm font-semibold">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div className={`${panel} p-5 mb-5 flex flex-wrap items-end gap-4`}>
        <div className="min-w-[150px]">
          <label className={eyebrow}>From</label>
          <FilterSelect value={sourceYearName} active
            onChange={(e) => { setSourceYearPick(e.target.value); setClassFilter(""); setJustPromoted(null); }}
            className="mt-2">
            {priorYears.map((y) => <option key={y.id} value={y.name}>{y.name}</option>)}
          </FilterSelect>
        </div>
        <ArrowRight size={16} className="text-slate-300 mb-3 shrink-0" />
        <div className="min-w-[150px]">
          <label className={eyebrow}>To</label>
          {toYear ? (
            <div className="mt-2 rounded-xl px-3.5 py-2.5 text-sm font-bold bg-brand-50 border-2 border-brand-200 text-brand-700">
              {toYear.name}
            </div>
          ) : (
            <button onClick={createNextYear} disabled={creatingYear}
              className="mt-2 rounded-xl px-3.5 py-2.5 text-sm font-bold border-2 border-dashed border-amber-300 bg-amber-50 text-amber-700 hover:border-amber-400 disabled:opacity-50 whitespace-nowrap">
              {creatingYear ? "Creating…" : `+ Create ${expectedNextYear?.name}`}
            </button>
          )}
        </div>
        <div className="min-w-[160px]">
          <label className={eyebrow}>Class</label>
          <FilterSelect value={classFilter} onChange={(e) => setClassFilter(e.target.value)}
            active={Boolean(classFilter)} className="mt-2">
            <option value="">All classes</option>
            {classNamesInPreview.map((c) => <option key={c} value={c}>{c}</option>)}
          </FilterSelect>
        </div>
        {preview && (
          <div className="flex gap-5 text-sm sm:ml-auto">
            <div>
              <p className="text-[22px] font-extrabold tabular-nums leading-none">{preview.summary.promotable}</p>
              <p className="eyebrow text-slate-400 mt-1">Pending</p>
            </div>
            <div>
              <p className="text-[22px] font-extrabold tabular-nums leading-none text-slate-400">{preview.summary.graduating}</p>
              <p className="eyebrow text-slate-400 mt-1">Completing school</p>
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div className={`${panel} border-dashed p-12 text-center text-slate-400 font-semibold`}>Loading…</div>
      ) : !preview || (preview.moves.length === 0 && preview.graduating.length === 0 && preview.blocked.length === 0) ? (
        <div className={`${panel} border-dashed p-10 text-center text-slate-400 font-semibold`}>
          Everyone from {sourceYearName} is already accounted for in {toYear?.name || expectedNextYear?.name}.
        </div>
      ) : (
        <>
          {(preview.moves.length > 0 || preview.blocked.length > 0) && (
            <input className={`${field} max-w-sm mb-5`} value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find the student at the counter — name or admission no." />
          )}

          {visibleMoves.length > 0 && (
            <div className={`${panel} overflow-hidden mb-5`}>
              <div className="px-6 py-4 border-b border-slate-100">
                <h2 className="font-extrabold">Promote to the next class</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px]">
                  <thead className="bg-slate-50/70">
                    <tr>
                      <th className={th}>Student</th>
                      <th className={th}>Moving</th>
                      <th className={th} />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleMoves.map((m) => {
                      const busy = busyId === m.enrollmentId;
                      const needsStreamPick = m.needsStream && !m.streamId;
                      return (
                        <tr key={m.enrollmentId} className="border-b border-slate-50 text-sm">
                          <td className="px-4 py-2.5">
                            <div className="font-bold">{m.studentName}</div>
                            <div className="text-xs text-slate-400 tabular-nums">{m.admissionNo}</div>
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span className="font-semibold text-slate-500">{m.fromClassName}</span>
                            <ArrowRight size={13} className="inline mx-1.5 text-slate-300" />
                            <span className="font-bold">{m.toClassName}</span>
                            {needsStreamPick && (
                              <span className="ml-2 text-[11px] font-semibold text-amber-600">
                                (needs a stream — not supported here yet)
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <button disabled={busy || needsStreamPick}
                              onClick={() => promoteOne(m, m.needsOptin)}
                              className={m.needsOptin
                                ? "text-xs font-bold rounded-lg px-3 py-2 border-2 border-amber-300 bg-amber-50 text-amber-700 hover:border-amber-400 whitespace-nowrap disabled:opacity-50"
                                : "text-xs font-bold rounded-lg px-3 py-2 bg-brand-600 text-white hover:bg-brand-700 whitespace-nowrap disabled:opacity-50"}>
                              {busy ? "Promoting…" : m.needsOptin ? `Confirm ${m.toClassName} & Promote` : "Promote"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="px-6 py-3 text-xs text-slate-500 border-t border-slate-100 max-w-2xl">
                Section carries forward automatically where one exists with room —
                reassign it later from Fee Collection if the school reshuffles sections.
              </p>
            </div>
          )}

          {graduating.length > 0 && (
            <div className={`${panel} overflow-hidden`}>
              <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
                <GraduationCap size={17} className="text-slate-400" />
                <h2 className="font-extrabold">Completing school</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[500px]">
                  <thead className="bg-slate-50/70">
                    <tr>
                      <th className={th}>Student</th>
                      <th className={th}>Class</th>
                    </tr>
                  </thead>
                  <tbody>
                    {graduating.map((m) => (
                      <tr key={m.enrollmentId} className="border-b border-slate-50 text-sm">
                        <td className="px-4 py-2.5">
                          <div className="font-bold">{m.studentName}</div>
                          <div className="text-xs text-slate-400 tabular-nums">{m.admissionNo}</div>
                        </td>
                        <td className="px-4 py-2.5 text-slate-500 font-semibold">{m.fromClassName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="px-6 py-3 text-xs text-slate-400 border-t border-slate-100">
                The top class has no class above it — these students finish school
                rather than promote. Marking them as graduated needs at least one
                other promotion in the same batch and isn't wired up from this
                screen yet.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function NewAdmissionTab({ state, save, classLevels, academicYears }) {
  const blank = { name: "", classLevelId: "", sectionId: "", dob: "",
    guardianName: "", phone: "", email: "", address: "" };
  const [f, setF] = useState(blank);
  const [sections, setSections] = useState([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const [previewAdmissionNo, setPreviewAdmissionNo] = useState("");
  // Local only, not persisted — students admitted through this real flow
  // live on the backend now, not in state.students, so "recent" here
  // genuinely means "since this browser tab opened this screen".
  const [addedThisSession, setAddedThisSession] = useState([]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const year = academicYears.find((y) => y.name === state.year);
  const activeClass = classLevels.find((c) => c.id === f.classLevelId);

  // Real sections for this class/year — the school specifically wants
  // section captured at admission time now, rather than the earlier
  // deferred-to-Fee-Collection design. Refetched whenever the class
  // changes; the section field resets alongside it, since a section
  // that belonged to the previous class choice would be meaningless.
  async function refreshSections(classLevelId, yearId) {
    if (!classLevelId || !yearId) { setSections([]); return; }
    try {
      setSections(await api.get(`/setup/sections?academic_year_id=${yearId}&class_level_id=${classLevelId}`));
    } catch {
      setSections([]);
    }
  }
  useEffect(() => {
    refreshSections(f.classLevelId, year?.id);
    setF((prev) => ({ ...prev, sectionId: "" }));
  }, [f.classLevelId, year?.id]); // eslint-disable-line

  async function addSection() {
    if (!f.classLevelId || !year) return;
    const name = window.prompt("New section name (e.g. \"A\", \"B\", \"C\"):");
    if (!name || !name.trim()) return;
    try {
      const created = await api.post("/setup/sections", {
        academic_year_id: year.id, class_level_id: f.classLevelId,
        name: name.trim().toUpperCase().slice(0, 10),
      });
      setSections((prev) => [...prev, created]);
      setF((prev) => ({ ...prev, sectionId: created.id }));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not add that section.");
    }
  }

  async function refreshAdmissionNoPreview(classLevelId, yearId, className) {
    if (!classLevelId || !yearId) { setPreviewAdmissionNo(""); return; }
    try {
      const enrollments = await api.get(
        `/students/enrollments?academic_year_id=${yearId}&class_level_id=${classLevelId}`);
      const prefix = `${state.year}/${className}/`;
      setPreviewAdmissionNo(`${prefix}${String(enrollments.length + 1).padStart(3, "0")}`);
    } catch {
      setPreviewAdmissionNo("");
    }
  }

  // Recomputed from the real backend roster whenever the class changes —
  // sourced from what's actually there now, not this browser's own local
  // list, since another staff member could have admitted into the same
  // class since this page loaded. The backend's own unique constraint on
  // admission_no is still the real safety net if two people submit at
  // almost the same moment; this is a best-effort preview, not a lock.
  useEffect(() => {
    refreshAdmissionNoPreview(f.classLevelId, year?.id, activeClass?.name);
  }, [f.classLevelId, year?.id]); // eslint-disable-line

  async function submit(e) {
    e.preventDefault();
    setError(""); setDone(null);
    const name = f.name.trim();
    if (!f.classLevelId) return setError("Choose a class.");
    if (!f.sectionId) return setError("Choose a section.");
    if (!name || name.length < 2) return setError("Enter the student's full name.");
    if (!year) return setError("No academic year is set up yet.");

    setBusy(true);
    try {
      const result = await api.post("/students/admit", {
        admission_no: previewAdmissionNo,
        full_name: name,
        date_of_birth: f.dob || null,
        guardian_name: f.guardianName.trim(),
        guardian_phone: f.phone.trim(),
        guardian_email: f.email.trim(),
        address: f.address.trim(),
        academic_year_id: year.id,
        class_level_id: f.classLevelId,
        section_id: f.sectionId,
        admission_type: "new",
      });
      setDone({ name: result.student.full_name, admissionNo: result.student.admission_no });
      setAddedThisSession((prev) => [
        { id: result.student.id, name: result.student.full_name,
          admissionNo: result.student.admission_no, className: activeClass.name },
        ...prev,
      ]);
      // Class and section are sticky for rapid back-to-back entry from
      // the same admission form (most schools admit a run of children
      // into the same class/section at once); everything specific to
      // one child is cleared.
      setF({ ...blank, classLevelId: f.classLevelId, sectionId: f.sectionId });
      // The class stays selected, so the effect above won't re-run on
      // its own (same dependencies) — refresh explicitly, or the next
      // preview would still show the number just used.
      await refreshAdmissionNoPreview(f.classLevelId, year.id, activeClass.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that student.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHead title="New Admission"
        subtitle="For a student joining the school for the first time." />
      <div className="grid lg:grid-cols-[1fr_340px] gap-5 items-start">
      <div className={`${panel} p-6`}>
        <div className="flex flex-wrap items-end justify-between gap-4 mb-1">
          <h2 className="text-lg font-extrabold">New admission</h2>
          <div className="min-w-[140px]">
            <label className={eyebrow}>Admitting into</label>
            <FilterSelect value={state.year} active className="mt-1.5"
              onChange={(e) => save({ ...state, year: e.target.value })}>
              {academicYears.map((y) => <option key={y.id} value={y.name}>{y.name}</option>)}
            </FilterSelect>
          </div>
        </div>
        <p className="text-sm text-slate-500 mb-5">
          The admission fee applies automatically, since it's charged only on
          first entry. Section isn't asked here — assign it later from Fee
          Collection & Roll once class rosters are settled.
        </p>

        {error && (
          <div className="mb-4 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm font-semibold">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}
        {done && (
          <div className="mb-4 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl px-4 py-3 text-sm font-semibold">
            Added {done.name} — admission no. {done.admissionNo}. Collect their first
            payment from Fee Collection & Roll.
          </div>
        )}

        <form onSubmit={submit} className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className={eyebrow}>Class<span className="text-red-500"> *</span></label>
            <FilterSelect value={f.classLevelId} active={Boolean(f.classLevelId)} className="mt-2"
              onChange={(e) => setF({ ...f, classLevelId: e.target.value })}>
              <option value="">Choose a class</option>
              {classLevels.map((c) => <option key={c.id} value={c.id}>{c.name} — {STAGE_LABELS[c.stage] || c.stage}</option>)}
            </FilterSelect>
          </div>
          <div>
            <label className={eyebrow}>Section<span className="text-red-500"> *</span></label>
            <FilterSelect value={f.sectionId} active={Boolean(f.sectionId)} disabled={!f.classLevelId}
              className="mt-2"
              onChange={(e) => {
                if (e.target.value === "__new__") return addSection();
                setF({ ...f, sectionId: e.target.value });
              }}>
              <option value="">{f.classLevelId ? "Choose a section" : "Choose a class first"}</option>
              {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              {f.classLevelId && <option value="__new__">+ Add new section</option>}
            </FilterSelect>
          </div>
          <div>
            <label className={eyebrow}>Admission no.</label>
            <div className={`mt-2 rounded-xl px-3.5 py-2.5 text-sm font-bold tabular-nums border-2 ${
              f.classLevelId ? "bg-brand-50 border-brand-200 text-brand-700"
                          : "bg-slate-50 border-slate-100 text-slate-300"}`}>
              {f.classLevelId ? (previewAdmissionNo || "Working it out…") : "Choose a class first"}
            </div>
          </div>
          <div className="sm:col-span-2">
            <label className={eyebrow}>Full name<span className="text-red-500"> *</span></label>
            <input className={`${field} mt-2`} value={f.name} onChange={set("name")}
              placeholder="Ananya Krishnamurthy" />
          </div>
          <div>
            <label className={eyebrow}>Date of birth</label>
            <input type="date" className={`${field} mt-2`} value={f.dob || ""} onChange={set("dob")} />
          </div>
          <div>
            <label className={eyebrow}>Guardian name</label>
            <input className={`${field} mt-2`} value={f.guardianName} onChange={set("guardianName")} />
          </div>
          <div>
            <label className={eyebrow}>Phone</label>
            <input className={`${field} mt-2`} value={f.phone} onChange={set("phone")} inputMode="numeric" />
          </div>
          <div className="sm:col-span-2">
            <label className={eyebrow}>Email</label>
            <input className={`${field} mt-2`} value={f.email} onChange={set("email")} type="email" />
          </div>
          <div className="sm:col-span-2">
            <label className={eyebrow}>Address</label>
            <textarea rows={2} className={`${field} mt-2`} value={f.address} onChange={set("address")} />
          </div>
          <div className="sm:col-span-2">
            <button type="submit" disabled={busy} className={primary}>
              <UserPlus size={16} /> {busy ? "Adding…" : "Add student"}
            </button>
          </div>
        </form>
      </div>

      <div className={`${panel} overflow-hidden`}>
        <div className="px-5 py-4 border-b border-slate-100">
          <h2 className="font-extrabold text-sm">Added this session</h2>
        </div>
        {addedThisSession.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-400 font-semibold">
            New admissions will appear here as you add them.
          </p>
        ) : (
          <ul className="divide-y divide-slate-50">
            {addedThisSession.map((s) => (
              <li key={s.id} className="px-5 py-3">
                <p className="font-bold text-sm">{s.name}</p>
                <p className="eyebrow text-slate-400 mt-0.5">{s.className} · {s.admissionNo}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
    </div>
  );
}

/* ================================================================== */
/* Import students — class chosen from a dropdown, no separate picker  */
/* ================================================================== */

export function ImportScreen({ state, academicYears, classLevels }) {
  const [classLevelId, setClassLevelId] = useState(classLevels[0]?.id || "");
  return (
    <ClassImport state={state} academicYears={academicYears} classLevels={classLevels}
      classLevelId={classLevelId} setClassLevelId={setClassLevelId} />
  );
}

function ClassImport({ state, academicYears, classLevels, classLevelId, setClassLevelId }) {
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");
  const [batch, setBatch] = useState(null); // {id, total_rows, valid_rows}
  const [rows, setRows] = useState([]);
  const [existing, setExisting] = useState([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);
  const [filter, setFilter] = useState("all");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const year = academicYears.find((y) => y.name === state.year);
  const activeClass = classLevels.find((c) => c.id === classLevelId);

  async function refetchExisting() {
    if (!year || !classLevelId) { setExisting([]); return; }
    const list = await api.get(
      `/students/enrollments?academic_year_id=${year.id}&class_level_id=${classLevelId}`);
    setExisting(list);
  }
  useEffect(() => { refetchExisting(); }, [year?.id, classLevelId]); // eslint-disable-line

  async function stage(text, name) {
    setError(""); setDone(null);
    if (!year) return setError("No academic year is set up yet.");
    setBusy(true);
    try {
      const staged = await api.post("/import/stage", {
        academic_year_id: year.id, filename: name, content: text,
      });
      setBatch(staged);
      const { rows: stagedRows } = await api.get(`/import/batches/${staged.id}/rows`);
      setRows(stagedRows);
      setContent(text); setFilename(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file could not be staged.");
    } finally {
      setBusy(false);
    }
  }

  function readFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => stage(String(reader.result), file.name);
    reader.onerror = () => setError("The file could not be read.");
    reader.readAsText(file);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    readFile(e.dataTransfer.files?.[0]);
  }

  async function commit() {
    if (!batch) return;
    setBusy(true);
    try {
      const result = await api.post(`/import/batches/${batch.id}/commit`, {});
      setDone(result);
      setBatch(null); setRows([]); setContent(""); setFilename("");
      await refetchExisting();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not commit that import.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadTemplate() {
    const csv = await api.get("/import/template");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${activeClass?.name || "class"}-import-template.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  function startOver() {
    setBatch(null); setRows([]); setContent(""); setFilename(""); setError(""); setDone(null);
  }

  // Switching class mid-upload would silently reassign whatever's on
  // screen against the wrong roll, so the picker resets the file instead.
  function changeClass(next) {
    setClassLevelId(next);
    startOver();
  }

  const good = rows.filter((r) => !r.errors.length);
  const bad = rows.filter((r) => r.errors.length);
  const warned = good.filter((r) => r.warnings.length);
  const shown = filter === "errors" ? bad : filter === "warnings" ? warned
    : filter === "ok" ? good : rows;

  return (
    <div>
      <PageHead title="First Time Import"
        subtitle={`Import a whole class's roll at once for ${state.year} — for a school's existing roster, not day-to-day admissions. Choose the class below, then upload the sheet the office already keeps.`} />

      <div className={`${panel} p-5 mb-6 flex flex-wrap items-end gap-4`}>
        <div className="min-w-[240px]">
          <label className={eyebrow}>Importing into</label>
          <FilterSelect value={classLevelId} onChange={(e) => changeClass(e.target.value)} active className="mt-2">
            {classLevels.map((c) => <option key={c.id} value={c.id}>{c.name} — {STAGE_LABELS[c.stage] || c.stage}</option>)}
          </FilterSelect>
        </div>
        <p className="text-xs text-slate-500 pb-2.5 max-w-md">
          Every row in the file below goes into <b className="text-slate-700">{activeClass?.name}</b>{" "}
          unless the sheet names a different class for that row.
        </p>
      </div>

      {done && (
        <div className="mb-6 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-2xl px-5 py-4 text-sm font-semibold">
          Imported {done.created} students into {activeClass?.name}.{" "}
          {done.skipped > 0
            ? `${done.skipped} rows were skipped. Fix them in your sheet and upload again — anything already in is caught as a duplicate.`
            : "Every row came through cleanly."}
        </div>
      )}

      {!batch && (
        <>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            className={`${panel} border-2 border-dashed p-12 text-center cursor-pointer transition ${
              dragging ? "border-brand-500 bg-brand-50" : "border-slate-200 hover:border-brand-300"}`}>
            <div className="w-14 h-14 rounded-2xl bg-brand-50 text-brand-600 grid place-items-center mx-auto mb-4">
              <Upload size={24} />
            </div>
            <p className="text-lg font-extrabold">{busy ? "Reading your file…" : "Drop your CSV file here"}</p>
            <p className="text-sm text-slate-500 mt-1">or click to browse your computer</p>
            <span className="inline-flex items-center gap-2 mt-5 bg-brand-600 text-white text-sm font-bold rounded-xl px-5 py-2.5 shadow-[0_8px_20px_-8px_rgba(91,61,245,0.8)]">
              <FileSpreadsheet size={16} /> Choose CSV file
            </span>
            <p className="text-xs text-slate-400 mt-5">
              From Excel or Google Sheets: File → Download → Comma-separated values (.csv)
            </p>
            <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" className="hidden"
              onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ""; }} />
          </div>

          <div className="flex flex-wrap gap-2.5 mt-4">
            <button className={ghost} onClick={downloadTemplate}>
              <Download size={15} /> Blank template
            </button>
            <button className={ghost} onClick={() => stage(SAMPLE_MESSY_CSV, "messy-example.csv")}>
              Load a messy example
            </button>
          </div>

          {existing.length > 0 && (
            <div className={`${panel} mt-6 overflow-hidden`}>
              <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-extrabold">{existing.length} already in {activeClass?.name}</h2>
                {existing.some((s) => s.section_name === "Unassigned") && (
                  <span className="text-xs font-bold text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1">
                    {existing.filter((s) => s.section_name === "Unassigned").length} need a section
                  </span>
                )}
              </div>
              <p className="px-6 pt-3 text-xs text-slate-500 max-w-2xl">
                For reference while you import — section is assigned from Fee
                Collection, once class rosters are settled.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-50/70">
                    <tr>{["Admission no.", "Name", "Section"].map((h) =>
                      <th key={h} className={th}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {existing.slice(0, 25).map((s) => (
                      <tr key={s.id}
                        className={`border-b border-slate-50 text-sm font-medium ${s.section_name === "Unassigned" ? "bg-amber-50/40" : ""}`}>
                        <td className="px-5 py-2.5 tabular-nums text-slate-500">{s.admission_no}</td>
                        <td className="px-5 py-2.5 font-semibold">{s.full_name}</td>
                        <td className="px-5 py-2.5">
                          {s.section_name === "Unassigned"
                            ? <span className="text-xs font-semibold text-amber-600">Not assigned</span>
                            : <span className="font-bold">{s.section_name}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {error && (
        <div className="my-5 flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-2xl px-5 py-4 text-sm font-semibold">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {batch && (
        <>
          <div className="grid sm:grid-cols-4 gap-4 mb-5">
            {[["all", rows.length, "Rows read", "text-ink", "bg-slate-100 text-slate-500"],
              ["ok", good.length, "Ready to import", "text-emerald-600", "bg-emerald-50 text-emerald-600"],
              ["warnings", warned.length, "To check", "text-amber-600", "bg-amber-50 text-amber-600"],
              ["errors", bad.length, "Cannot import", "text-red-500", "bg-red-50 text-red-500"],
            ].map(([key, count, lbl, colour, tint]) => (
              <button key={key} onClick={() => setFilter(key)}
                className={`${panel} p-5 text-left transition ${
                  filter === key ? "border-brand-500 ring-1 ring-brand-500" : "hover:border-slate-200"}`}>
                <div className={`w-9 h-9 rounded-xl grid place-items-center mb-3 ${tint}`}>
                  {key === "errors" ? <AlertTriangle size={16} /> : key === "ok" ? <Check size={16} />
                    : key === "warnings" ? <AlertTriangle size={16} /> : <FileSpreadsheet size={16} />}
                </div>
                <p className={`text-[26px] font-extrabold tabular-nums leading-none ${colour}`}>{count}</p>
                <p className="eyebrow text-slate-400 mt-1.5">{lbl}</p>
              </button>
            ))}
          </div>

          <div className={`${panel} overflow-x-auto`}>
            <table className="w-full min-w-[900px]">
              <thead className="bg-slate-50/70">
                <tr>{["Line", "Admission no.", "Name", "Class", "Sec", "Date of birth",
                      "Guardian", "Phone", "What we found"].map((h) =>
                  <th key={h} className={th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className={`border-b border-slate-50 text-sm font-medium ${
                    r.errors.length ? "bg-red-50/60" : r.warnings.length ? "bg-amber-50/50" : ""}`}>
                    <td className="px-5 py-2.5 text-slate-300 tabular-nums">{r.line_no}</td>
                    <td className="px-5 py-2.5 tabular-nums">{r.raw.admission_no || <em className="text-slate-300">blank</em>}</td>
                    <td className="px-5 py-2.5 font-semibold">{r.raw.full_name || <em className="text-slate-300 font-normal">blank</em>}</td>
                    <td className="px-5 py-2.5">
                      {r.raw._class || <em className="text-slate-300">{r.raw.class_name || "blank"}</em>}
                      {r.raw._class && r.raw.class_name && r.raw._class !== r.raw.class_name && (
                        <span className="text-[11px] text-slate-400 ml-1.5">was "{r.raw.class_name}"</span>
                      )}
                    </td>
                    <td className="px-5 py-2.5">{r.raw._section}</td>
                    <td className="px-5 py-2.5">{displayDate(r.raw._dob) || <span className="text-slate-300">—</span>}</td>
                    <td className="px-5 py-2.5">{r.raw.guardian_name || <span className="text-slate-300">—</span>}</td>
                    <td className="px-5 py-2.5 tabular-nums">{r.raw._phone || <span className="text-slate-300">—</span>}</td>
                    <td className="px-5 py-2.5 max-w-xs">
                      {r.errors.map((m, i) => <div key={i} className="text-xs font-semibold text-red-600">{m}</div>)}
                      {r.warnings.map((m, i) => <div key={i} className="text-xs font-semibold text-amber-600">{m}</div>)}
                      {!r.errors.length && !r.warnings.length &&
                        <span className="text-xs text-slate-300">Looks fine</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={`${panel} p-5 mt-5 flex flex-wrap justify-between items-center gap-4`}>
            <div>
              <p className="font-extrabold">
                Import {good.length} into {activeClass?.name}
                {bad.length > 0 && <span className="font-semibold text-slate-400"> · {bad.length} skipped</span>}
              </p>
              <p className="text-xs text-slate-500 mt-1 max-w-xl">
                Imported students are recorded as continuing, not new admissions, so none
                is charged an admission fee.
              </p>
            </div>
            <div className="flex gap-2.5">
              <button className={primary} disabled={!good.length || busy} onClick={commit}>
                <Upload size={16} /> {busy ? "Importing…" : `Import ${good.length}`}
              </button>
              <button className={ghost} onClick={startOver}>Start over</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ================================================================== */
/* Concessions                                                         */
/* ================================================================== */

/**
 * Minimal, real first pass: lists actual enrollments for the current
 * year with their real balances, and opens the real PaymentModal. Not
 * yet the full richness of the old localStorage version (filters,
 * inline concession editing in the table, editable section/bus-stop
 * columns) — that's follow-up work; this exists to close the loop from
 * New Admission through to an actual payment against real data.
 */
export function ConcessionScreen({ academicYears, state }) {
  const [enrollments, setEnrollments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [payingFor, setPayingFor] = useState(null); // {enrollmentId, student}

  const year = academicYears.find((y) => y.name === state.year);

  async function refetch() {
    if (!year) { setEnrollments([]); setLoading(false); return; }
    setLoading(true);
    const list = await api.get(`/students/enrollments?academic_year_id=${year.id}`);
    const withLedgers = await Promise.all(list.map(async (e) => ({
      ...e, ledger: await api.get(`/students/enrollments/${e.id}/ledger`),
    })));
    setEnrollments(withLedgers);
    setLoading(false);
  }
  useEffect(() => { refetch(); }, [year?.id]); // eslint-disable-line

  if (loading) {
    return (
      <div>
        <PageHead title="Fee Collection"
          subtitle="Every enrolled student for the year, with fees and payment status in one place." />
        <div className={`${panel} p-12 text-center text-slate-400 font-semibold`}>Loading…</div>
      </div>
    );
  }

  if (!enrollments.length) {
    return (
      <div>
        <PageHead title="Fee Collection"
          subtitle="Every enrolled student for the year, with fees and payment status in one place." />
        <div className={`${panel} border-dashed p-12 text-center text-slate-400 font-semibold`}>
          No students in {state.year} yet. Add them under New Admission.
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHead title="Fee Collection"
        subtitle="Every enrolled student for the year, with fees and payment status in one place." />

      <div className={`${panel} overflow-hidden`}>
        <div className="px-6 py-5 border-b border-slate-100">
          <h2 className="text-lg font-extrabold">Student Fee Records</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1240px]">
            <thead className="bg-slate-50/70">
              <tr>
                <th className={`${th} min-w-[190px]`}>Student info</th>
                <th className={`${th} min-w-[70px]`}>Class</th>
                <th className={`${th} min-w-[90px]`}>Section</th>
                <th className={`${th} min-w-[160px]`}>Parent / Guardian</th>
                <th className={`${th} min-w-[110px]`}>Phone</th>
                <th className={`${th} min-w-[200px]`}>Address</th>
                <th className={`${th} text-right min-w-[90px]`}>Gross fee</th>
                <th className={`${th} text-right min-w-[90px]`}>Paid</th>
                <th className={`${th} text-right min-w-[100px]`}>Balance</th>
                <th className={`${th} min-w-[110px]`} />
              </tr>
            </thead>
            <tbody>
              {enrollments.map((e) => {
                const balance = e.ledger.balance / 100;
                return (
                  <tr key={e.id} className="border-b border-slate-50 text-sm font-medium">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <span className="w-9 h-9 rounded-full bg-brand-50 text-brand-600 grid place-items-center font-bold text-xs shrink-0">
                          {e.full_name.charAt(0).toUpperCase()}
                        </span>
                        <span>
                          <span className="block font-bold">{e.full_name}</span>
                          <span className="block eyebrow text-slate-400">ID: {e.admission_no}</span>
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap font-semibold">{e.class_name}</td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      {e.section_name === "Unassigned"
                        ? <span className="text-amber-600 font-bold text-xs">Unassigned</span>
                        : e.section_name}
                    </td>
                    <td className="px-5 py-3">
                      {e.guardian_name || <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-5 py-3 tabular-nums">
                      {e.guardian_phone || <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-5 py-3 text-slate-500 max-w-[220px] truncate" title={e.address || ""}>
                      {e.address || <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums font-semibold">
                      {inr(e.ledger.charged / 100)}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-slate-500">
                      {e.ledger.paid ? inr(e.ledger.paid / 100) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums font-semibold">
                      {balance > 0
                        ? <span className="text-red-500">{inr(balance)}</span>
                        : balance < 0
                          ? <span className="text-amber-600">Credit {inr(-balance)}</span>
                          : <span className="text-emerald-600">Paid up</span>}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <button
                        onClick={() => setPayingFor({
                          enrollmentId: e.id,
                          student: { name: e.full_name, admissionNo: e.admission_no,
                                     classLabel: `${e.class_name}-${e.section_name}` },
                        })}
                        className={balance > 0
                          ? "text-xs font-bold rounded-lg px-3 py-2 bg-brand-600 text-white hover:bg-brand-700 whitespace-nowrap flex items-center gap-1.5 ml-auto"
                          : "text-xs font-bold rounded-lg px-3 py-2 border border-slate-200 text-slate-500 hover:border-slate-300 whitespace-nowrap flex items-center gap-1.5 ml-auto"}>
                        <Wallet size={13} /> {balance > 0 ? "Collect" : "View"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {payingFor && (
        <PaymentModal enrollmentId={payingFor.enrollmentId} student={payingFor.student}
          onClose={() => { setPayingFor(null); refetch(); }} onPaid={() => {}} />
      )}
    </div>
  );
}

// Maps the backend's getReceiptData response onto the shape
// downloadReceipt (receipt.js) already expects — built for the old flat
// payment-snapshot object, not the backend's normalised ledger response.
// Paise -> rupees happens here, once, at the boundary.
function adaptReceiptData(data) {
  return {
    receiptNo: data.docNo,
    receivedOn: data.docDate,
    studentName: data.student.fullName,
    admissionNo: data.student.admissionNo,
    classAtPayment: data.classLabel,
    year: data.academicYear,
    feeLines: data.lines.map((l) => ({ name: l.name, amount: l.amountPaise / 100 })),
    priorPayments: data.priorPayments.map((p) => ({
      receiptNo: p.receiptNo, receivedOn: p.receivedOn, amount: p.amountPaise / 100,
    })),
    grossAtPayment: data.grossPaise / 100,
    concessionAtPayment: data.concessionPaise / 100,
    netAtPayment: data.netPaise / 100,
    amount: data.totalPaise / 100,
    balanceAfterAtPayment: data.balanceAfterPaise / 100,
    mode: data.mode,
    reference: data.instrumentRef,
    collectedBy: data.collectedBy,
  };
}

export function PaymentModal({ enrollmentId, student, onClose, onPaid }) {
  const [ledger, setLedger] = useState(null); // {charged, conceded, paid, balance}, paise
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);

  async function refetch() {
    const [ledgerResult, paymentsResult] = await Promise.all([
      api.get(`/students/enrollments/${enrollmentId}/ledger`),
      api.get(`/collection/enrollments/${enrollmentId}/payments`),
    ]);
    setLedger(ledgerResult);
    setPayments(paymentsResult);
    setLoading(false);
  }
  useEffect(() => { refetch(); }, [enrollmentId]); // eslint-disable-line

  const rawBalance = ledger ? ledger.balance / 100 : 0; // rupees, for display and the amount field
  const dueNow = Math.max(0, rawBalance);

  const [amount, setAmount] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [mode, setMode] = useState("cash");
  const [reference, setReference] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [justRecorded, setJustRecorded] = useState(null);

  // Applying or changing a concession changes what's owed — keep the
  // amount field tracking that automatically, right up until the office
  // starts typing their own figure into it.
  const prevDueNow = useRef(dueNow);
  useEffect(() => {
    if (prevDueNow.current !== dueNow) {
      prevDueNow.current = dueNow;
      if (!amountTouched) setAmount(dueNow ? String(dueNow) : "");
    }
  }, [dueNow]); // eslint-disable-line

  async function record() {
    setError("");
    const amt = Math.round(parseFloat(amount) || 0);
    if (!(amt > 0)) return setError("Enter an amount greater than zero.");
    if (amt > rawBalance) return setError(`That's more than the balance of ₹${inr(rawBalance)}.`);

    setBusy(true);
    try {
      const payment = await api.post("/collection/payments", {
        enrollment_id: enrollmentId, amount: amt * 100, mode, instrument_ref: reference.trim(),
      });
      const receiptData = await api.get(`/collection/payments/${payment.id}/receipt-data`);
      const adapted = adaptReceiptData(receiptData);
      downloadReceipt({ school: receiptData.school, payment: adapted, duplicate: false });
      setJustRecorded(adapted);
      setAmount(""); setAmountTouched(false); setReference("");
      await refetch();
      if (onPaid) onPaid();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record that payment.");
    } finally {
      setBusy(false);
    }
  }

  async function reprint(paymentId) {
    try {
      const receiptData = await api.get(`/collection/payments/${paymentId}/receipt-data`);
      downloadReceipt({ school: receiptData.school, payment: adaptReceiptData(receiptData), duplicate: true });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not fetch that receipt.");
    }
  }

  if (loading) {
    return (
      <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center p-4 z-50">
        <div className={`${panel} w-full max-w-lg p-10 text-center text-slate-400`}>Loading…</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center p-4 z-50"
      onClick={onClose}>
      <div className={`${panel} w-full max-w-lg max-h-[88vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-slate-100 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-extrabold">{student.name}</h2>
            <p className="text-sm text-slate-500">
              {student.admissionNo} · {student.classLabel}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 shrink-0">
            <X size={20} />
          </button>
        </div>

        <ConcessionEditor enrollmentId={enrollmentId} grossPaise={ledger.charged}
          transportPaise={0} onChanged={refetch} />

        <div className="px-6 py-5 grid grid-cols-3 gap-4 border-b border-slate-100 text-sm">
          <div>
            <p className="eyebrow text-slate-400">Net payable</p>
            <p className="text-lg font-extrabold tabular-nums mt-1">
              {inr((ledger.charged - ledger.conceded) / 100)}
            </p>
          </div>
          <div>
            <p className="eyebrow text-slate-400">Paid so far</p>
            <p className="text-lg font-extrabold tabular-nums mt-1 text-emerald-600">
              {inr(ledger.paid / 100)}
            </p>
          </div>
          <div>
            <p className="eyebrow text-slate-400">Balance</p>
            <p className={`text-lg font-extrabold tabular-nums mt-1 ${
              rawBalance > 0 ? "text-red-500" : rawBalance < 0 ? "text-amber-600" : "text-emerald-600"}`}>
              {rawBalance > 0 ? inr(rawBalance) : rawBalance < 0 ? `Credit ${inr(-rawBalance)}` : "Paid up"}
            </p>
          </div>
        </div>

        {justRecorded && (
          <div className="mx-6 mt-5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl px-4 py-3 text-sm font-semibold">
            Recorded {justRecorded.receiptNo} for {inr(justRecorded.amount)}. The receipt PDF
            has started downloading.
          </div>
        )}

        {dueNow > 0 ? (
          <div className="px-6 py-5">
            <label className={eyebrow}>Amount received</label>
            <input inputMode="numeric" value={amount} disabled={busy}
              onChange={(e) => { setAmount(e.target.value); setAmountTouched(true); }}
              className="w-full mt-2 border-2 border-slate-200 focus:border-brand-500 rounded-xl px-3.5 py-3 text-xl font-extrabold tabular-nums outline-none" />
            <div className="flex gap-2 mt-2">
              <button onClick={() => { setAmount(String(dueNow)); setAmountTouched(false); }}
                className="text-xs font-bold rounded-lg px-3 py-1.5 border border-slate-200 text-slate-500 hover:border-brand-300">
                Full balance {inr(dueNow)}
              </button>
              <button onClick={() => { setAmount(""); setAmountTouched(true); }}
                className="text-xs font-bold rounded-lg px-3 py-1.5 border border-slate-200 text-slate-500 hover:border-brand-300">
                Clear
              </button>
            </div>

            <label className={`${eyebrow} block mt-4`}>Payment mode</label>
            <div className="grid grid-cols-3 gap-2 mt-2">
              {PAYMENT_MODES.map((m) => (
                <button key={m.id} onClick={() => setMode(m.id)}
                  className={`text-sm font-bold rounded-xl px-3 py-2.5 border-2 transition ${
                    mode === m.id ? "bg-brand-50 border-brand-400 text-brand-700"
                                  : "bg-white border-slate-200 text-slate-600 hover:border-brand-300"}`}>
                  {m.label}
                </button>
              ))}
            </div>

            <label className={`${eyebrow} block mt-4`}>
              Reference <span className="normal-case text-slate-400">(UPI ID, cheque no., last 4 of card — optional)</span>
            </label>
            <input value={reference} onChange={(e) => setReference(e.target.value)}
              className={`${field} mt-2`} />

            {amount && Math.round(parseFloat(amount) || 0) > 0 && (
              <p className="text-xs text-slate-400 italic mt-3">
                {amountInWords(Math.round(parseFloat(amount) || 0))}
              </p>
            )}

            {error && (
              <div className="mt-3 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm font-semibold">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
              </div>
            )}

            <button onClick={record} disabled={busy} className={`${primary} w-full justify-center mt-4`}>
              <Wallet size={16} /> {busy ? "Recording…" : "Record payment & download receipt"}
            </button>
          </div>
        ) : (
          <div className="px-6 py-5">
            <div className={`${rawBalance < 0 ? "bg-amber-50 border-amber-200 text-amber-800" : "bg-emerald-50 border-emerald-200 text-emerald-800"} border rounded-xl px-4 py-3 text-sm font-semibold`}>
              {rawBalance < 0
                ? `This student has a credit of ₹${inr(-rawBalance)} — nothing left to collect this year.`
                : "Fees settled in full for this academic year."}
            </div>
          </div>
        )}

        {payments.length > 0 && (
          <div className="px-6 py-5 border-t border-slate-100">
            <h3 className="eyebrow text-slate-400 flex items-center gap-1.5 mb-3">
              <History size={13} /> Payment history
            </h3>
            <ul className="divide-y divide-slate-50">
              {payments.map((p) => (
                <li key={p.id} className="py-2.5 flex items-center justify-between gap-3 text-sm">
                  <div>
                    <p className="font-bold">{inr(p.amount / 100)}
                      <span className="font-normal text-slate-400"> · {p.mode === "cash" ? "Cash" :
                        p.mode === "upi" ? "UPI" : p.mode === "card" ? "Card" :
                        p.mode === "netbanking" ? "Net banking" : "Cheque"}</span>
                    </p>
                    <p className="eyebrow text-slate-400 mt-0.5">
                      {p.receipt_no} · {displayDate(p.received_on)}
                    </p>
                  </div>
                  <button onClick={() => reprint(p.id)}
                    className="text-xs font-bold rounded-lg px-3 py-1.5 border border-slate-200 text-slate-500 hover:border-brand-300 flex items-center gap-1.5 shrink-0">
                    <Download size={13} /> PDF
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

const ROLE_LABEL = {
  owner: "Owner", accountant: "Accountant", front_desk: "Front desk", viewer: "Viewer",
};
const ROLE_DESCRIPTION = {
  owner: "Full access, including staff and billing",
  accountant: "Fees, concessions, admissions, reports",
  front_desk: "Admissions, payments — no concessions or staff",
  viewer: "Read-only across the school",
};

/**
 * Staff access — invite, change role, revoke/reactivate. This whole
 * screen is only reachable by an owner (manage_staff is owner-only on
 * the backend; the sidebar itself hides the nav entry for anyone else),
 * so there's no separate in-screen permission check needed here beyond
 * what the API already enforces.
 */
export function StaffScreen({ currentUserId }) {
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState(null);

  async function refetch() {
    setLoading(true);
    try {
      setStaff(await api.get("/staff"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load staff.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refetch(); }, []); // eslint-disable-line

  async function changeRole(member, role) {
    setBusyId(member.id);
    try {
      await api.patch(`/staff/${member.id}`, { role });
      await refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not change that role.");
    } finally {
      setBusyId(null);
    }
  }

  async function toggleActive(member) {
    setBusyId(member.id);
    try {
      await api.patch(`/staff/${member.id}`, { is_active: !member.is_active });
      await refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not update that access.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <PageHead title="Staff Access"
        subtitle="Who can sign in to this school's portal, and what they can do once they're in.">
        <button className={primary} onClick={() => setInviting(true)}>
          <UserPlus size={16} /> Invite staff
        </button>
      </PageHead>

      {error && (
        <div className="mb-5 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-2xl px-5 py-4 text-sm font-semibold">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {inviting && (
        <InviteStaffPanel onDone={() => { setInviting(false); refetch(); }}
          onCancel={() => setInviting(false)} />
      )}

      <div className={`${panel} overflow-hidden`}>
        {loading ? (
          <div className="p-12 text-center text-slate-400 font-semibold">Loading…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead className="bg-slate-50/70">
                <tr>
                  <th className={th}>Person</th>
                  <th className={th}>Role</th>
                  <th className={th}>Access</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody>
                {staff.map((m) => {
                  const isSelf = m.user_id === currentUserId;
                  const busy = busyId === m.id;
                  return (
                    <tr key={m.id} className="border-b border-slate-50 text-sm">
                      <td className="px-5 py-3">
                        <div className="font-bold">{m.full_name || m.email}</div>
                        <div className="text-xs text-slate-400">{m.email}</div>
                      </td>
                      <td className="px-5 py-3">
                        {isSelf ? (
                          <span className="text-sm font-bold">{ROLE_LABEL[m.role]}</span>
                        ) : (
                          <select value={m.role} disabled={busy}
                            onChange={(e) => changeRole(m, e.target.value)}
                            className={`${cellInput} border-slate-200 font-semibold`}>
                            {Object.keys(ROLE_LABEL).map((r) => (
                              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                            ))}
                          </select>
                        )}
                        <p className="text-[11px] text-slate-400 mt-1 max-w-[220px]">
                          {ROLE_DESCRIPTION[m.role]}
                        </p>
                      </td>
                      <td className="px-5 py-3">
                        {m.is_active ? (
                          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1">
                            <Check size={12} /> Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-400 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1">
                            Revoked
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right">
                        {isSelf ? (
                          <span className="text-xs font-semibold text-slate-300">That's you</span>
                        ) : (
                          <button disabled={busy} onClick={() => toggleActive(m)}
                            className={m.is_active
                              ? "text-xs font-bold rounded-lg px-3 py-2 border border-slate-200 text-slate-500 hover:border-red-300 hover:text-red-500 whitespace-nowrap disabled:opacity-50"
                              : "text-xs font-bold rounded-lg px-3 py-2 bg-brand-600 text-white hover:bg-brand-700 whitespace-nowrap disabled:opacity-50"}>
                            {busy ? "Working…" : m.is_active ? "Revoke access" : "Reactivate"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function InviteStaffPanel({ onDone, onCancel }) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("front_desk");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api.post("/staff", { email: email.trim(), full_name: fullName.trim(), role });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send that invite.");
      setBusy(false);
    }
  }

  return (
    <div className={`${panel} p-6 mb-5`}>
      <h2 className="font-extrabold mb-1">Invite someone new</h2>
      <p className="text-sm text-slate-500 mb-4">
        They'll get an email with a link to set their own password — nothing to share over
        phone or chat.
      </p>
      {error && (
        <div className="mb-4 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm font-semibold">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
      <form onSubmit={submit} className="grid sm:grid-cols-2 gap-4">
        <div>
          <label className={eyebrow}>Email<span className="text-red-500"> *</span></label>
          <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            className={`${field} mt-2`} placeholder="accountant@school.edu.in" />
        </div>
        <div>
          <label className={eyebrow}>Name</label>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)}
            className={`${field} mt-2`} placeholder="Optional" />
        </div>
        <div className="sm:col-span-2">
          <label className={eyebrow}>Role</label>
          <div className="grid sm:grid-cols-4 gap-2 mt-2">
            {Object.keys(ROLE_LABEL).map((r) => (
              <button key={r} type="button" onClick={() => setRole(r)}
                className={`text-left rounded-xl border-2 px-3 py-2.5 transition ${
                  role === r ? "bg-brand-50 border-brand-400" : "bg-white border-slate-200 hover:border-brand-300"}`}>
                <span className="block text-sm font-bold">{ROLE_LABEL[r]}</span>
                <span className="block text-[11px] text-slate-400 mt-0.5">{ROLE_DESCRIPTION[r]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="sm:col-span-2 flex gap-2.5">
          <button type="submit" disabled={busy} className={primary}>
            <Mail size={16} /> {busy ? "Sending…" : "Send invite"}
          </button>
          <button type="button" className={ghost} onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
