"use client";

import { Fragment, useState } from "react";
import { ApiError, api, type ScenarioRunResponse } from "@/lib/api";
import { Card, ErrorBanner } from "@/components/ui";

export default function ScenariosScreen() {
  const [data, setData] = useState<ScenarioRunResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notReady, setNotReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setErr(null);
    setNotReady(false);
    setData(null);
    try {
      setData(await api.runScenarios());
    } catch (e) {
      if (e instanceof ApiError && e.status === 501) setNotReady(true);
      else setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-4 pb-28">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Scenarios</h1>
        <button
          onClick={run}
          disabled={running}
          className="rounded border border-zinc-400 px-3 py-1 text-sm disabled:opacity-40"
        >
          {running ? "Running…" : "Run all"}
        </button>
      </header>

      {notReady ? (
        <div className="text-sm text-amber-400">runner not ready yet</div>
      ) : null}
      <ErrorBanner msg={err} />

      {data ? (
        <>
          <div className="text-sm text-zinc-300">
            {data.passed}/{data.total} passed · wrongLogs {data.wrongLogs}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-400">
                <tr>
                  <th className="py-1 pr-2">id</th>
                  <th className="py-1 pr-2">title</th>
                  <th className="py-1 pr-2">result</th>
                  <th className="py-1 pr-2">kindsSeen</th>
                  <th className="py-1 pr-2">finalDecision</th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((r) => (
                  <Fragment key={r.id}>
                    <tr
                      onClick={() =>
                        setOpenId(openId === r.id ? null : r.id)
                      }
                      className="cursor-pointer border-t border-zinc-800"
                    >
                      <td className="py-1 pr-2 align-top">{r.id}</td>
                      <td className="py-1 pr-2 align-top">{r.title}</td>
                      <td className="py-1 pr-2 align-top">
                        <span
                          className={
                            r.pass ? "text-emerald-400" : "text-red-400"
                          }
                        >
                          {r.pass ? "PASS" : "FAIL"}
                        </span>
                      </td>
                      <td className="py-1 pr-2 align-top">
                        {r.kindsSeen?.join(", ")}
                      </td>
                      <td className="py-1 pr-2 align-top">{r.finalDecision}</td>
                    </tr>
                    {openId === r.id ? (
                      <tr className="border-t border-zinc-800">
                        <td colSpan={5} className="py-2">
                          <Card>
                            {r.failures?.length ? (
                              <div className="mb-2 text-red-300">
                                failures: {r.failures.join("; ")}
                              </div>
                            ) : null}
                            <div className="flex flex-col gap-1">
                              {r.transcript?.map((t, i) => (
                                <div key={i}>
                                  <span className="text-zinc-500">
                                    {t.role}
                                    {t.bargeIn ? " (barge-in)" : ""}
                                    {t.state ? ` [${t.state}]` : ""}:
                                  </span>{" "}
                                  {t.text}
                                </div>
                              ))}
                            </div>
                          </Card>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
