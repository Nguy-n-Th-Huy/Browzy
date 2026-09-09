// Usage ledger view model (tasks.md 5.5, panel half): pure descriptors that
// keep the FIVE usage kinds visually and textually distinct, per spec
// "Usage, profile, and workflow status":
//
//   - local limits: the wall-clock/model-turn ADMISSION counter this app
//     enforces itself (conversationMetadata.budgetPolicy). The ONLY thing
//     that can disable send.
//   - SDK estimates: cost-table figures with their costBasis, labeled as
//     estimates — including the maxBudgetUsd estimated-budget stop, which is
//     never presented as a hard dollar billing limit.
//   - external billing: shown ONLY when corroborated by external provider
//     evidence; otherwise the billing slot reads "unknown", never a number.
//   - pending: in-flight/cancelled-before-result intervals, still open.
//   - unknown: usage known but billing untrusted, or intervals never observed.
//
// No DOM, no chrome.* — sidepanel.js (owned by another session right now)
// does the rendering; this module decides WHAT each row means so the copy
// can never conflate an estimate with a bill.

/**
 * @param {object} params
 * @param {object|null} params.policy - effective limits (resolveEffectiveLimits shape)
 * @param {object|null} params.totals - UsageLedger.totals() shape
 * @param {object|null} params.lastStop - {kind: "sdk_estimated_budget"|"local_limit"|null, detail} when the last run stopped on a limit
 * @returns {{limits: Array, billing: object, pending: object, canSend: boolean, sendBlockedReason: string|null}}
 */
export function describeUsageState({ policy = null, totals = null, lastStop = null } = {}) {
  const limits = [];
  if (policy) {
    if (policy.maxTurns != null) {
      limits.push({
        kind: "local",
        key: "maxTurns",
        label: `Giới hạn cục bộ: tối đa ${policy.maxTurns} vòng gọi công cụ`,
        blocksSend: true
      });
    }
    if (policy.wallClockDeadlineMs != null) {
      limits.push({
        kind: "local",
        key: "wallClockDeadlineMs",
        label: `Giới hạn cục bộ: tối đa ${Math.round(policy.wallClockDeadlineMs / 1000)} giây mỗi lượt chạy`,
        blocksSend: true
      });
    }
    if (policy.maxBudgetUsd != null) {
      limits.push({
        kind: "sdk_estimate",
        key: "maxBudgetUsd",
        label: `Ngưỡng ước tính của SDK: khoảng $${policy.maxBudgetUsd} (ước tính theo bảng giá, KHÔNG phải hóa đơn thực tế)`,
        blocksSend: false
      });
    }
  }

  const billing = totals
    ? totals.unknownCostRows > 0
      ? {
          kind: "unknown",
          label: "Chi phí thực tế: không rõ — chưa có bằng chứng thanh toán từ nhà cung cấp. Con số ước tính của SDK không phải hóa đơn."
        }
      : {
          kind: "estimated",
          label: `Chi phí ước tính của SDK: khoảng $${totals.costUsdEstimatedPartial.toFixed(4)} (ước tính theo bảng giá, KHÔNG phải hóa đơn thực tế).`
        }
    : { kind: "unknown", label: "Chưa có dữ liệu sử dụng." };

  const pending = totals
    ? {
        pendingRows: totals.pendingRows,
        label:
          totals.pendingRows > 0
            ? `${totals.pendingRows} khoảng sử dụng chưa chốt (đang chạy/đã hủy/mất kết quả) — chưa tính, không tính là 0.`
            : "Không có khoảng sử dụng nào đang dở."
      }
    : { pendingRows: 0, label: "Không có khoảng sử dụng nào đang dở." };

  let stopNotice = null;
  if (lastStop && lastStop.kind === "sdk_estimated_budget") {
    stopNotice = "Lượt chạy dừng do ngưỡng ước tính của SDK (không phải giới hạn hóa đơn). Chi phí thực tế vẫn không rõ.";
  } else if (lastStop && lastStop.kind === "local_limit") {
    stopNotice = `Lượt chạy dừng do giới hạn cục bộ${lastStop.detail ? `: ${lastStop.detail}` : ""}. Các lệnh đã gửi trước đó không bị hủy ngược.`;
  }

  // Only a verified LOCAL limit (or a missing profile/session, decided
  // elsewhere) disables send — an SDK estimate never does by itself.
  const localHit = lastStop && lastStop.kind === "local_limit";
  return {
    limits,
    billing,
    pending,
    stopNotice,
    canSend: !localHit,
    sendBlockedReason: localHit ? stopNotice : null
  };
}
