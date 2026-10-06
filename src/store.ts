import { computed, ref } from "vue";
import { defineStore } from "pinia";
import {
  AREAS,
  FIELD_LABEL,
  SOURCE_LABEL,
  STATUSES,
  type Conflict,
  type LedgerEntry,
  type LogEntry,
  type MergedStation,
  type Resolution,
  type Source,
  type StationPayload,
  type SubmitResult,
} from "./types";

const KEY_PREFIX = "hxwlfront-21";
const key = (name: string) => `${KEY_PREFIX}-${name}`;

const SOURCES: Source[] = ["inspection", "dispatch"];

function load<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key(name));
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(name: string, value: unknown) {
  localStorage.setItem(key(name), JSON.stringify(value));
}

const isoHoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

/** 首次运行的演示数据：两边各记一份，机场快线站两边都动过且不一致 */
function seedLedgers(): Record<Source, LedgerEntry[]> {
  const mk = (
    source: Source,
    payload: Partial<StationPayload> & { station: string },
    updatedAt: string
  ): LedgerEntry => ({
    id: crypto.randomUUID(),
    batchId: crypto.randomUUID(),
    source,
    updatedAt,
    syncState: "synced",
    area: "东区",
    stock: 0,
    stockAt: updatedAt,
    status: "营业中",
    confirmed: source === "inspection",
    manager: "—",
    notes: "",
    ...payload,
  });
  return {
    inspection: [
      mk("inspection", { station: "机场快线站", area: "机场线", stock: 9000, stockAt: isoHoursAgo(2), status: "库存紧张", manager: "王站长", notes: "柴油待补" }, isoHoursAgo(2)),
      mk("inspection", { station: "东区一站", area: "东区", stock: 36000, stockAt: isoHoursAgo(5), status: "营业中", manager: "刘站长", notes: "库存正常" }, isoHoursAgo(5)),
    ],
    dispatch: [
      mk("dispatch", { station: "机场快线站", area: "机场线", stock: 9500, stockAt: isoHoursAgo(6), status: "营业中", confirmed: false, manager: "王站长", notes: "交班盘点" }, isoHoursAgo(1)),
      mk("dispatch", { station: "东区一站", area: "东区", stock: 36000, stockAt: isoHoursAgo(5), status: "营业中", confirmed: false, manager: "刘站长" }, isoHoursAgo(4)),
      mk("dispatch", { station: "西区二站", area: "西区", stock: 12000, stockAt: isoHoursAgo(8), status: "暂停营业", confirmed: false, manager: "陈站长", notes: "设备检修" }, isoHoursAgo(8)),
    ],
  };
}

/** 批次校验：批内重名、区域越界、缺名、状态非法 → 整批停下 */
export function validateBatch(payloads: StationPayload[]): string[] {
  const errors: string[] = [];
  const seen = new Map<string, number>();
  payloads.forEach((p, i) => {
    const row = `第${i + 1}条「${p.station.trim() || "未命名"}」`;
    if (!p.station.trim()) errors.push(`${row}：缺少油站名称`);
    if (!(AREAS as readonly string[]).includes(p.area))
      errors.push(`${row}：区域「${p.area || "空"}」不在东区/西区/机场线内`);
    if (!(STATUSES as readonly string[]).includes(p.status))
      errors.push(`${row}：营业状态「${p.status || "空"}」无效`);
    const name = p.station.trim();
    if (name) {
      const first = seen.get(name);
      if (first !== undefined) errors.push(`${row}：与第${first + 1}条重名「${name}」`);
      else seen.set(name, i);
    }
  });
  return errors;
}

/** 批量导入文本解析：每行一条，逗号分隔：站名,区域,库存,状态,负责人,备注 */
export function parseBatchText(text: string, source: Source): StationPayload[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [station = "", area = "", stock = "", status = "", manager = "", notes = ""] = line
        .split(/[,，]/)
        .map((cell) => cell.trim());
      return {
        station,
        area,
        stock: Number(stock),
        stockAt: new Date().toISOString(),
        status: status || "营业中",
        confirmed: source === "inspection",
        manager: manager || "—",
        notes,
      };
    });
}

export const useLedgerStore = defineStore("ledger", () => {
  const ledgers = ref<Record<Source, LedgerEntry[]>>(load("ledgers-v1", seedLedgers()));
  const resolutions = ref<Resolution[]>(load("resolutions-v1", []));
  const online = ref(true);
  const logs = ref<LogEntry[]>([]);
  /** 正在被修正的失败条目 id（载入表单后原地更新） */
  const fixingId = ref<string | null>(null);

  function persist() {
    save("ledgers-v1", ledgers.value);
    save("resolutions-v1", resolutions.value);
  }

  function log(text: string, kind: LogEntry["kind"] = "info") {
    logs.value.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), text, kind });
    if (logs.value.length > 60) logs.value.length = 60;
  }

  // ---------- 合并计算（指标和列表都按合并结果） ----------

  /** 每侧已同步记录按站名取改动时间最新的一条 */
  const latestSynced = computed<Record<Source, Map<string, LedgerEntry>>>(() => {
    const out = { inspection: new Map(), dispatch: new Map() } as Record<Source, Map<string, LedgerEntry>>;
    for (const source of SOURCES) {
      for (const e of ledgers.value[source]) {
        if (e.syncState !== "synced") continue;
        const prev = out[source].get(e.station);
        if (!prev || e.updatedAt > prev.updatedAt) out[source].set(e.station, e);
      }
    }
    return out;
  });

  /** 库存：盘点时间较新的算，平手看改动时间，再平手听巡检 */
  function stockWinner(a: LedgerEntry, b: LedgerEntry): LedgerEntry {
    if (a.stockAt !== b.stockAt) return a.stockAt > b.stockAt ? a : b;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
    return a.source === "inspection" ? a : b;
  }

  /** 营业状态：现场确认的算，都（没）确认看改动时间，再平手听巡检 */
  function statusWinner(a: LedgerEntry, b: LedgerEntry): LedgerEntry {
    if (a.confirmed !== b.confirmed) return a.confirmed ? a : b;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
    return a.source === "inspection" ? a : b;
  }

  const merged = computed<MergedStation[]>(() => {
    const iMap = latestSynced.value.inspection;
    const dMap = latestSynced.value.dispatch;
    const names = [...new Set([...iMap.keys(), ...dMap.keys()])];
    return names
      .map((station) => {
        const i = iMap.get(station);
        const d = dMap.get(station);
        if (i && d) {
          const sWin = stockWinner(i, d);
          const stWin = statusWinner(i, d);
          const newer = i.updatedAt >= d.updatedAt ? i : d;
          return {
            station,
            area: newer.area,
            stock: sWin.stock,
            stockAt: sWin.stockAt,
            stockSource: sWin.source,
            status: stWin.status,
            statusSource: stWin.source,
            confirmed: stWin.confirmed,
            manager: newer.manager,
            notes: newer.notes,
            sources: ["inspection", "dispatch"] as Source[],
            updatedAt: newer.updatedAt,
            openConflicts: 0,
          };
        }
        const e = (i ?? d)!;
        return {
          station: e.station,
          area: e.area,
          stock: e.stock,
          stockAt: e.stockAt,
          stockSource: e.source,
          status: e.status,
          statusSource: e.source,
          confirmed: e.confirmed,
          manager: e.manager,
          notes: e.notes,
          sources: [e.source],
          updatedAt: e.updatedAt,
          openConflicts: 0,
        };
      })
      .sort((a, b) => a.station.localeCompare(b.station, "zh-CN"));
  });

  /** 两边都动过且不一致 → 被压过的一方进待确认清单 */
  const conflicts = computed<Conflict[]>(() => {
    const iMap = latestSynced.value.inspection;
    const dMap = latestSynced.value.dispatch;
    const out: Conflict[] = [];
    for (const station of new Set([...iMap.keys()].filter((n) => dMap.has(n)))) {
      const i = iMap.get(station)!;
      const d = dMap.get(station)!;
      if (i.stock !== d.stock) {
        const win = stockWinner(i, d);
        const lose = win === i ? d : i;
        out.push({
          id: `stock|${station}|${win.source}|${win.stock}|${lose.source}|${lose.stock}`,
          station,
          field: "stock",
          kept: { source: win.source, value: win.stock, at: win.stockAt },
          dropped: { source: lose.source, value: lose.stock, at: lose.stockAt },
          reason: `库存以盘点时间较新的${SOURCE_LABEL[win.source]}记录为准`,
        });
      }
      if (i.status !== d.status) {
        const win = statusWinner(i, d);
        const lose = win === i ? d : i;
        out.push({
          id: `status|${station}|${win.source}|${win.status}|${lose.source}|${lose.status}`,
          station,
          field: "status",
          kept: { source: win.source, value: win.status, at: win.updatedAt, confirmed: win.confirmed },
          dropped: { source: lose.source, value: lose.status, at: lose.updatedAt, confirmed: lose.confirmed },
          reason: win.confirmed && !lose.confirmed
            ? `营业状态以${SOURCE_LABEL[win.source]}现场确认的为准`
            : `双方都${win.confirmed ? "" : "未"}现场确认，以改动时间较新的${SOURCE_LABEL[win.source]}为准`,
        });
      }
    }
    return out;
  });

  const mergedWithFlags = computed<MergedStation[]>(() => {
    const count = new Map<string, number>();
    for (const c of conflicts.value) count.set(c.station, (count.get(c.station) ?? 0) + 1);
    return merged.value.map((m) => ({ ...m, openConflicts: count.get(m.station) ?? 0 }));
  });

  const pendingEntries = computed(() =>
    SOURCES.flatMap((s) => ledgers.value[s].filter((e) => e.syncState === "pending"))
  );
  const failedEntries = computed(() =>
    SOURCES.flatMap((s) => ledgers.value[s].filter((e) => e.syncState === "failed"))
  );

  /** 指标全部按合并结果计算 */
  const metrics = computed(() => ({
    total: merged.value.length,
    open: merged.value.filter((m) => m.status === "营业中").length,
    tight: merged.value.filter((m) => m.status === "库存紧张").length,
    conflicts: conflicts.value.length,
    pending: pendingEntries.value.length,
    failed: failedEntries.value.length,
  }));

  const chartRows = computed(() =>
    STATUSES.map((status) => ({
      status,
      value: merged.value.filter((m) => m.status === status).length,
    }))
  );

  // ---------- 提交与同步 ----------

  function makeEntry(p: StationPayload, source: Source, batchId: string, state: LedgerEntry["syncState"]): LedgerEntry {
    return {
      ...p,
      station: p.station.trim(),
      id: crypto.randomUUID(),
      batchId,
      source,
      updatedAt: new Date().toISOString(),
      syncState: state,
    };
  }

  /** 提交一批：在线先校验（不过则整批停下），断网先记本地 */
  function submitBatch(source: Source, payloads: StationPayload[]): SubmitResult {
    if (payloads.length === 0) return { ok: false, errors: ["没有可提交的条目"] };
    const batchId = crypto.randomUUID();
    if (!online.value) {
      ledgers.value[source].unshift(...payloads.map((p) => makeEntry(p, source, batchId, "pending")));
      log(`断网：${SOURCE_LABEL[source]} ${payloads.length} 条先记本地，回网后合并`, "info");
      persist();
      return { ok: true, queued: true };
    }
    const errors = validateBatch(payloads);
    if (errors.length) {
      log(`整批停下：${SOURCE_LABEL[source]} ${payloads.length} 条未入库（${errors.join("；")}）`, "fail");
      return { ok: false, errors };
    }
    ledgers.value[source].unshift(...payloads.map((p) => makeEntry(p, source, batchId, "synced")));
    log(`${SOURCE_LABEL[source]} ${payloads.length} 条已入库并合并`, "ok");
    persist();
    return { ok: true };
  }

  /** 回网合并：逐批校验本地待同步记录，失败的留住原因 */
  function syncAll() {
    if (!online.value) return;
    let synced = 0;
    let failed = 0;
    for (const source of SOURCES) {
      const unsynced = ledgers.value[source].filter((e) => e.syncState !== "synced");
      const batches = new Map<string, LedgerEntry[]>();
      for (const e of unsynced) {
        const list = batches.get(e.batchId) ?? [];
        list.push(e);
        batches.set(e.batchId, list);
      }
      for (const batch of batches.values()) {
        const errors = validateBatch(batch);
        if (errors.length === 0) {
          batch.forEach((e) => {
            e.syncState = "synced";
            e.failReason = undefined;
          });
          synced += batch.length;
        } else {
          batch.forEach((e, idx) => {
            e.syncState = "failed";
            const own = errors.filter((er) => er.startsWith(`第${idx + 1}条`));
            e.failReason = own.length ? own.join("；") : "整批停下：同批其他条目未通过校验";
          });
          failed += batch.length;
          log(`同步失败：${SOURCE_LABEL[source]}一批${batch.length}条整批停下（${errors.join("；")}）`, "fail");
        }
      }
    }
    if (synced) log(`回网合并完成：${synced} 条已同步，指标与列表已按合并结果刷新`, "ok");
    if (failed) log(`${failed} 条同步失败，原因已保留，可修正后重试`, "fail");
    persist();
  }

  /** 重试失败批次（修正数据后重新走校验） */
  function retryBatch(batchId: string) {
    for (const source of SOURCES) {
      for (const e of ledgers.value[source]) {
        if (e.batchId === batchId && e.syncState === "failed") {
          e.syncState = "pending";
          e.failReason = undefined;
        }
      }
    }
    log("已重新提交失败批次，等待合并", "info");
    syncAll();
    persist();
  }

  /** 把失败条目载入表单修正 */
  function startFix(entryId: string) {
    fixingId.value = entryId;
  }

  /** 保存修正：原地更新条目并立即重试本批 */
  function applyFix(source: Source, payload: StationPayload) {
    const entry = ledgers.value[source].find((e) => e.id === fixingId.value);
    fixingId.value = null;
    if (!entry) return { ok: false } as SubmitResult;
    Object.assign(entry, payload, {
      station: payload.station.trim(),
      updatedAt: new Date().toISOString(),
      syncState: "pending" as const,
      failReason: undefined,
    });
    log(`已修正「${entry.station}」，重新提交本批`, "info");
    syncAll();
    persist();
    return { ok: true };
  }

  function cancelFix() {
    fixingId.value = null;
  }

  function removeEntry(source: Source, id: string) {
    const list = ledgers.value[source];
    const entry = list.find((e) => e.id === id);
    if (!entry || entry.syncState === "synced") return; // 已入库的台账不允许删
    ledgers.value[source] = list.filter((e) => e.id !== id);
    persist();
  }

  // ---------- 待确认清单处置 ----------

  /** 处置：把选定一方的值回写到另一侧台账，两边一致后合成一条 */
  function resolveConflict(conflict: Conflict, choice: "keep" | "adopt") {
    const chosen = choice === "keep" ? conflict.kept : conflict.dropped;
    const targetSource = choice === "keep" ? conflict.dropped.source : conflict.kept.source;
    const target = latestSynced.value[targetSource].get(conflict.station);
    if (!target) return;
    const patch: Partial<StationPayload> =
      conflict.field === "stock"
        ? { stock: Number(chosen.value), stockAt: chosen.at }
        : { status: String(chosen.value), confirmed: chosen.confirmed ?? true };
    const entry: LedgerEntry = {
      ...target,
      ...patch,
      id: crypto.randomUUID(),
      batchId: crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
      syncState: online.value ? "synced" : "pending",
      failReason: undefined,
      notes: `处置回写：${FIELD_LABEL[conflict.field]}${choice === "keep" ? "维持合并值" : `改用${SOURCE_LABEL[chosen.source]}值`}`,
    };
    ledgers.value[targetSource].unshift(entry);
    resolutions.value.unshift({
      id: crypto.randomUUID(),
      station: conflict.station,
      field: conflict.field,
      choice,
      kept: conflict.kept,
      dropped: conflict.dropped,
      at: new Date().toISOString(),
    });
    log(
      `已处置「${conflict.station}」${FIELD_LABEL[conflict.field]}：采用${SOURCE_LABEL[chosen.source]}值 ${chosen.value}，回写${SOURCE_LABEL[targetSource]}台账`,
      "ok"
    );
    persist();
  }

  // ---------- 网络 ----------

  function setOnline(value: boolean) {
    if (online.value === value) return;
    online.value = value;
    if (value) {
      log("网络恢复，开始回网合并", "info");
      syncAll();
    } else {
      log("已断网，新改动先记本地", "info");
    }
  }

  return {
    ledgers,
    resolutions,
    online,
    logs,
    fixingId,
    merged: mergedWithFlags,
    conflicts,
    pendingEntries,
    failedEntries,
    metrics,
    chartRows,
    submitBatch,
    syncAll,
    retryBatch,
    startFix,
    applyFix,
    cancelFix,
    removeEntry,
    resolveConflict,
    setOnline,
  };
});
