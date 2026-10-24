// Settings: the optional owner alert DM (op alerts_get / alerts_set). Off by default.
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Field, Notice, Section, Select, Switch, TextInput } from "@opt2-tealbrick/ui";
import { useEffect, useRef, useState } from "react";
import type { AlertsGetOutput } from "#kit";
import { errText, Head, LoadError, Loading, useOp } from "./shared.tsx";

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
              <>
                <Field label="Your Buzz key" hint="npub1… or 64 hex characters">
                  <TextInput className="mono" value={form.buzzTo ?? ""} onChange={(e) => set({ buzzTo: e.target.value })} />
                </Field>
                <Switch label="Answer approvals from Buzz (react ✅ or ❌ on the alert)" checked={form.buttons} onCheckedChange={(buttons) => set({ buttons })} />
                <p className="tb-hint measure">
                  Only your own signed reaction counts, once, for 24 hours at most. The first ✅ or ❌ decides; removing it later changes nothing. A text reply never
                  decides. Approvals that spend money or delete data, and approvals without a declared kind, never take reactions: you decide them here.
                </p>
              </>
            ) : null}
            {form.dm === "channel" ? (
              <>
                <Field label="Connect channel account id" hint="From Connect’s channel accounts.">
                  <TextInput value={form.channelAccount ?? ""} onChange={(e) => set({ channelAccount: e.target.value })} />
                </Field>
                <Field label="Your handle in that channel">
                  <TextInput value={form.channelPerson ?? ""} onChange={(e) => set({ channelPerson: e.target.value })} />
                </Field>
                <Switch label="Answer approvals from the chat (Approve and Deny buttons)" checked={form.buttons} onCheckedChange={(buttons) => set({ buttons })} />
                <p className="tb-hint measure">
                  Only you can use the buttons, once, for 24 hours at most. Approvals that spend money or delete data, and approvals without a declared kind, never get
                  buttons: you decide them here. Turning this off stops every button that was already sent.
                </p>
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
    </section>
  );
}
