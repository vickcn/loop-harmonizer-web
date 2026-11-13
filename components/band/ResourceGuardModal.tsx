"use client";

import { useEffect, useState } from "react";
import {
  formatEstimatedMiB,
  type LowLoadActionId,
  type ResourceRiskAssessment,
} from "@/lib/band/resourceGuard";
import type { NetworkBatchEvaluation } from "@/lib/band/networkBudgetGuard";

export type ResourceGuardConfirmSelection = {
  applyLowLoadActions: LowLoadActionId[];
  allowOverBudgetNetwork: boolean;
};

type Props = {
  title: string;
  subtitle?: string;
  assessment: ResourceRiskAssessment | null;
  networkEvaluation?: NetworkBatchEvaluation | null;
  onConfirm: (selection: ResourceGuardConfirmSelection) => void;
  onCancel: () => void;
};

function formatMiBExact(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function riskBadgeText(level: ResourceRiskAssessment["riskLevel"]): { label: string; color: string; bg: string } {
  switch (level) {
    case "critical":
      return { label: "極高風險 (Critical)", color: "#fecaca", bg: "rgba(239, 68, 68, 0.22)" };
    case "high":
      return { label: "高風險 (High)", color: "#fde68a", bg: "rgba(245, 158, 11, 0.22)" };
    case "medium":
      return { label: "中等負載 (Medium)", color: "#bae6fd", bg: "rgba(56, 189, 248, 0.18)" };
    default:
      return { label: "低風險 (Low)", color: "#a7f3d0", bg: "rgba(52, 211, 153, 0.18)" };
  }
}

export function ResourceGuardModal({
  title,
  subtitle,
  assessment,
  networkEvaluation,
  onConfirm,
  onCancel,
}: Props) {
  const [selectedLowLoad, setSelectedLowLoad] = useState<Set<LowLoadActionId>>(() => {
    const initial = new Set<LowLoadActionId>();
    for (const item of assessment?.lowLoadSuggestions ?? []) {
      initial.add(item.id);
    }
    return initial;
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const badge = riskBadgeText(assessment?.riskLevel ?? (networkEvaluation?.failClosed ? "critical" : "high"));
  const hasSuggestions = (assessment?.lowLoadSuggestions.length ?? 0) > 0;
  const failClosedUnknown = Boolean(networkEvaluation?.failClosed);

  const toggleSuggestion = (id: LowLoadActionId) => {
    setSelectedLowLoad((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="resource-guard-modal-title"
      className="mixer-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="card mixer-modal-panel">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div className="grid" style={{ gap: 4 }}>
            <strong id="resource-guard-modal-title" style={{ fontSize: 16 }}>{title}</strong>
            {subtitle && <span className="small" style={{ opacity: 0.78 }}>{subtitle}</span>}
          </div>
          <span
            className="badge"
            style={{
              background: badge.bg,
              color: badge.color,
              borderColor: badge.color,
              flexShrink: 0,
            }}
          >
            {badge.label}
          </span>
        </div>

        {assessment && (
          <div className="grid mixer-modal-section" style={{ gap: 6 }}>
            <div className="small" style={{ opacity: 0.9 }}>
              預估記憶體需求：{formatEstimatedMiB(assessment.estimatedMemoryBytes)}
              {assessment.estimatedStorageBytes > 0
                ? ` ｜ 預估寫入快取：${formatEstimatedMiB(assessment.estimatedStorageBytes)}`
                : ""}
            </div>
            <div className="small" style={{ opacity: 0.78 }}>
              預估處理時間：{assessment.estimatedDurationLabel}
            </div>
            <ul className="mixer-modal-list">
              {assessment.reasons.map((reason, idx) => (
                <li key={idx} className="small">{reason}</li>
              ))}
            </ul>
            <div className="mixer-cap-grid small">
              <span>裝置 RAM：{assessment.capabilitiesSummary.deviceMemoryLabel}</span>
              <span>CPU 核心：{assessment.capabilitiesSummary.cpuCoresLabel}</span>
              <span>JS Heap：{assessment.capabilitiesSummary.jsHeapLabel}</span>
              <span>儲存空間：{assessment.capabilitiesSummary.storageLabel}</span>
            </div>
            {assessment.honestModeNote && (
              <p className="small" style={{ color: "#fde68a", margin: "4px 0 0" }}>
                {assessment.honestModeNote}
              </p>
            )}
          </div>
        )}

        {networkEvaluation && !networkEvaluation.allowed && (
          <div className="grid mixer-modal-section is-network" style={{ gap: 6 }}>
            <strong style={{ fontSize: 13, color: failClosedUnknown ? "#fca5a5" : "#bae6fd" }}>
              網路傳輸預算保護（預設上限 {formatMiBExact(networkEvaluation.budgetBytes)}）
            </strong>
            <span className="small">{networkEvaluation.message}</span>
            <div className="small" style={{ opacity: 0.85 }}>
              未快取預計下載：
              Vercel 本站靜態 {formatMiBExact(networkEvaluation.vercelStaticBytes)} ｜ 外部 CDN{" "}
              {formatMiBExact(networkEvaluation.externalCdnBytes)}
            </div>
            <ul className="mixer-modal-list">
              {networkEvaluation.items
                .filter((item) => !item.fromCache)
                .map((item, idx) => (
                  <li key={idx} className="small">
                    [{item.origin === "vercel-static" ? "Vercel 靜態" : item.origin === "external-cdn" ? "外部 CDN" : "未知來源"}]{" "}
                    {item.assetLabel}：{item.estimatedTransferBytes > 0 ? formatMiBExact(item.estimatedTransferBytes) : "大小未知"}
                  </li>
                ))}
            </ul>
          </div>
        )}

        {hasSuggestions && assessment && !failClosedUnknown && (
          <div className="grid mixer-modal-section" style={{ gap: 8 }}>
            <strong style={{ fontSize: 13 }}>可套用的安全降載策略（維持原始音質）</strong>
            {assessment.lowLoadSuggestions.map((item) => {
              const checked = selectedLowLoad.has(item.id);
              return (
                <label key={item.id} className="row mixer-modal-option">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSuggestion(item.id)}
                  />
                  <span className="grid" style={{ gap: 2 }}>
                    <span className="small" style={{ fontWeight: 600 }}>{item.label}</span>
                    <span className="small" style={{ opacity: 0.72 }}>{item.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        )}

        <div className="row mixer-modal-actions">
          <button
            type="button"
            className="btn mixer-button"
            onClick={onCancel}
          >
            取消
          </button>
          {!failClosedUnknown && (
            <>
              <button
                type="button"
                className="btn mixer-button"
                onClick={() =>
                  onConfirm({
                    applyLowLoadActions: [],
                    allowOverBudgetNetwork: Boolean(networkEvaluation && !networkEvaluation.allowed),
                  })
                }
              >
                直接繼續執行
              </button>
              {hasSuggestions && (
                <button
                  type="button"
                  className="btn mixer-button mixer-primary"
                  onClick={() =>
                    onConfirm({
                      applyLowLoadActions: [...selectedLowLoad],
                      allowOverBudgetNetwork: Boolean(networkEvaluation && !networkEvaluation.allowed),
                    })
                  }
                >
                  套用降載並繼續
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
