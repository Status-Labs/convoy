// Live machine metrics, streamed from the VM over SSH with no agent
// installed: a small shell loop prints raw /proc snapshots every couple of
// seconds, and the parser here turns consecutive snapshots into rates. The
// VM stays dumb; the logic lives here so the web app can reuse it later.

export const METRICS_INTERVAL_S = 2;

/**
 * POSIX sh loop that prints one block per interval:
 *   @@ <unix time>
 *   @cpu  <first line of /proc/stat>
 *   @mem  <MemTotal MemAvailable SwapTotal SwapFree, in kB>
 *   @load <first three fields of /proc/loadavg>
 *   @up   <seconds since boot>
 *   @net  <rx bytes> <tx bytes>, summed over interfaces except lo
 *   @disk <size bytes> <used bytes> of /
 *   @io   <sectors read> <sectors written> on the root device
 *   @proc <pid> <cpu ticks> <rss pages> <command>, one per user process
 *   @end
 */
export const METRICS_COLLECTOR = `
dev=$(basename "$(findmnt -no SOURCE / 2>/dev/null)" 2>/dev/null)
echo "@hz $(getconf CLK_TCK) $(nproc)"
while :; do
  echo "@@ $(date +%s)"
  echo "@cpu $(head -n1 /proc/stat)"
  echo "@mem $(awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ {printf "%s ", $2}' /proc/meminfo)"
  echo "@load $(cut -d' ' -f1-3 /proc/loadavg)"
  echo "@up $(cut -d' ' -f1 /proc/uptime)"
  echo "@net $(awk 'NR > 2 && $1 != "lo:" {sub(/^[^:]*:/, ""); rx += $1; tx += $9} END {printf "%d %d", rx, tx}' /proc/net/dev)"
  echo "@disk $(df -B1 --output=size,used / | tail -n1)"
  echo "@io $(awk -v d="$dev" '$3 == d {print $6, $10}' /proc/diskstats)"
  # Kernel threads have no RSS; skip them. The command can contain spaces
  # and parentheses, so fields are counted from the state after the last ")".
  awk 'match($0, /\\) [A-Za-z] /) {
    rest = substr($0, RSTART + 2); split(rest, f, " ")
    if (f[22] > 0) {
      open = index($0, "(")
      print "@proc", $1, f[12] + f[13], f[22], substr($0, open + 1, RSTART - open - 1)
    }
  }' /proc/[0-9]*/stat 2>/dev/null
  echo "@end"
  sleep ${METRICS_INTERVAL_S}
done
`;

export interface ProcessSample {
  pid: number;
  command: string;
  /** Percent of one core, like top (can exceed 100). */
  cpu: number;
  memBytes: number;
}

export interface MetricsSample {
  at: number;
  /** Percent of all cores. */
  cpu: number;
  cores: number;
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  swapTotal: number;
  load: [number, number, number];
  uptimeS: number;
  diskUsed: number;
  diskTotal: number;
  /** Bytes per second. */
  netRx: number;
  netTx: number;
  diskRead: number;
  diskWrite: number;
  /** Busiest processes first. */
  processes: ProcessSample[];
}

interface RawBlock {
  at: number;
  cpu?: number[];
  mem?: number[];
  load?: number[];
  up?: number;
  net?: number[];
  disk?: number[];
  io?: number[];
  procs: { pid: number; ticks: number; rss: number; command: string }[];
}

const PAGE_BYTES = 4096;
const SECTOR_BYTES = 512;

const numbers = (text: string) => text.trim().split(/\s+/).filter(Boolean).map(Number);

/**
 * Turns the collector's output into samples. Feed it stdout chunks; it calls
 * onSample once per block after the first (rates need two blocks).
 */
export class MetricsParser {
  private buffer = "";
  private hz = 100;
  private cores = 1;
  private block: RawBlock | null = null;
  private previous: RawBlock | null = null;

  constructor(private readonly onSample: (sample: MetricsSample) => void) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  private line(line: string): void {
    const space = line.indexOf(" ");
    const tag = space < 0 ? line : line.slice(0, space);
    const rest = space < 0 ? "" : line.slice(space + 1);
    if (tag === "@hz") {
      const [hz, cores] = numbers(rest);
      if (hz) this.hz = hz;
      if (cores) this.cores = cores;
      return;
    }
    if (tag === "@@") {
      this.block = { at: Number(rest) * 1000, procs: [] };
      return;
    }
    const block = this.block;
    if (!block) return;
    switch (tag) {
      case "@cpu":
        // "cpu  user nice system idle iowait irq softirq steal ..."
        block.cpu = numbers(rest.replace(/^cpu\s+/, ""));
        break;
      case "@mem":
        block.mem = numbers(rest);
        break;
      case "@load":
        block.load = numbers(rest);
        break;
      case "@up":
        block.up = Number(rest);
        break;
      case "@net":
        block.net = numbers(rest);
        break;
      case "@disk":
        block.disk = numbers(rest);
        break;
      case "@io":
        block.io = numbers(rest);
        break;
      case "@proc": {
        const [pid, ticks, rss, ...command] = rest.split(" ");
        block.procs.push({ pid: Number(pid), ticks: Number(ticks), rss: Number(rss), command: command.join(" ") });
        break;
      }
      case "@end":
        if (this.previous) this.onSample(this.sample(this.previous, block));
        this.previous = block;
        this.block = null;
        break;
    }
  }

  private sample(prev: RawBlock, cur: RawBlock): MetricsSample {
    const seconds = Math.max(0.001, (cur.at - prev.at) / 1000);
    const rate = (a: number | undefined, b: number | undefined, scale = 1) =>
      a === undefined || b === undefined ? 0 : Math.max(0, ((b - a) * scale) / seconds);

    const cpuTotal = (v: number[] = []) => v.slice(0, 8).reduce((sum, n) => sum + n, 0);
    const cpuIdle = (v: number[] = []) => (v[3] ?? 0) + (v[4] ?? 0);
    const total = cpuTotal(cur.cpu) - cpuTotal(prev.cpu);
    const idle = cpuIdle(cur.cpu) - cpuIdle(prev.cpu);
    const cpu = total > 0 ? Math.min(100, Math.max(0, ((total - idle) / total) * 100)) : 0;

    const [memTotal = 0, memAvailable = 0, swapTotal = 0, swapFree = 0] = (cur.mem ?? []).map((kb) => kb * 1024);
    const before = new Map(prev.procs.map((p) => [p.pid, p.ticks]));
    const processes = cur.procs
      .map((p) => ({
        pid: p.pid,
        command: p.command,
        cpu: (((p.ticks - (before.get(p.pid) ?? p.ticks)) / this.hz) * 100) / seconds,
        memBytes: p.rss * PAGE_BYTES,
      }))
      .sort((a, b) => b.cpu - a.cpu || b.memBytes - a.memBytes);

    const [load1 = 0, load5 = 0, load15 = 0] = cur.load ?? [];
    return {
      at: cur.at,
      cpu,
      cores: this.cores,
      memUsed: memTotal - memAvailable,
      memTotal,
      swapUsed: swapTotal - swapFree,
      swapTotal,
      load: [load1, load5, load15],
      uptimeS: cur.up ?? 0,
      diskTotal: cur.disk?.[0] ?? 0,
      diskUsed: cur.disk?.[1] ?? 0,
      netRx: rate(prev.net?.[0], cur.net?.[0]),
      netTx: rate(prev.net?.[1], cur.net?.[1]),
      diskRead: rate(prev.io?.[0], cur.io?.[0], SECTOR_BYTES),
      diskWrite: rate(prev.io?.[1], cur.io?.[1], SECTOR_BYTES),
      processes,
    };
  }
}

/** 1536 → "1.5 KB". */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 200000 → "2d 7h". */
export function formatUptime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
