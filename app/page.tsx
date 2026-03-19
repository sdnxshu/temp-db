"use client";

import { IBM_Plex_Mono } from "next/font/google";
import {
    useState,
    useEffect,
    useCallback,
    useRef,
    type ReactNode,
} from "react";

// ─── Font ─────────────────────────────────────────────────────────────────────

const mono = IBM_Plex_Mono({
    subsets: ["latin"],
    weight: ["400", "500", "600"],
    variable: "--font-mono",
});

// ─── Types ────────────────────────────────────────────────────────────────────

type DBType = "postgres" | "mysql";
type Status = "running" | "stopped" | "error";
type NavTab = "instances" | "queue" | "logs";
type FilterKey = "all" | Status;

interface Instance {
    id: string;
    containerId: string;
    dbType: DBType;
    host: string;
    port: number;
    dbName: string;
    dbUser: string;
    dbPassword: string;
    ttl: number;
    status: Status;
    createdAt: Date;
    expiresAt: Date;
    destroyedAt?: Date;
}

// ─── Seed data ────────────────────────────────────────────────────────────────

function makeSeed(): Instance[] {
    const n = Date.now();
    return [
        {
            id: "a3f8b1c2", containerId: "sha256:1a2b3c4d5e6f",
            dbType: "postgres", host: "localhost", port: 54321,
            dbName: "db_a3f8b1c2", dbUser: "pguser", dbPassword: "s3cr3t_pg_01",
            ttl: 3600, status: "running",
            createdAt: new Date(n - 12 * 60 * 1000),
            expiresAt: new Date(n + 3547 * 1000),
        },
        {
            id: "e7d2f490", containerId: "sha256:4d5e6f7a8b9c",
            dbType: "mysql", host: "localhost", port: 33061,
            dbName: "db_e7d2f490", dbUser: "mysqluser", dbPassword: "s3cr3t_my_02",
            ttl: 1800, status: "running",
            createdAt: new Date(n - 28 * 60 * 1000),
            expiresAt: new Date(n + 572 * 1000),
        },
        {
            id: "b91c3e05", containerId: "sha256:7g8h9i0j1k2l",
            dbType: "postgres", host: "localhost", port: 54322,
            dbName: "db_b91c3e05", dbUser: "pguser", dbPassword: "pw_b91c3e05",
            ttl: 7200, status: "running",
            createdAt: new Date(n - 4 * 60 * 1000),
            expiresAt: new Date(n + 7055 * 1000),
        },
        {
            id: "c04a7f11", containerId: "sha256:jk01lm23no45",
            dbType: "mysql", host: "localhost", port: 33062,
            dbName: "db_c04a7f11", dbUser: "mysqluser", dbPassword: "pw_c04a7f11",
            ttl: 900, status: "stopped",
            createdAt: new Date(n - 2 * 60 * 60 * 1000),
            expiresAt: new Date(n - 90 * 60 * 1000),
            destroyedAt: new Date(n - 90 * 60 * 1000),
        },
        {
            id: "f5e88212", containerId: "sha256:no23pq45rs67",
            dbType: "postgres", host: "localhost", port: 54323,
            dbName: "db_f5e88212", dbUser: "pguser", dbPassword: "pw_f5e88212",
            ttl: 3600, status: "error",
            createdAt: new Date(n - 5 * 60 * 60 * 1000),
            expiresAt: new Date(n - 60 * 60 * 1000),
        },
    ];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtAge(d: Date): string {
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
}

function fmtRemaining(secs: number): string {
    if (secs <= 0) return "0s";
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
    return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function getRemaining(inst: Instance): number | null {
    if (inst.status !== "running") return null;
    return Math.max(0, Math.floor((inst.expiresAt.getTime() - Date.now()) / 1000));
}

function getTtlPct(inst: Instance): number {
    const elapsed = Date.now() - inst.createdAt.getTime();
    return Math.max(0, Math.min(100, 100 - (elapsed / (inst.ttl * 1000)) * 100));
}

function barColor(pct: number): string {
    if (pct > 40) return "var(--green)";
    if (pct > 15) return "var(--warn)";
    return "var(--red)";
}

function connStr(inst: Instance): string {
    const scheme = inst.dbType === "postgres" ? "postgresql" : "mysql";
    const pw = encodeURIComponent(inst.dbPassword);
    return `${scheme}://${inst.dbUser}:${pw}@${inst.host}:${inst.port}/${inst.dbName}`;
}

function randId(): string {
    return Math.random().toString(36).slice(2, 10);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Blink({ children }: { children: ReactNode }) {
    return <span style={{ animation: "blink 1.1s step-end infinite" }}>{children}</span>;
}

function Badge({ status }: { status: Status }) {
    const cfg: Record<Status, { dot: string; text: string; bg: string; border: string }> = {
        running: { dot: "var(--green)", text: "var(--green)", bg: "rgba(0,255,135,0.1)", border: "rgba(0,255,135,0.25)" },
        stopped: { dot: "var(--dim)", text: "var(--dim)", bg: "rgba(255,255,255,0.04)", border: "rgba(255,255,255,0.08)" },
        error: { dot: "var(--warn)", text: "var(--warn)", bg: "rgba(255,170,0,0.1)", border: "rgba(255,170,0,0.25)" },
    };
    const c = cfg[status];
    return (
        <span style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase",
            padding: "3px 7px", color: c.text,
            background: c.bg, border: `1px solid ${c.border}`,
        }}>
            <span style={{
                width: 5, height: 5, borderRadius: "50%", background: c.dot, flexShrink: 0,
                ...(status === "running" ? { animation: "pulse 2s infinite" } : {}),
            }} />
            {status}
        </span>
    );
}

function DbTag({ type }: { type: DBType }) {
    return (
        <span style={{
            fontSize: 10, letterSpacing: "0.04em", textTransform: "uppercase",
            padding: "2px 6px", border: "1px solid var(--border-bright)",
            color: "var(--dim)",
        }}>
            {type}
        </span>
    );
}

function TtlBar({ inst }: { inst: Instance }) {
    const rem = getRemaining(inst);
    if (rem === null) return <span style={{ color: "var(--muted)", fontSize: 10 }}>—</span>;
    const pct = getTtlPct(inst);
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 64, height: 3, background: "var(--border)", position: "relative", flexShrink: 0 }}>
                <div style={{
                    position: "absolute", left: 0, top: 0, height: "100%",
                    width: `${pct.toFixed(0)}%`, background: barColor(pct),
                }} />
            </div>
            <span style={{ fontSize: 10, color: "var(--dim)", minWidth: 40 }}>
                {fmtRemaining(rem)}
            </span>
        </div>
    );
}

// ─── Modal primitives ─────────────────────────────────────────────────────────

function Modal({ onClose, title, children }: {
    onClose: () => void;
    title: string;
    children: ReactNode;
}) {
    return (
        <div
            onClick={(e) => e.target === e.currentTarget && onClose()}
            style={{
                position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)",
                display: "flex", alignItems: "center", justifyContent: "center",
                zIndex: 200, animation: "fadeIn 0.1s ease",
            }}
        >
            <div style={{
                background: "var(--surface)", border: "1px solid var(--border-bright)",
                width: 360, padding: 24,
            }}>
                <div style={{
                    fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase",
                    color: "var(--text)", marginBottom: 18, fontWeight: 600,
                }}>
          // {title}
                </div>
                {children}
            </div>
        </div>
    );
}

function ModalFooter({ onCancel, onConfirm, confirmLabel, danger }: {
    onCancel: () => void;
    onConfirm: () => void;
    confirmLabel: string;
    danger?: boolean;
}) {
    return (
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button onClick={onCancel} style={{
                flex: 1, fontFamily: "inherit", fontSize: 11, textTransform: "uppercase",
                letterSpacing: "0.05em", background: "none",
                border: "1px solid var(--border-bright)", color: "var(--dim)",
                padding: 8, cursor: "pointer",
            }}>
                Cancel
            </button>
            <button onClick={onConfirm} style={{
                flex: 1, fontFamily: "inherit", fontSize: 11, textTransform: "uppercase",
                letterSpacing: "0.06em", fontWeight: 600,
                background: danger ? "var(--red)" : "var(--green)",
                border: "none", color: "#000", padding: 8, cursor: "pointer",
            }}>
                {confirmLabel}
            </button>
        </div>
    );
}

function FieldLabel({ children }: { children: ReactNode }) {
    return (
        <label style={{
            display: "block", fontSize: 10, color: "var(--dim)",
            textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6,
        }}>
            {children}
        </label>
    );
}

function ModalInput({
    type = "text", value, onChange, min, max,
}: {
    type?: string;
    value: string | number;
    onChange: (v: string) => void;
    min?: number;
    max?: number;
}) {
    return (
        <input
            type={type}
            value={value}
            min={min}
            max={max}
            onChange={(e) => onChange(e.target.value)}
            style={{
                width: "100%", fontFamily: "inherit", fontSize: 12,
                background: "var(--bg)", border: "1px solid var(--border-bright)",
                color: "var(--text)", padding: "8px 10px", marginBottom: 14,
                outline: "none",
            }}
            onFocus={(e) => (e.target.style.borderColor = "var(--green)")}
            onBlur={(e) => (e.target.style.borderColor = "var(--border-bright)")}
        />
    );
}

function ModalSelect({
    value, onChange, options,
}: {
    value: string;
    onChange: (v: string) => void;
    options: { value: string; label: string }[];
}) {
    return (
        <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            style={{
                width: "100%", fontFamily: "inherit", fontSize: 12, appearance: "none",
                background: "var(--bg)", border: "1px solid var(--border-bright)",
                color: "var(--text)", padding: "8px 10px", marginBottom: 14,
                outline: "none", cursor: "pointer",
            }}
        >
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
    );
}

// ─── Create modal ─────────────────────────────────────────────────────────────

function CreateModal({ onClose, onCreate }: {
    onClose: () => void;
    onCreate: (dbType: DBType, ttl: number) => void;
}) {
    const [dbType, setDbType] = useState<DBType>("postgres");
    const [ttl, setTtl] = useState("3600");

    return (
        <Modal onClose={onClose} title="Spin Up Instance">
            <FieldLabel>Database Type</FieldLabel>
            <ModalSelect
                value={dbType}
                onChange={(v) => setDbType(v as DBType)}
                options={[
                    { value: "postgres", label: "PostgreSQL" },
                    { value: "mysql", label: "MySQL" },
                ]}
            />
            <FieldLabel>TTL (seconds)</FieldLabel>
            <ModalInput type="number" value={ttl} onChange={setTtl} min={60} max={86400} />
            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: -10, marginBottom: 16 }}>
                Min 60s · Max 86400s (24h)
            </div>
            <ModalFooter
                onCancel={onClose}
                onConfirm={() => {
                    const t = parseInt(ttl, 10);
                    if (!t || t < 60) return;
                    onCreate(dbType, t);
                    onClose();
                }}
                confirmLabel="Spin Up"
            />
        </Modal>
    );
}

// ─── Stop modal ───────────────────────────────────────────────────────────────

function StopModal({ inst, onClose, onConfirm }: {
    inst: Instance;
    onClose: () => void;
    onConfirm: () => void;
}) {
    return (
        <Modal onClose={onClose} title="Stop Instance">
            <div style={{ fontSize: 11, color: "var(--dim)", marginBottom: 16, lineHeight: 1.8 }}>
                Stop instance <span style={{ color: "var(--text)" }}>{inst.id}</span>{" "}
                ({inst.dbType.toUpperCase()} :{inst.port})?<br />
                This will destroy the container and cancel the scheduled job.{" "}
                <span style={{ color: "var(--red)" }}>This cannot be undone.</span>
            </div>
            <ModalFooter onCancel={onClose} onConfirm={onConfirm} confirmLabel="Stop" danger />
        </Modal>
    );
}

// ─── Extend modal ─────────────────────────────────────────────────────────────

function ExtendModal({ inst, onClose, onConfirm }: {
    inst: Instance;
    onClose: () => void;
    onConfirm: (secs: number) => void;
}) {
    const [ext, setExt] = useState("1800");

    return (
        <Modal onClose={onClose} title="Extend TTL">
            <FieldLabel>Instance</FieldLabel>
            <div style={{
                fontSize: 11, color: "var(--green)", marginBottom: 14,
                border: "1px solid var(--border)", padding: "7px 10px",
            }}>
                {inst.id} — {inst.dbType.toUpperCase()} :{inst.port}
            </div>
            <FieldLabel>Extension (seconds)</FieldLabel>
            <ModalInput type="number" value={ext} onChange={setExt} min={60} max={86400} />
            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: -10, marginBottom: 16 }}>
                Min 60s · Max 86400s per request
            </div>
            <ModalFooter
                onCancel={onClose}
                onConfirm={() => {
                    const n = parseInt(ext, 10);
                    if (!n || n < 60) return;
                    onConfirm(n);
                    onClose();
                }}
                confirmLabel="Extend"
            />
        </Modal>
    );
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

function DetailPanel({ inst, onClose }: { inst: Instance; onClose: () => void }) {
    const [copied, setCopied] = useState(false);
    const rem = getRemaining(inst);

    const fields: { key: string; val: ReactNode }[] = [
        { key: "Container ID", val: <span style={{ fontSize: 10, letterSpacing: "0.02em" }}>{inst.containerId}</span> },
        { key: "DB Type", val: inst.dbType.toUpperCase() },
        { key: "Status", val: <span style={{ color: inst.status === "running" ? "var(--green)" : "var(--text)" }}>{inst.status.toUpperCase()}</span> },
        { key: "Host", val: inst.host },
        { key: "Port", val: inst.port },
        { key: "Database", val: inst.dbName },
        { key: "User", val: inst.dbUser },
        { key: "TTL", val: `${inst.ttl}s` },
        { key: "Remaining", val: rem !== null ? <span style={{ color: rem < 300 ? "var(--warn)" : "var(--text)" }}>{fmtRemaining(rem)}</span> : "—" },
        { key: "Created", val: <span style={{ fontSize: 10 }}>{inst.createdAt.toISOString().slice(0, 19)}Z</span> },
        { key: "Expires At", val: <span style={{ fontSize: 10 }}>{inst.expiresAt.toISOString().slice(0, 19)}Z</span> },
        { key: "Destroyed At", val: inst.destroyedAt ? <span style={{ fontSize: 10 }}>{inst.destroyedAt.toISOString().slice(0, 19)}Z</span> : "—" },
    ];

    return (
        <div style={{
            marginTop: 20, border: "1px solid var(--border)",
            background: "var(--surface)", padding: "16px 20px",
            animation: "slideIn 0.15s ease",
        }}>
            <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                marginBottom: 14, paddingBottom: 10, borderBottom: "1px solid var(--border)",
            }}>
                <span style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--dim)" }}>
          // Instance Detail — {inst.id}
                </span>
                <button
                    onClick={onClose}
                    style={{
                        fontFamily: "inherit", fontSize: 11, background: "none", border: "none",
                        color: "var(--dim)", cursor: "pointer", padding: 0,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "var(--dim)")}
                >
                    [ X ]
                </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "8px 16px" }}>
                {fields.map(({ key, val }) => (
                    <div key={key} style={{ padding: "4px 0" }}>
                        <div style={{ fontSize: 10, color: "var(--dim)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 3 }}>{key}</div>
                        <div style={{ fontSize: 12, color: "var(--text)" }}>{val}</div>
                    </div>
                ))}
            </div>

            {inst.status === "running" && (
                <div style={{ marginTop: 14 }}>
                    <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>
                        Connection String
                    </div>
                    <div style={{
                        position: "relative", background: "var(--bg)",
                        border: "1px solid var(--border)", padding: "10px 90px 10px 12px",
                        fontSize: 11, color: "var(--green-dim)", wordBreak: "break-all", letterSpacing: "0.02em",
                    }}>
                        {connStr(inst)}
                        <button
                            onClick={() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                            style={{
                                position: "absolute", top: 8, right: 8,
                                fontFamily: "inherit", fontSize: 10, background: "var(--border)",
                                border: "none", color: "var(--dim)", padding: "3px 8px",
                                cursor: "pointer", letterSpacing: "0.05em", textTransform: "uppercase",
                            }}
                        >
                            {copied ? "Copied" : "Copy"}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Table row ────────────────────────────────────────────────────────────────

function TableRow({
    inst, selected, onSelect, onStop, onExtend,
}: {
    inst: Instance;
    selected: boolean;
    onSelect: () => void;
    onStop: () => void;
    onExtend: () => void;
}) {
    const [hovered, setHovered] = useState(false);

    const actionBtn = (label: string, onClick: () => void, isDanger = false) => (
        <button
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            style={{
                fontFamily: "inherit", fontSize: 10, letterSpacing: "0.05em",
                background: "none", border: "1px solid var(--border)",
                color: "var(--dim)", padding: "3px 8px", cursor: "pointer",
                textTransform: "uppercase", marginRight: 4, transition: "all 0.1s",
            }}
            onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = isDanger ? "#662222" : "var(--border-bright)";
                e.currentTarget.style.color = isDanger ? "var(--red)" : "var(--text)";
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "var(--border)";
                e.currentTarget.style.color = "var(--dim)";
            }}
        >
            {label}
        </button>
    );

    return (
        <tr
            onClick={onSelect}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
                borderBottom: "1px solid var(--border)",
                background: selected ? "rgba(0,255,135,0.07)" : hovered ? "rgba(255,255,255,0.02)" : "transparent",
                cursor: "pointer", transition: "background 0.1s",
            }}
        >
            <td style={{ padding: "10px 12px 10px 16px", fontSize: 10, color: "var(--dim)", letterSpacing: "0.04em" }}>
                <span style={{ color: "var(--text)" }}>{inst.id}</span>
            </td>
            <td style={{ padding: "10px 12px" }}><DbTag type={inst.dbType} /></td>
            <td style={{ padding: "10px 12px", fontSize: 11 }}>{inst.port}</td>
            <td style={{ padding: "10px 12px" }}><Badge status={inst.status} /></td>
            <td style={{ padding: "10px 12px" }}><TtlBar inst={inst} /></td>
            <td style={{ padding: "10px 12px", fontSize: 10, color: "var(--dim)" }}>{fmtAge(inst.createdAt)}</td>
            <td style={{ padding: "10px 12px 10px 8px", whiteSpace: "nowrap" }}>
                {actionBtn("Info", onSelect)}
                {inst.status === "running" && actionBtn("Extend", onExtend)}
                {inst.status === "running" && actionBtn("Stop", onStop, true)}
            </td>
        </tr>
    );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Page() {
    const [instances, setInstances] = useState<Instance[]>(makeSeed);
    const [filter, setFilter] = useState<FilterKey>("all");
    const [tab, setTab] = useState<NavTab>("instances");
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [clock, setClock] = useState("");

    type ModalState =
        | { kind: "none" }
        | { kind: "create" }
        | { kind: "stop"; inst: Instance }
        | { kind: "extend"; inst: Instance };

    const [modal, setModal] = useState<ModalState>({ kind: "none" });

    // Live clock + TTL bar refresh
    useEffect(() => {
        const tick = () => setClock(new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC");
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, []);

    const createInstance = useCallback((dbType: DBType, ttl: number) => {
        const id = randId();
        const now = new Date();
        const port = dbType === "postgres"
            ? 54320 + instances.filter(i => i.dbType === "postgres").length + 1
            : 33060 + instances.filter(i => i.dbType === "mysql").length + 1;

        setInstances(prev => [{
            id, containerId: `sha256:${Math.random().toString(36).slice(2, 14)}`,
            dbType, host: "localhost", port,
            dbName: `db_${id}`,
            dbUser: dbType === "postgres" ? "pguser" : "mysqluser",
            dbPassword: Math.random().toString(36).slice(2, 18),
            ttl, status: "running",
            createdAt: now,
            expiresAt: new Date(now.getTime() + ttl * 1000),
        }, ...prev]);
    }, [instances]);

    const stopInstance = useCallback((id: string) => {
        setInstances(prev => prev.map(i =>
            i.id === id ? { ...i, status: "stopped", destroyedAt: new Date() } : i
        ));
        if (selectedId === id) setSelectedId(null);
    }, [selectedId]);

    const extendInstance = useCallback((id: string, secs: number) => {
        setInstances(prev => prev.map(i =>
            i.id === id
                ? { ...i, expiresAt: new Date(i.expiresAt.getTime() + secs * 1000), ttl: i.ttl + secs }
                : i
        ));
    }, []);

    const filtered = filter === "all" ? instances : instances.filter(i => i.status === filter);
    const selected = instances.find(i => i.id === selectedId) ?? null;

    const stats = {
        total: instances.length,
        running: instances.filter(i => i.status === "running").length,
        stopped: instances.filter(i => i.status === "stopped").length,
        error: instances.filter(i => i.status === "error").length,
    };

    const FILTERS: { key: FilterKey; label: string }[] = [
        { key: "all", label: "All" },
        { key: "running", label: "Running" },
        { key: "stopped", label: "Stopped" },
        { key: "error", label: "Error" },
    ];

    const filterActiveStyle = (key: FilterKey): React.CSSProperties => {
        if (filter !== key) return {};
        if (key === "all") return { background: "rgba(255,255,255,0.06)", color: "var(--text)", borderColor: "var(--border-bright)" };
        if (key === "running") return { background: "rgba(0,255,135,0.12)", color: "var(--green)", borderColor: "rgba(0,255,135,0.4)" };
        if (key === "stopped") return { background: "rgba(255,68,68,0.1)", color: "var(--red)", borderColor: "rgba(255,68,68,0.3)" };
        if (key === "error") return { background: "rgba(255,170,0,0.1)", color: "var(--warn)", borderColor: "rgba(255,170,0,0.3)" };
        return {};
    };

    return (
        <>
            <style>{`
        :root {
          --font-mono: "IBM Plex Mono", monospace;
          --green:      #00ff87;
          --green-dim:  #00cc6a;
          --red:        #ff4444;
          --warn:       #ffaa00;
          --bg:         #0a0a0a;
          --surface:    #111111;
          --border:     #1e1e1e;
          --border-bright: #2e2e2e;
          --text:       #e0e0e0;
          --dim:        #666666;
          --muted:      #3a3a3a;
        }
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { background: var(--bg); color: var(--text); font-family: var(--font-mono); }
        @keyframes blink   { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes pulse   { 0%,100%{opacity:1} 50%{opacity:0.35} }
        @keyframes fadeIn  { from{opacity:0} to{opacity:1} }
        @keyframes slideIn { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: var(--bg); }
        ::-webkit-scrollbar-thumb { background: var(--border-bright); }
      `}</style>

            <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: "var(--font-mono)" }}>

                {/* ── Topbar ── */}
                <div style={{
                    height: 42, borderBottom: "1px solid var(--border)",
                    background: "var(--surface)", display: "flex",
                    alignItems: "center", justifyContent: "space-between",
                    padding: "0 20px", position: "sticky", top: 0, zIndex: 50,
                }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.08em", color: "var(--green)", textTransform: "uppercase" }}>
                            EPHEMDB<Blink>█</Blink>
                        </span>
                        <span style={{ fontSize: 11, color: "var(--dim)", letterSpacing: "0.04em" }}>v1.0.0</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 11, letterSpacing: "0.04em" }}>
                        <span style={{ color: "var(--dim)" }}>DOCKER <span style={{ color: "var(--green)" }}>CONNECTED</span></span>
                        <span style={{ color: "var(--dim)" }}>REDIS <span style={{ color: "var(--green)" }}>OK</span></span>
                        <span style={{ color: "var(--muted)" }}>{clock}</span>
                    </div>
                </div>

                {/* ── Nav ── */}
                <div style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "var(--surface)", padding: "0 20px" }}>
                    {(["instances", "queue", "logs"] as NavTab[]).map(t => (
                        <button
                            key={t}
                            onClick={() => setTab(t)}
                            style={{
                                fontFamily: "inherit", padding: "10px 16px 9px",
                                fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase",
                                color: tab === t ? "var(--green)" : "var(--dim)",
                                background: "none", border: "none", cursor: "pointer",
                                borderBottom: tab === t ? "2px solid var(--green)" : "2px solid transparent",
                                transition: "color 0.15s",
                            }}
                        >
                            {t}
                        </button>
                    ))}
                </div>

                {/* ── Main ── */}
                <div style={{ padding: 20 }}>

                    {/* Stats row */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 1, marginBottom: 20, border: "1px solid var(--border)" }}>
                        {[
                            { label: "Total", val: stats.total, color: "var(--text)" },
                            { label: "Running", val: stats.running, color: "var(--green)" },
                            { label: "Stopped", val: stats.stopped, color: "var(--text)" },
                            { label: "Error", val: stats.error, color: stats.error > 0 ? "var(--warn)" : "var(--text)" },
                        ].map(({ label, val, color }, i) => (
                            <div key={label} style={{
                                background: "var(--surface)", padding: "12px 14px",
                                borderRight: i < 3 ? "1px solid var(--border)" : "none",
                            }}>
                                <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--dim)", marginBottom: 5 }}>{label}</div>
                                <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", color }}>{val}</div>
                            </div>
                        ))}
                    </div>

                    {/* Toolbar */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                        <div style={{ display: "flex", gap: 1 }}>
                            {FILTERS.map(({ key, label }) => (
                                <button
                                    key={key}
                                    onClick={() => setFilter(key)}
                                    style={{
                                        fontFamily: "inherit", fontSize: 11, letterSpacing: "0.05em",
                                        background: "var(--surface)", border: "1px solid var(--border)",
                                        color: "var(--dim)", padding: "5px 10px", cursor: "pointer",
                                        textTransform: "uppercase", transition: "all 0.1s",
                                        ...filterActiveStyle(key),
                                    }}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                        <div style={{ flex: 1 }} />
                        <button
                            onClick={() => setModal({ kind: "create" })}
                            style={{
                                fontFamily: "inherit", fontSize: 11, letterSpacing: "0.06em",
                                background: "var(--green)", color: "#000", border: "none",
                                padding: "6px 14px", cursor: "pointer", fontWeight: 600,
                                textTransform: "uppercase",
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--green-dim)")}
                            onMouseLeave={(e) => (e.currentTarget.style.background = "var(--green)")}
                        >
                            + New Instance
                        </button>
                    </div>

                    {/* Table */}
                    <div style={{ border: "1px solid var(--border)", overflow: "hidden" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse" }}>
                            <thead>
                                <tr style={{ background: "var(--surface)", borderBottom: "1px solid var(--border-bright)" }}>
                                    {["ID", "Type", "Port", "Status", "TTL Remaining", "Created", "Actions"].map(h => (
                                        <th key={h} style={{
                                            padding: h === "ID" ? "8px 12px 8px 16px" : "8px 12px",
                                            textAlign: "left", fontSize: 10, letterSpacing: "0.1em",
                                            textTransform: "uppercase", color: "var(--dim)", fontWeight: 500,
                                        }}>
                                            {h}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.length === 0 ? (
                                    <tr>
                                        <td colSpan={7} style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                                            No instances match filter
                                        </td>
                                    </tr>
                                ) : (
                                    filtered.map(inst => (
                                        <TableRow
                                            key={inst.id}
                                            inst={inst}
                                            selected={selectedId === inst.id}
                                            onSelect={() => setSelectedId(prev => prev === inst.id ? null : inst.id)}
                                            onStop={() => setModal({ kind: "stop", inst })}
                                            onExtend={() => setModal({ kind: "extend", inst })}
                                        />
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>

                    {/* Detail panel */}
                    {selected && (
                        <DetailPanel inst={selected} onClose={() => setSelectedId(null)} />
                    )}
                </div>
            </div>

            {/* ── Modals ── */}
            {modal.kind === "create" && (
                <CreateModal onClose={() => setModal({ kind: "none" })} onCreate={createInstance} />
            )}
            {modal.kind === "stop" && (
                <StopModal
                    inst={modal.inst}
                    onClose={() => setModal({ kind: "none" })}
                    onConfirm={() => { stopInstance(modal.inst.id); setModal({ kind: "none" }); }}
                />
            )}
            {modal.kind === "extend" && (
                <ExtendModal
                    inst={modal.inst}
                    onClose={() => setModal({ kind: "none" })}
                    onConfirm={(secs) => extendInstance(modal.inst.id, secs)}
                />
            )}
        </>
    );
}