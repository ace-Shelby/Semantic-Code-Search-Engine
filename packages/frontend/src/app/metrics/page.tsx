import {
  Activity,
  Clock,
  DollarSign,
  Database,
  TrendingUp,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────

interface MetricsData {
  avgLatencyMs: number;
  avgCostUsd: number;
  queriesToday: number;
  cacheHitRate: number;
  sampledTraces: number;
  lastUpdated: string;
}

const BACKEND_URL = (process.env.BACKEND_URL ?? "http://localhost:3001").replace(/\/+$/, "");

// ── Server Component ──────────────────────────────────────────

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function fetchMetrics(): Promise<MetricsData | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/v1/metrics`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export default async function MetricsPage() {
  const metrics = await fetchMetrics();

  if (!metrics) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-center">
        <Activity className="h-10 w-10 text-gray-700 mb-4" />
        <p className="text-gray-400 text-sm">
          Unable to load metrics. Make sure the API is running.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {/* ── Header ───────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-bold text-white">Metrics Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">
          Aggregated from the last {metrics.sampledTraces} traces · Updated{" "}
          {new Date(metrics.lastUpdated).toLocaleTimeString()}
        </p>
      </div>

      {/* ── KPI Cards ────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Total Queries Today"
          value={metrics.queriesToday.toLocaleString()}
          icon={<TrendingUp className="h-4 w-4" />}
          iconColor="text-violet-400"
          bgColor="bg-violet-500/10"
        />
        <MetricCard
          label="Avg Search Latency"
          value={`${metrics.avgLatencyMs}ms`}
          icon={<Clock className="h-4 w-4" />}
          iconColor="text-blue-400"
          bgColor="bg-blue-500/10"
        />
        <MetricCard
          label="Avg Cost / Query"
          value={`$${metrics.avgCostUsd.toFixed(4)}`}
          icon={<DollarSign className="h-4 w-4" />}
          iconColor="text-emerald-400"
          bgColor="bg-emerald-500/10"
        />
        <MetricCard
          label="Cache Hit Rate"
          value={`${(metrics.cacheHitRate * 100).toFixed(1)}%`}
          icon={<Database className="h-4 w-4" />}
          iconColor="text-amber-400"
          bgColor="bg-amber-500/10"
        />
      </div>

      {/* ── Cache Hit Rate Visual ────────────────────────────── */}
      <div className="rounded-xl border border-surface-border bg-surface-raised p-6">
        <h2 className="text-sm font-semibold text-white mb-4">
          Cache Performance
        </h2>
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <div className="h-3 w-full rounded-full bg-surface-border overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all"
                style={{
                  width: `${Math.round(metrics.cacheHitRate * 100)}%`,
                }}
              />
            </div>
          </div>
          <span className="text-sm font-mono text-gray-300 w-16 text-right">
            {(metrics.cacheHitRate * 100).toFixed(1)}%
          </span>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Higher is better. Cache hits avoid re-computing vector searches.
        </p>
      </div>

      {/* ── Cost Breakdown ───────────────────────────────────── */}
      <div className="rounded-xl border border-surface-border bg-surface-raised p-6">
        <h2 className="text-sm font-semibold text-white mb-4">
          Cost Summary
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <CostItem
            label="Per Query"
            value={`$${metrics.avgCostUsd.toFixed(4)}`}
          />
          <CostItem
            label="Today (est.)"
            value={`$${(metrics.queriesToday * metrics.avgCostUsd).toFixed(4)}`}
          />
          <CostItem
            label="Sampled Traces"
            value={metrics.sampledTraces.toString()}
          />
        </div>
      </div>
    </div>
  );
}

// ── Sub-Components ────────────────────────────────────────────

function MetricCard({
  label,
  value,
  icon,
  iconColor,
  bgColor,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  iconColor: string;
  bgColor: string;
}) {
  return (
    <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
          {label}
        </span>
        <div className={`rounded-lg p-2 ${bgColor}`}>
          <span className={iconColor}>{icon}</span>
        </div>
      </div>
      <p className="text-2xl font-bold text-white font-mono">{value}</p>
    </div>
  );
}

function CostItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface p-4 border border-surface-border">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-lg font-bold text-white font-mono">{value}</p>
    </div>
  );
}
