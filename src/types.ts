export type Source = "inspection" | "dispatch";

export const SOURCE_LABEL: Record<Source, string> = {
  inspection: "巡检",
  dispatch: "调度台",
};

export const AREAS = ["东区", "西区", "机场线"] as const;
export const STATUSES = ["营业中", "暂停营业", "库存紧张"] as const;

export type SyncState = "pending" | "synced" | "failed";

export const SYNC_LABEL: Record<SyncState, string> = {
  pending: "待同步",
  synced: "已同步",
  failed: "同步失败",
};

/** 表单/批量导入提交的台账内容 */
export interface StationPayload {
  station: string;
  area: string;
  stock: number;
  stockAt: string; // 盘点时间 ISO
  status: string;
  confirmed: boolean; // 现场确认
  manager: string;
  notes: string;
}

/** 某一侧台账里的一条记录（带改动时间、来源、同步状态） */
export interface LedgerEntry extends StationPayload {
  id: string;
  batchId: string;
  source: Source;
  updatedAt: string; // 改动时间
  syncState: SyncState;
  failReason?: string;
}

export type ConflictField = "stock" | "status";

export const FIELD_LABEL: Record<ConflictField, string> = {
  stock: "库存",
  status: "营业状态",
};

export interface ConflictSide {
  source: Source;
  value: string | number;
  at: string; // stock 用盘点时间，status 用改动时间
  confirmed?: boolean;
}

/** 两边都动过同一站时产生的待确认项（由合并计算派生） */
export interface Conflict {
  id: string;
  station: string;
  field: ConflictField;
  kept: ConflictSide; // 合并采用的一方
  dropped: ConflictSide; // 被压过、待确认的一方
  reason: string;
}

/** 处置记录：处置后回写收敛，两边合成一条 */
export interface Resolution {
  id: string;
  station: string;
  field: ConflictField;
  choice: "keep" | "adopt"; // keep=维持合并值 adopt=改用被压一方的值
  kept: ConflictSide;
  dropped: ConflictSide;
  at: string;
}

/** 合并台账里的一站（指标和列表都按它算） */
export interface MergedStation {
  station: string;
  area: string;
  stock: number;
  stockAt: string;
  stockSource: Source;
  status: string;
  statusSource: Source;
  confirmed: boolean;
  manager: string;
  notes: string;
  sources: Source[];
  updatedAt: string;
  openConflicts: number; // >0 表示还有待确认项，未最终合成
}

export interface LogEntry {
  id: string;
  time: string;
  text: string;
  kind: "ok" | "fail" | "info";
}

export interface SubmitResult {
  ok: boolean;
  queued?: boolean; // 断网时先记本地
  errors?: string[]; // 整批停下时的未入库说明
}
