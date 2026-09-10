"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api,
  type ObservationDetail,
  type ObservationRow,
} from "@/lib/api";
import { Card, ErrorBanner } from "@/components/ui";

export default function ObservationsScreen() {
  const [rows, setRows] = useState<ObservationRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ObservationDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setRows(await api.observations());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (id: string) => {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    setDetailErr(null);
    try {
      setDetail(await api.observation(id));
    } catch (e) {
      setDetailErr((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-4 pb-28">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Observations</h1>
        <button
          onClick={load}
          className="rounded border border-zinc-600 px-2 py-1 text-xs"
        >
          Refresh
        </button>
      </header>

      {loading ? <div className="text-xs text-zinc-400">Loading…</div> : null}
      <ErrorBanner msg={err} />

      {rows && rows.length === 0 ? (
        <div className="text-sm text-zinc-400">No observations yet.</div>
      ) : null}

      {rows?.map((r) => (
        <div key={r.observation_id}>
          <button
            onClick={() => openDetail(r.observation_id)}
            className="w-full text-left"
          >
            <Card>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium">
                    {r.location_id} · {r.element} {r.attribute}
                  </div>
                  <div className="text-zinc-300">
                    {String(r.value_claimed)}
                    {r.unit ? ` ${r.unit}` : ""} · {r.drawing_id}
                  </div>
                  <div className="mt-1 text-xs text-zinc-400">
                    {r.final_decision}
                  </div>
                </div>
                {r.contradiction_flag ? (
                  <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" />
                ) : null}
              </div>
            </Card>
          </button>

          {openId === r.observation_id ? (
            <div className="mt-2">
              <ErrorBanner msg={detailErr} />
              {!detail && !detailErr ? (
                <div className="text-xs text-zinc-400">Loading detail…</div>
              ) : null}
              {detail ? (
                <Card title="Detail">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    <dt className="text-zinc-400">Drawing revision</dt>
                    <dd>
                      {String(
                        detail.revision_claimed ??
                          (detail.evidence?.drawing as Record<string, unknown>)
                            ?.revision ??
                          "—",
                      )}
                    </dd>
                    <dt className="text-zinc-400">Linked RFI</dt>
                    <dd>{detail.linked_rfi_id ?? "—"}</dd>
                    <dt className="text-zinc-400">Contradiction kinds</dt>
                    <dd>
                      {detail.contradiction_kinds?.length
                        ? detail.contradiction_kinds.join(", ")
                        : "—"}
                    </dd>
                    <dt className="text-zinc-400">Clarification asked</dt>
                    <dd>
                      {String(
                        detail.clarification_asked ??
                          detail.clarified ??
                          "—",
                      )}
                    </dd>
                  </dl>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-zinc-400">
                      raw
                    </summary>
                    <pre className="mt-1 overflow-x-auto text-[11px] text-zinc-400">
                      {JSON.stringify(detail, null, 2)}
                    </pre>
                  </details>
                </Card>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
