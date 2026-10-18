// Settings: the optional owner alert DM (op alerts_get / alerts_set; off by default) and the Activity numbers (op inbox_metrics).
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Field, Notice, Section, Segmented, Select, TextInput } from "@opt2-tealbrick/ui";
import { useEffect, useRef, useState } from "react";
import type { AlertsGetOutput, InboxMetricsOutput } from "#kit";
import { errText, Head, LoadError, Loading, useOp } from "./shared.tsx";

/** "4 min", "2 h", "1.5 h", "3 d"; "—" when there is no value. */
export function duration(s: number | null): string {
  if (s === null) return "—";
  const trim = (n: number) => String(Math.round(n * 10) / 10);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${trim(s / 3600)} h`;
  return `${trim(s / 86400)} d`;
}
/** A share 0..1 as a percentage ("12.5%"); "—" for null (no items to divide by). */
export const percent = (r: number | null): string => (r === null ? "—" : `${Math.round(r * 1000) / 10}%`);

/** Activity: counts and times of the last 7 or 30 days (op inbox_metrics; definitions in ARCHITECTURE.md). Text only. */
function ActivitySection() {
  const [days, setDays] = useState<7 | 30>(7);
  const { data, error, reload } = useOp<InboxMetricsOutput>("inbox_metrics", { days });
  // keep the numbers of the other window out of sight while the new window loads
  const shown = data && data.window.days === days ? data : null;
  return (
    <Section title="Activity">
      <p className="tb-soft measure">Items created in the window, by their status now. Withdrawn items are counted apart from expired ones.</p>
      <div>
        <Segmented
          label="Window"
          value={String(days) as "7" | "30"}
          onChange={(v) => setDays(v === "30" ? 30 : 7)}
          options={[
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
          ]}
        />
      </div>
      {error ? <LoadError message={error} onRetry={reload} /> : null}
      {shown ? (
        <dl className="kv" aria-label={`Activity, last ${days} days`}>
          <dt>Asked</dt>
          <dd>{shown.asked}</dd>
          <dt>Answered</dt>
          <dd>{shown.answered}</dd>
          <dt>Expired</dt>
          <dd>{shown.expired}</dd>
          <dt>Withdrawn</dt>
          <dd>{shown.withdrawn}</dd>
          <dt>Open</dt>
          <dd>{shown.open}</dd>
          <dt>Time to decision, median</dt>
          <dd>{duration(shown.timeToDecision.p50S)}</dd>
          <dt>Time to decision, 90th percentile</dt>
          <dd>{duration(shown.timeToDecision.p90S)}</dd>
          <dt>Expiry rate</dt>
          <dd>{percent(shown.expiryRate)}</dd>
          <dt>Re-ask rate</dt>
          <dd>{percent(shown.reAskRate)}</dd>
        </dl>
      ) : error ? null : (
        <Loading what="the activity" />
      )}
    </Section>
  );
}

export function SettingsPage() {
  const { data, error, reload } = useOp<AlertsGetOutput>("alerts_get", {});
  const [form, setForm] = useState<AlertsGetOutput | null>(null);
  const [notice, setNotice] = useState<{ status: "live" | "needs-you"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const inflight = useRef(false);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);
  const save = async () => {
    if (!form || inflight.current) return;
    inflight.current = true;
    setSaving(true);
    setNotice(null);
    try {
      setForm(await callOp<AlertsGetOutput>("alerts_set", form as unknown as Json));
      setNotice({ status: "live", text: "Saved." });
      reload();
    } catch (e) {
      setNotice({ status: "needs-you", text: errText(e) });
    } finally {
      inflight.current = false;
      setSaving(false);
    }
  };
  const set = (patch: Partial<AlertsGetOutput>) => form && setForm({ ...form, ...patch });
  return (
    <section className="app-page" aria-label="Settings">
      <Head title="Settings" />
      {error ? <LoadError message={error} onRetry={reload} /> : null}
      {!form ? (
        error ? null : <Loading what="the settings" />
      ) : (
        <Section title="Alerts" first>
          <p className="tb-soft measure">
            New items always show in this inbox and in the Tealbrick desktop badge. You can also get a direct message for each new item. It goes out through Connect from the workspace
            sender you choose on Connect’s Senders page.
          </p>
          <div className="tb-stack form">
            <Field label="Direct message">
              <Select
                value={form.dm}
                onValueChange={(dm) => set({ dm: dm as AlertsGetOutput["dm"] })}
                options={[
                  { value: "off", label: "Off" },
                  { value: "buzz", label: "Buzz DM" },
                  { value: "channel", label: "Slack or Telegram DM", meta: "a Connect channel account" },
                ]}
              />
            </Field>
            {form.dm === "buzz" ? (
              <Field label="Your Buzz key" hint="npub1… or 64 hex characters">
                <TextInput className="mono" value={form.buzzTo ?? ""} onChange={(e) => set({ buzzTo: e.target.value })} />
              </Field>
            ) : null}
            {form.dm === "channel" ? (
              <>
                <Field label="Connect channel account id" hint="From Connect’s channel accounts.">
                  <TextInput value={form.channelAccount ?? ""} onChange={(e) => set({ channelAccount: e.target.value })} />
                </Field>
                <Field label="Your handle in that channel">
                  <TextInput value={form.channelPerson ?? ""} onChange={(e) => set({ channelPerson: e.target.value })} />
                </Field>
              </>
            ) : null}
          </div>
          {notice ? (
            <Notice tone={notice.status} role={notice.status === "needs-you" ? "alert" : "status"}>
              {notice.text}
            </Notice>
          ) : null}
          <div className="tb-ctas">
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </Section>
      )}
      <ActivitySection />
    </section>
  );
}
