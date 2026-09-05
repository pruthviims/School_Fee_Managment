import React, { useEffect, useState } from "react";
import {
  Bus,
  ChevronDown,
  FileSpreadsheet,
  LogOut,
  Percent,
  ReceiptIndianRupee,
  RefreshCw,
  School,
  Sparkles,
  UserPlus,
} from "lucide-react";
import { Login, Setup } from "./Auth";
import { api } from "./api";
import {
  ConcessionScreen,
  FeeScreen,
  FilterSelect,
  ImportScreen,
  NewAdmissionTab,
  PromoteTab,
  QuickBalanceSearch,
  SchoolScreen,
  TransportScreen,
} from "./Screens";
import { CLASSES, TRANSPORT_ID } from "./lib";

const KEY = "school-fee-admin-v3";

const TUITION_BY_STAGE = {
  "Pre-primary": 24000, Primary: 32000, Middle: 40000,
  Secondary: 52000, "Pre-university": 68000,
};

let seq = 0;
const uid = () => `id${Date.now().toString(36)}${(seq += 1)}`;

function defaultComponents(stage) {
  const annual = TUITION_BY_STAGE[stage];
  const per = Math.round(annual / 3);
  const rows = [
    { id: uid(), name: "Tuition fee", terms: [per, per, annual - 2 * per], oneTime: false },
    { id: uid(), name: "Development fee", terms: [4000, 0, 0], oneTime: false },
    { id: uid(), name: "Library fee", terms: [800, 0, 0], oneTime: false },
    { id: uid(), name: "Exam fee", terms: [0, 1500, 0], oneTime: false },
    { id: uid(), name: "Admission fee", terms: [15000, 0, 0], oneTime: true },
  ];
  if (["Middle", "Secondary", "Pre-university"].includes(stage))
    rows.splice(3, 0, { id: uid(), name: "Computer fee", terms: [2500, 0, 0], oneTime: false });
  if (stage === "Pre-university")
    rows.splice(3, 0, { id: uid(), name: "Lab fee", terms: [9000, 0, 0], oneTime: false });
  // Transport belongs to every class; the amount comes from the child's stop.
  rows.push({ id: TRANSPORT_ID, name: "Transport fee", terms: [0, 0, 0], oneTime: false });
  return rows;
}

function freshWorkspace(school) {
  const structure = {};
  for (const c of CLASSES) structure[c.name] = defaultComponents(c.stage);
  return { school, year: "2026-27", structure, routes: [], students: [], payments: [] };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Students saved before per-year tagging existed have no `year` field.
    // Backfill them to whatever year was active when they were saved, so
    // year-based filtering elsewhere never silently drops old data.
    if (parsed?.students?.some((s) => !s.year)) {
      parsed.students = parsed.students.map((s) => ({ ...s, year: s.year || parsed.year }));
    }
    // Payments didn't exist before receipt collection was added.
    if (!Array.isArray(parsed.payments)) parsed.payments = [];
    return parsed;
  } catch {
    /* unreadable storage falls through to a fresh start */
  }
  return null;
}

// Bus Routes and Fee Structure share one sidebar entry — routes have to
// exist before a fare can be attached to a class, so keeping them one click
// apart makes that dependency obvious rather than splitting it across the
// sidebar. Fees Setup only has two sub-screens, so a top-of-page pill bar
// suits it; Admissions & Fees has four and gets its own expandable section
// in the sidebar instead, with more room to breathe.
const NAV = [
  { id: "school", label: "School Profile", Icon: School },
  { id: "feesSetup", label: "Fees Setup", Icon: ReceiptIndianRupee,
    group: ["transport", "fees"] },
];

// Screens where the working Academic Year actually matters. School Profile
// manages the year as school metadata via its own field. New Admission and
// Promote Students have their own contextual year controls built into the
// page (From/To, or "Admitting into") rather than the shared top-bar one,
// to avoid two year pickers on the same screen.
const YEAR_SCOPED_STEPS = new Set(["transport", "fees", "roll", "bulkimport"]);

const FEES_SUBTABS = [
  { id: "transport", label: "Bus Routes", Icon: Bus },
  { id: "fees", label: "Fee Structure", Icon: ReceiptIndianRupee },
];

// Workflow order for an admission season: bring in last year's roll, move
// continuing students up, register anyone new, then take payments — not
// the same as the default landing tab, which stays the day-to-day screen
// (Fee Collection) regardless of where it sits in this list.
const STUDENTS_SUBTABS = [
  { id: "bulkimport", label: "First Time Import", Icon: FileSpreadsheet },
  { id: "promote", label: "Class Promotion", Icon: Sparkles },
  { id: "newadm", label: "New Admission", Icon: UserPlus },
  { id: "roll", label: "Fee Collection", Icon: Percent },
];
// Indian academic year: roughly June to March. Used only to seed a
// sensible first year automatically when a school has none yet — after
// that, every year comes from the real backend, never computed locally.
function defaultAcademicYearRange(today = new Date()) {
  const month = today.getMonth(); // 0-indexed
  const startYear = month >= 4 ? today.getFullYear() : today.getFullYear() - 1;
  const endYear = startYear + 1;
  return {
    name: `${startYear}-${String(endYear).slice(-2)}`,
    starts_on: `${startYear}-06-01`,
    ends_on: `${endYear}-03-31`,
  };
}

const DEFAULT_STUDENTS_STEP = "roll";

const ROLE_LABEL = {
  owner: "Owner", accountant: "Accountant", front_desk: "Front desk", viewer: "Viewer",
};

// Builds the shape the rest of the app already expects state.school to
// have (name/address/adminName/adminEmail/code) from the real API's
// response shape (school/user separate, membership carrying the role).
// adminName/adminEmail now mean "whoever is actually signed in" rather
// than a single fixed school-admin account, since real accounts mean
// more than one person can hold them.
function schoolFromSession(me) {
  return {
    name: me.school.name,
    address: me.school.address,
    code: me.school.short_code,
    logo: "", // logo_key isn't a servable URL yet — no object storage wired up
    adminName: me.full_name || me.email,
    adminEmail: me.email,
    role: me.membership?.role,
  };
}

export default function App() {
  const [state, setState] = useState(load);
  const [signedIn, setSignedIn] = useState(false);
  // Briefly true on first load while a real session cookie is checked —
  // without this, a page refresh with a valid session would flash the
  // login screen before the /me check comes back.
  const [checkingSession, setCheckingSession] = useState(true);
  const [showSetup, setShowSetup] = useState(false);
  const [step, setStep] = useState("transport");
  // Sidebar accordion for Admissions & Fees — separate from `step` itself
  // so collapsing it doesn't navigate away from whatever sub-screen is
  // currently open.
  const [studentsExpanded, setStudentsExpanded] = useState(false);
  // The real, backend-backed list of academic years for this school —
  // never persisted locally, always fetched fresh, since these are the
  // first genuinely shared, multi-user data this app manages. state.year
  // stays a plain name string (e.g. "2026-27") for the rest of the app,
  // still localStorage-backed, to keep every other screen working
  // unchanged until each of them is wired up in turn.
  const [academicYears, setAcademicYears] = useState([]);

  // Same idea as academicYears: real, backend-backed, never persisted
  // locally. Seeded once from the same canonical ladder the app already
  // hardcoded in lib.js, so a brand-new school's Fee Structure screen
  // looks identical to before — the classes just come from real rows now.
  const [classLevels, setClassLevels] = useState([]);
  const [feeHeads, setFeeHeads] = useState([]);

  const STAGE_MAP = {
    "Pre-primary": "pre_primary", Primary: "primary", Middle: "middle",
    Secondary: "secondary", "Pre-university": "puc",
  };

  async function ensureClassLevelsAndFeeHeads() {
    let levels = await api.get("/setup/class-levels");
    if (levels.length === 0) {
      levels = [];
      for (let i = 0; i < CLASSES.length; i++) {
        const c = CLASSES[i];
        levels.push(await api.post("/setup/class-levels", {
          name: c.name, ladder_order: i + 1, stage: STAGE_MAP[c.stage],
          requires_stream: c.name === "1st PU" || c.name === "2nd PU",
          requires_explicit_optin: c.name === "1st PU",
          is_terminal: c.name === "2nd PU",
        }));
      }
    }
    setClassLevels(levels);

    let heads = await api.get("/setup/fee-heads");
    if (heads.length === 0) {
      const defaults = [
        { name: "Tuition fee", display_order: 1 },
        { name: "Admission fee", is_one_time: true, display_order: 2 },
        { name: "Development fee", display_order: 3 },
        { name: "Library fee", display_order: 4 },
        { name: "Exam fee", display_order: 5 },
      ];
      heads = [];
      for (const d of defaults) heads.push(await api.post("/setup/fee-heads", d));
    }
    setFeeHeads(heads);
  }

  async function refreshFeeHeads() {
    setFeeHeads(await api.get("/setup/fee-heads"));
  }

  // Section isn't asked at admission time by design (assigned later once
  // class rosters are settled), but the backend's enrollments.section_id
  // is required — so every class/year gets one real, very-high-capacity
  // "Unassigned" section to admit into, created once and reused, rather
  // than asking for a real section up front and losing that deferred
  // workflow the screen was built around.
  async function ensureUnassignedSection(classLevelId, academicYearId) {
    const sections = await api.get(
      `/setup/sections?academic_year_id=${academicYearId}`);
    const existing = sections.find((s) => s.class_level_id === classLevelId && s.name === "Unassigned");
    if (existing) return existing.id;
    const created = await api.post("/setup/sections", {
      academic_year_id: academicYearId, class_level_id: classLevelId,
      name: "Unassigned", capacity: 9999,
    });
    return created.id;
  }

  // Fetches the school's real academic years, creating a sensible first
  // one automatically if none exist yet — the same zero-friction default
  // freshWorkspace() used to hardcode, now actually persisted.
  async function ensureAcademicYears() {
    let years = await api.get("/setup/academic-years");
    if (years.length === 0) {
      const seed = defaultAcademicYearRange();
      const created = await api.post("/setup/academic-years", { ...seed, status: "active" });
      years = [created];
    }
    setAcademicYears(years);
    return years;
  }

  function pickCurrentYearName(years) {
    const today = new Date().toISOString().slice(0, 10);
    const current = years.find((y) =>
      String(y.starts_on).slice(0, 10) <= today && today <= String(y.ends_on).slice(0, 10));
    if (current) return current.name;
    return [...years].sort((a, b) => (String(a.starts_on) < String(b.starts_on) ? 1 : -1))[0]?.name;
  }

  // Shared by setup, login, and session-restore: once we know who's
  // signed in, fetch (or seed) their real academic years and make sure
  // state.year actually matches one of them, rather than trusting
  // whatever freshWorkspace()'s hardcoded default guessed.
  async function afterAuthResolved(me, { fresh } = {}) {
    const school = schoolFromSession(me);
    setState((prev) => (fresh || !prev) ? freshWorkspace(school) : { ...prev, school });
    const years = await ensureAcademicYears();
    const yearName = pickCurrentYearName(years);
    if (yearName) setState((prev) => (prev.year === yearName ? prev : { ...prev, year: yearName }));
    await ensureClassLevelsAndFeeHeads();
    setSignedIn(true);
  }

  // A single prompt for the start year is enough to compute a sensible
  // full range automatically — matching how ensureAcademicYears() seeds
  // the very first year, and avoiding a whole modal for one date field.
  async function handleYearChange(value) {
    if (value !== "__new__") return setState({ ...state, year: value });

    const suggested = Math.max(...academicYears.map((y) => Number(y.name.slice(0, 4)))) + 1 || new Date().getFullYear();
    const startYear = window.prompt("New academic year starts in which calendar year? (e.g. 2028)",
      String(suggested));
    if (!startYear || !/^\d{4}$/.test(startYear.trim())) return;

    const year = Number(startYear.trim());
    const seed = {
      name: `${year}-${String(year + 1).slice(-2)}`,
      starts_on: `${year}-06-01`, ends_on: `${year + 1}-03-31`, status: "planning",
    };
    try {
      const created = await api.post("/setup/academic-years", seed);
      setAcademicYears((prev) => [...prev, created]);
      setState({ ...state, year: created.name });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not create that academic year.");
    }
  }

  useEffect(() => {
    if (!state) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* private browsing: the session works, it just will not persist */
    }
  }, [state]);

  // Restore a real session on first load, so a page refresh doesn't sign
  // anyone out. The fee/student data underneath (still localStorage-only
  // for now — see the note on `state`) genuinely doesn't follow an
  // account to a new device yet; this only restores who's signed in.
  useEffect(() => {
    let cancelled = false;
    api.get("/auth/me")
      .then(async (me) => {
        if (cancelled) return;
        await afterAuthResolved(me);
      })
      .catch(() => { /* no valid session — show the login screen */ })
      .finally(() => { if (!cancelled) setCheckingSession(false); });
    return () => { cancelled = true; };
  }, []);

  async function handleSetup(fields) {
    const me = await api.post("/auth/bootstrap-school", fields);
    // Always a clean start — this is explicitly "create a new school",
    // never a reason to reuse whatever a previous, unrelated session left
    // in this browser's storage.
    await afterAuthResolved(me, { fresh: true });
    setShowSetup(false);
    setStep("transport");
  }

  async function handleLogin(_schoolId, email, password) {
    const me = await api.post("/auth/login", { email, password });
    await afterAuthResolved(me);
    setStep("transport");
  }

  async function handleLogout() {
    try { await api.post("/auth/logout", {}); } catch { /* best-effort */ }
    setSignedIn(false);
  }

  if (checkingSession) {
    return (
      <div className="min-h-screen grid place-items-center text-slate-400 text-sm font-semibold">
        Loading…
      </div>
    );
  }

  if (showSetup)
    return <Setup onDone={handleSetup} canGoBack={signedIn} onBack={() => setShowSetup(false)} />;

  if (!signedIn)
    return <Login onLogin={handleLogin} onSetupClick={() => setShowSetup(true)} />;

  function reset() {
    if (!confirm("This clears the school, routes, fee structure and students. Continue?")) return;
    localStorage.removeItem(KEY);
    setState(null);
    handleLogout();
    setShowSetup(true);
  }

  const initial = (state.school.adminEmail || "A").charAt(0).toUpperCase();

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* ---------------- sidebar ---------------- */}
      <aside className="lg:w-[264px] shrink-0 bg-white border-b lg:border-b-0 lg:border-r border-slate-100 flex flex-col">
        <div className="px-6 pt-7 pb-5 text-center border-b border-slate-50">
          <div className="w-[86px] h-[86px] mx-auto rounded-2xl bg-white border border-slate-100 shadow-[0_6px_18px_-10px_rgba(15,23,41,0.3)] grid place-items-center text-[34px] leading-none">
            <span role="img" aria-hidden="true">🎓</span>
          </div>
          <p className="font-extrabold text-[15px] mt-4 leading-tight uppercase tracking-tight">
            {state.school.name}
          </p>
          <p className="eyebrow text-brand-600 mt-1.5">Fee Portal</p>
        </div>

        {/* Searches state.students, which stays empty for anyone admitted
            through the real backend now — a known gap until Quick Balance
            Check itself is wired to real enrollments. Selecting a result
            just goes to Fee Collection, where a real search still works. */}
        <QuickBalanceSearch state={state} onSelect={() => setStep("roll")} />

        <nav className="flex lg:flex-col overflow-x-auto px-3 pb-3 gap-1.5">
          {NAV.map((n) => {
            // A grouped item is "on" if the current step is any of its
            // sub-steps, so Fees Setup stays highlighted on both sub-tabs.
            const on = n.group ? n.group.includes(step) : step === n.id;
            return (
              <button key={n.id}
                onClick={() => setStep(n.group ? (n.group.includes(step) ? step : n.group[0]) : n.id)}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm whitespace-nowrap transition ${
                  on ? "bg-brand-600 text-white font-bold shadow-[0_10px_22px_-12px_rgba(91,61,245,1)]"
                     : "text-slate-500 font-semibold hover:bg-slate-50"}`}>
                <n.Icon size={17} className="shrink-0" />
                {n.label}
              </button>
            );
          })}

          {/* Admissions & Fees — an accordion in the sidebar itself rather
              than a top-of-page pill bar, since four sub-screens want more
              room than Fees Setup's two. */}
          {(() => {
            const studentsOn = STUDENTS_SUBTABS.some((t) => t.id === step);
            // Not `studentsExpanded || studentsOn` — every path that lands
            // on a sub-step already set studentsExpanded true on the way
            // in (step resets on every login, so there's no way to arrive
            // on a sub-step with it still false). Falling back to studentsOn
            // here would make the collapse toggle silently do nothing while
            // any of these sub-screens was active.
            const studentsOpen = studentsExpanded;
            return (
              <div>
                <button
                  onClick={() => {
                    if (!studentsOn) {
                      setStep(DEFAULT_STUDENTS_STEP);
                      setStudentsExpanded(true);
                    } else {
                      setStudentsExpanded((e) => !e);
                    }
                  }}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm whitespace-nowrap transition ${
                    studentsOn ? "bg-brand-600 text-white font-bold shadow-[0_10px_22px_-12px_rgba(91,61,245,1)]"
                               : "text-slate-500 font-semibold hover:bg-slate-50"}`}>
                  <Sparkles size={17} className="shrink-0" />
                  <span className="flex-1 text-left">Admissions & Fees</span>
                  <ChevronDown size={15}
                    className={`shrink-0 transition-transform ${studentsOpen ? "rotate-180" : ""}`} />
                </button>

                {studentsOpen && (
                  <div className="lg:mt-1 lg:ml-5 lg:pl-3 lg:border-l-2 lg:border-slate-100 flex lg:flex-col gap-1">
                    {STUDENTS_SUBTABS.map((t) => {
                      const subOn = step === t.id;
                      return (
                        <button key={t.id} onClick={() => setStep(t.id)}
                          className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left whitespace-nowrap transition ${
                            subOn ? "bg-brand-50 text-brand-700 font-bold"
                                  : "text-slate-500 font-medium hover:bg-slate-100"}`}>
                          <t.Icon size={15} className="shrink-0" />
                          {t.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
        </nav>

        <div className="mt-auto px-5 py-5 border-t border-slate-50 hidden lg:block">
          <p className="text-xs font-bold">{state.school.adminName}</p>
          <p className="eyebrow text-slate-400 mt-0.5">
            {ROLE_LABEL[state.school.role] || "Administrator"}
          </p>
          <button onClick={handleLogout}
            className="mt-3 text-xs font-semibold text-slate-400 hover:text-slate-700 flex items-center gap-1.5">
            <LogOut size={13} /> Sign out
          </button>
          <button onClick={reset} className="mt-2 text-xs font-semibold text-slate-300 hover:text-red-500 block">
            Clear everything
          </button>
        </div>
      </aside>

      {/* ---------------- main ---------------- */}
      <main className="flex-1 min-w-0 px-6 lg:px-10 py-7">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-8">
          <div className="flex flex-wrap items-center gap-3">
            <div className="bg-white rounded-full pl-4 pr-5 py-2.5 border border-slate-100 shadow-[0_1px_3px_rgba(15,23,41,0.04)] flex items-center gap-2.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              <span className="eyebrow text-slate-400">School Environment:</span>
              <span className="eyebrow text-brand-600">{state.school.name}</span>
            </div>

            {YEAR_SCOPED_STEPS.has(step) && (
              <FilterSelect value={state.year} active
                onChange={(e) => handleYearChange(e.target.value)}
                className="w-auto min-w-[110px]">
                {academicYears.map((y) => <option key={y.id} value={y.name}>{y.name}</option>)}
                <option value="__new__">+ Add academic year</option>
              </FilterSelect>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button className="eyebrow text-slate-400 hover:text-slate-600 flex items-center gap-1.5">
              <RefreshCw size={13} /> Sync Now
            </button>
            <div className="bg-white rounded-full pl-1.5 pr-5 py-1.5 border border-slate-100 shadow-[0_1px_3px_rgba(15,23,41,0.04)] flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-full bg-brand-600 text-white grid place-items-center font-bold text-sm">
                {initial}
              </span>
              <span className="eyebrow text-slate-500">{state.school.adminEmail}</span>
            </div>
          </div>
        </div>

        {step === "school" && <SchoolScreen state={state} save={setState} />}

        {(step === "transport" || step === "fees") && (
          <div className="mb-7 inline-flex bg-white rounded-xl border border-slate-100 p-1 shadow-[0_1px_3px_rgba(15,23,41,0.04)]">
            {FEES_SUBTABS.map((t) => {
              const on = step === t.id;
              return (
                <button key={t.id} onClick={() => setStep(t.id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition ${
                    on ? "bg-brand-600 text-white shadow-[0_6px_14px_-8px_rgba(91,61,245,0.9)]"
                       : "text-slate-500 hover:text-slate-700"}`}>
                  <t.Icon size={15} /> {t.label}
                </button>
              );
            })}
          </div>
        )}
        {step === "transport" && <TransportScreen state={state} save={setState} />}
        {step === "fees" && (
          <FeeScreen state={state} save={setState}
            classLevels={classLevels} feeHeads={feeHeads} academicYears={academicYears}
            refreshFeeHeads={refreshFeeHeads} />
        )}

        {step === "roll" && <ConcessionScreen academicYears={academicYears} state={state} />}
        {step === "newadm" && (
          <NewAdmissionTab state={state} save={setState}
            classLevels={classLevels} academicYears={academicYears}
            ensureUnassignedSection={ensureUnassignedSection} />
        )}
        {step === "bulkimport" && <ImportScreen state={state} save={setState} />}
        {step === "promote" && (
          <PromoteTab state={state} save={setState}
            academicYears={academicYears} classLevels={classLevels}
            ensureUnassignedSection={ensureUnassignedSection} />
        )}

        <p className="text-xs text-slate-400 mt-12 max-w-2xl leading-relaxed">
          A working prototype. Everything you enter stays in this browser — it is not
          sent anywhere and will not appear on another device.
        </p>
      </main>
    </div>
  );
}
