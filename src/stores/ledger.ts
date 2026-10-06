import { defineStore } from "pinia";

// 来源：巡检 / 调度台，两边各记一份油站信息
export type Source = "inspection" | "dispatch";
export const SOURCE_LABELS: Record<Source, string> = {
  inspection: "巡检",
  dispatch: "调度台",
};

export const AREAS = ["东区", "西区", "机场线"] as const;
export const STATUSES = ["营业中", "暂停营业", "库存紧张"] as const;

// 某一边（巡检或调度台）记录的油站信息
export type Side = {
  stock: number; // 库存摘要
  stockCountedAt: string; // 盘点时间（库存按这个时间比新旧）
  status: string; // 营业状态
  statusConfirmed: boolean; // 营业状态是否现场确认
  updatedAt: string; // 改动时间
};

// 一条油站台账：巡检、调度台各一份 side，合并后仍是一条
export type Station = {
  id: string;
  station: string;
  area: string;
  manager: string;
  note: string;
  sides: Record<Source, Side | null>;
  createdAt: string;
};

// 待确认清单：营业状态有争议、未现场确认的一边
export type PendingItem = {
  id: string;
  stationId: string;
  station: string;
  source: Source;
  status: string;
  reason: string;
  createdAt: string;
};

// 断网暂存 / 合并失败后留住原因重试的批次
export type OutboxItem = {
  id: string;
  records: IncomingRecord[];
  createdAt: string;
  attempts: number;
  lastError: string | null;
};

// 整批校验驳回的记录
export type RejectedItem = {
  station: string;
  area: string;
  reason: string;
};

// 录入的一条油站信息（带来源）
export type IncomingRecord = {
  station: string;
  area: string;
  stock: number;
  stockCountedAt: string;
  status: string;
  statusConfirmed: boolean;
  manager: string;
  note: string;
  source: Source;
};

export type MergedStation = {
  id: string;
  station: string;
  area: string;
  manager: string;
  note: string;
  stock: number;
  stockSource: Source | null;
  stockCountedAt: string;
  status: string;
  statusSource: Source | null;
  updatedAt: string;
  sides: Record<Source, Side | null>;
};

type PersistShape = {
  stations: Station[];
  pending: PendingItem[];
  outbox: OutboxItem[];
};

const STORAGE_KEY = "hxwlfront-21-station-ledger";

const now = () => new Date().toISOString();

function seedStations(): Station[] {
  const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
  return [
    {
      id: "seed-1",
      station: "东区一站",
      area: "东区",
      manager: "刘站长",
      note: "库存正常",
      createdAt: day(2),
      sides: {
        inspection: {
          stock: 36000,
          stockCountedAt: day(1),
          status: "营业中",
          statusConfirmed: true,
          updatedAt: day(1),
        },
        dispatch: {
          stock: 35200,
          stockCountedAt: day(2),
          status: "营业中",
          statusConfirmed: true,
          updatedAt: day(2),
        },
      },
    },
    {
      id: "seed-2",
      station: "机场快线站",
      area: "机场线",
      manager: "王站长",
      note: "柴油待补",
      createdAt: day(3),
      sides: {
        inspection: {
          stock: 9000,
          stockCountedAt: day(2),
          status: "库存紧张",
          statusConfirmed: true,
          updatedAt: day(2),
        },
        dispatch: {
          stock: 9600,
          stockCountedAt: day(1),
          status: "营业中",
          statusConfirmed: false,
          updatedAt: day(1),
        },
      },
    },
  ];
}

function load(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistShape>;
      return {
        stations: parsed.stations ?? seedStations(),
        pending: parsed.pending ?? [],
        outbox: parsed.outbox ?? [],
      };
    }
  } catch {
    // 本地数据损坏时回到种子数据
  }
  return { stations: seedStations(), pending: [], outbox: [] };
}

function sideEntries(sides: Record<Source, Side | null>): [Source, Side][] {
  return (Object.entries(sides) as [Source, Side | null][]).filter(
    (entry): entry is [Source, Side] => entry[1] !== null
  );
}

// 库存合并：盘点时间较新的一边赢；盘点时间相同则改动时间较新的赢
export function resolveStock(sides: Record<Source, Side | null>) {
  const entries = sideEntries(sides);
  if (entries.length === 0) {
    return { value: 0, source: null as Source | null, countedAt: "" };
  }
  if (entries.length === 1) {
    return {
      value: entries[0][1].stock,
      source: entries[0][0],
      countedAt: entries[0][1].stockCountedAt,
    };
  }
  const [a, b] = entries;
  if (a[1].stockCountedAt !== b[1].stockCountedAt) {
    const win = a[1].stockCountedAt > b[1].stockCountedAt ? a : b;
    return { value: win[1].stock, source: win[0], countedAt: win[1].stockCountedAt };
  }
  const win = a[1].updatedAt >= b[1].updatedAt ? a : b;
  return { value: win[1].stock, source: win[0], countedAt: win[1].stockCountedAt };
}

// 营业状态合并：听现场确认的；另一边进待确认清单，处置后才合成一条
export function resolveStatus(sides: Record<Source, Side | null>): {
  value: string;
  source: Source | null;
  pending: { source: Source; status: string; reason: string } | null;
} {
  const entries = sideEntries(sides);
  if (entries.length === 0) return { value: "", source: null, pending: null };
  if (entries.length === 1) {
    return { value: entries[0][1].status, source: entries[0][0], pending: null };
  }
  const [a, b] = entries;
  if (a[1].status === b[1].status) {
    return { value: a[1].status, source: a[0], pending: null };
  }
  const newer = a[1].updatedAt >= b[1].updatedAt ? a : b;
  const older = newer === a ? b : a;

  if (a[1].statusConfirmed && b[1].statusConfirmed) {
    // 两边都称现场确认：人工裁定，另一边先进待确认
    return {
      value: newer[1].status,
      source: newer[0],
      pending: { source: older[0], status: older[1].status, reason: "双方均标记现场确认，需人工裁定" },
    };
  }
  if (a[1].statusConfirmed) {
    return {
      value: a[1].status,
      source: a[0],
      pending: { source: b[0], status: b[1].status, reason: "该侧状态非现场确认" },
    };
  }
  if (b[1].statusConfirmed) {
    return {
      value: b[1].status,
      source: b[0],
      pending: { source: a[0], status: a[1].status, reason: "该侧状态非现场确认" },
    };
  }
  // 两边都没现场确认：维持较新改动，另一边进待确认
  return {
    value: newer[1].status,
    source: newer[0],
    pending: { source: older[0], status: older[1].status, reason: "双方均未现场确认" },
  };
}

function mergedView(station: Station): MergedStation {
  const stock = resolveStock(station.sides);
  const status = resolveStatus(station.sides);
  const updatedAt = sideEntries(station.sides)
    .map(([, side]) => side.updatedAt)
    .sort()
    .pop();
  return {
    id: station.id,
    station: station.station,
    area: station.area,
    manager: station.manager,
    note: station.note,
    stock: stock.value,
    stockSource: stock.source,
    stockCountedAt: stock.countedAt,
    status: status.value,
    statusSource: status.source,
    updatedAt: updatedAt ?? station.createdAt,
    sides: station.sides,
  };
}

function computeMergedList(stations: Station[]): MergedStation[] {
  return stations
    .map(mergedView)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export const useLedgerStore = defineStore("ledger", {
  state: () => ({
    stations: [] as Station[],
    pending: [] as PendingItem[],
    outbox: [] as OutboxItem[],
    rejected: [] as RejectedItem[],
    online: typeof navigator !== "undefined" ? navigator.onLine : true,
    merging: false,
    lastError: null as string | null,
    loaded: false,
  }),

  getters: {
    // 列表按合并结果，而不是某一边的原始记录
    mergedList(state): MergedStation[] {
      return computeMergedList(state.stations);
    },

    // 指标按合并结果统计
    metrics(state) {
      const list = computeMergedList(state.stations);
      return {
        total: list.length,
        open: list.filter((s) => s.status === "营业中").length,
        tight: list.filter((s) => s.status === "库存紧张").length,
        pending: state.pending.length,
        stockSum: list.reduce((acc, s) => acc + s.stock, 0),
      };
    },
  },

  actions: {
    init() {
      if (this.loaded) return;
      const data = load();
      this.stations = data.stations;
      this.pending = data.pending;
      this.outbox = data.outbox;
      this.loaded = true;
    },

    persist() {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ stations: this.stations, pending: this.pending, outbox: this.outbox })
      );
    },

    // 整批校验：重名或区域不在东区/西区/机场线，整批停下
    validateBatch(records: IncomingRecord[]): RejectedItem[] {
      const rejected: RejectedItem[] = [];
      const seen = new Set<string>();
      for (const record of records) {
        const name = record.station.trim();
        if (!AREAS.includes(record.area as (typeof AREAS)[number])) {
          rejected.push({
            station: name,
            area: record.area,
            reason: `区域「${record.area}」不在东区/西区/机场线`,
          });
          continue;
        }
        if (seen.has(name)) {
          rejected.push({ station: name, area: record.area, reason: "批次内重名" });
          continue;
        }
        seen.add(name);
      }
      return rejected;
    },

    // 提交一批记录：在线直接合并；断网先记本地；合并失败留住原因重试
    async submitBatch(records: IncomingRecord[]) {
      this.lastError = null;
      const rejected = this.validateBatch(records);
      if (rejected.length > 0) {
        this.rejected = rejected;
        return { ok: false as const, rejected };
      }
      this.rejected = [];

      if (!this.online) {
        this.outbox.push({
          id: crypto.randomUUID(),
          records: records.map((r) => ({ ...r })),
          createdAt: now(),
          attempts: 0,
          lastError: null,
        });
        this.persist();
        return { ok: true as const, queued: true as const };
      }

      try {
        for (const record of records) this.mergeRecord(record);
        this.persist();
        return { ok: true as const, queued: false as const };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.outbox.push({
          id: crypto.randomUUID(),
          records: records.map((r) => ({ ...r })),
          createdAt: now(),
          attempts: 1,
          lastError: reason,
        });
        this.lastError = reason;
        this.persist();
        return { ok: false as const, error: reason };
      }
    },

    // 合并一条带来源的记录到台账
    mergeRecord(record: IncomingRecord) {
      const side: Side = {
        stock: Number(record.stock) || 0,
        stockCountedAt: record.stockCountedAt || now(),
        status: record.status,
        statusConfirmed: !!record.statusConfirmed,
        updatedAt: now(),
      };
      const name = record.station.trim();
      let station = this.stations.find((s) => s.station === name);
      if (!station) {
        station = {
          id: crypto.randomUUID(),
          station: name,
          area: record.area,
          manager: record.manager,
          note: record.note,
          sides: { inspection: null, dispatch: null },
          createdAt: now(),
        };
        this.stations.unshift(station);
      } else {
        station.area = record.area;
        if (record.manager) station.manager = record.manager;
        if (record.note) station.note = record.note;
      }
      station.sides[record.source] = side;
      this.recomputePending(station);
    },

    // 两边都动过且状态不一致时，生成/更新该站的待确认清单项
    recomputePending(station: Station) {
      const resolution = resolveStatus(station.sides);
      this.pending = this.pending.filter((p) => p.stationId !== station.id);
      if (resolution.pending) {
        this.pending.push({
          id: crypto.randomUUID(),
          stationId: station.id,
          station: station.station,
          source: resolution.pending.source,
          status: resolution.pending.status,
          reason: resolution.pending.reason,
          createdAt: now(),
        });
      }
    },

    // 处置待确认项：确认现场状态（该侧转为现场确认后重新合成一条）或维持现状
    handlePending(id: string, action: "confirm" | "dismiss") {
      const item = this.pending.find((p) => p.id === id);
      if (!item) return;
      const station = this.stations.find((s) => s.id === item.stationId);
      if (action === "confirm" && station) {
        const side = station.sides[item.source];
        if (side) {
          side.statusConfirmed = true;
          side.updatedAt = now();
        }
        this.recomputePending(station);
      } else {
        this.pending = this.pending.filter((p) => p.id !== id);
      }
      this.persist();
    },

    // 回网后把本地暂存/失败批次重新合并
    async flushOutbox() {
      if (!this.online || this.merging) return;
      this.merging = true;
      this.lastError = null;
      const failed: OutboxItem[] = [];
      for (const item of this.outbox) {
        try {
          for (const record of item.records) this.mergeRecord(record);
        } catch (error) {
          failed.push({
            ...item,
            attempts: item.attempts + 1,
            lastError: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.outbox = failed;
      this.merging = false;
      this.persist();
    },

    // 单条失败批次重试，留住原因
    async retryItem(id: string) {
      const item = this.outbox.find((o) => o.id === id);
      if (!item || this.merging) return;
      if (!this.online) {
        this.lastError = "当前断网，无法合并";
        return;
      }
      this.merging = true;
      this.lastError = null;
      try {
        for (const record of item.records) this.mergeRecord(record);
        this.outbox = this.outbox.filter((o) => o.id !== id);
        this.persist();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        item.attempts += 1;
        item.lastError = reason;
        this.lastError = reason;
        this.persist();
      } finally {
        this.merging = false;
      }
    },

    setOnline(value: boolean) {
      this.online = value;
      if (value) void this.flushOutbox();
    },

    removeStation(id: string) {
      this.stations = this.stations.filter((s) => s.id !== id);
      this.pending = this.pending.filter((p) => p.stationId !== id);
      this.persist();
    },
  },
});
