// The Inbox page: the queue (Waiting / Snoozed / Done / All) and the one open item with its thread, the owner's message
// and the answer buttons. Every call that can fail shows its error in a Notice next to the buttons (RUL-01): nothing is
// started with a bare `void` that has no catch.
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { callOp, TbError } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, ButtonLink, EmptyState, Field, Notice, Select, type Status, Tabs, Tag, Textarea } from "@opt2-tealbrick/ui";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import type { ItemGetOutput, ItemsListOutput } from "#kit";
import { ago, day, errText, Head, LoadError, Loading, useOp, when, whenShort } from "./shared.tsx";

type View = "pending" | "snoozed" | "done" | "all";
type Summary = ItemsListOutput["items"][number];
type Response = ItemGetOutput["responses"][number];
type Activity = ItemGetOutput["activity"][number];
type Priority = Summary["priority"];

const PRIORITY_STATUS: Record<Priority, Status> = { urgent: "needs-you", high: "needs-you", normal: "default", low: "default" };
/** IN-2: the declared hold family as the owner reads it. */
const FAMILY_LABEL: Record<string, string> = {
  destructive: "deletes data",
  money: "spends money",
  first_contact: "first contact",
  identity: "identity",
  public_link: "public link",
};

/** IN-2: "Slack" / "Telegram" when the answer came from a chat button (decidedBy `<service>:<user id>`), else null. */
function viaChat(decidedBy: string): string | null {
  const service = /^(slack|telegram|teams|discord):/.exec(decidedBy)?.[1];
  return service ? `${service[0]?.toUpperCase()}${service.slice(1)}` : null;
}

const PRIORITY_LABEL: Record<Priority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
const LABEL: Record<Response, string> = { approve: "Approve", deny: "Deny", answer: "Send answer", clarify: "Ask for clarification" };
const VARIANT: Record<Response, "primary" | "danger" | "secondary"> = { approve: "primary", answer: "primary", deny: "danger", clarify: "secondary" };
const DONE_LABEL: Record<Response, string> = { approve: "Approved", deny: "Denied", answer: "Answered", clarify: "Clarification asked" };
const REFUSAL_TEXT: Record<string, string> = {
  not_raiser: "not the caller that raised this item",
  unknown_item: "no such item",
  no_product: "the calling app has no verified product",
};
const ALERT_ERRORS: Record<string, string> = {
  withdrawn: "the item was withdrawn before the alert was sent",
  no_sender_identity: "open Connect, Senders, and choose the workspace sender for app messages",
  no_grant: "Connect is not in this workspace",
  denied: "you denied it in Connect",
  quiet_hours: "waits for your quiet hours to end",
  closed: "the item was answered or expired before it was sent",
  alerts_off: "you turned alerts off",
  alerts_changed: "you changed the alert settings",
};
const SNOOZE: { value: string; label: string; ms: number }[] = [
  { value: "1h", label: "1 hour", ms: 3600_000 },
  { value: "4h", label: "4 hours", ms: 4 * 3600_000 },
  { value: "1d", label: "1 day", ms: 86400_000 },
  { value: "1w", label: "1 week", ms: 7 * 86400_000 },
];
const WAKE = "wake";

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

function Row({ item, active, href, onOpen }: { item: Summary; active: boolean; href: string; onOpen: () => void }) {
  return (
    <a
      className="inbox-row"
      href={href}
      aria-current={active ? "true" : undefined}
      onClick={(e) => {
        if (!plainClick(e)) return;
        e.preventDefault();
        onOpen();
      }}
    >
      <b>{item.title}</b>
      <span className="meta">
        {item.from.name} · {item.kind === "approval" ? "approval" : "question"} · {ago(item.createdAt)}
      </span>
      {item.priority !== "normal" || item.status !== "open" || item.snoozedUntil ? (
        <span className="tb-row">
          {item.priority !== "normal" ? <Tag status={PRIORITY_STATUS[item.priority]}>{PRIORITY_LABEL[item.priority]}</Tag> : null}
          {item.status === "answered" ? <Tag status="live">{item.response ? DONE_LABEL[item.response] : "Answered"}</Tag> : null}
          {item.status === "expired" ? <Tag>{item.withdrawn ? "Withdrawn" : "Expired"}</Tag> : null}
          {item.snoozedUntil ? <Tag>Snoozed</Tag> : null}
        </span>
      ) : null}
    </a>
  );
}

type Result = { status: "live" | "needs-you"; text: string };

/** One line of the item history. Every value is agent- or app-supplied text and goes through React (escaped), never as markup. */
function ActivityLine({ a, owner }: { a: Activity; owner: string }) {
  const who = `${a.actor.name}${a.actor.product ? ` (${a.actor.product})` : ""}`;
  return (
    <li>
      <b>{a.kind === "withdrawn" ? `Withdrawn by ${owner}` : `Withdraw refused for ${who}`}</b> <span className="meta">{ago(a.at)}</span>
      {a.kind === "withdraw_refused" ? (
        <p>
          {REFUSAL_TEXT[a.detail ?? ""] ?? "refused"}
          {a.count > 1 ? ` (${a.count} attempts)` : ""}
        </p>
      ) : null}
    </li>
  );
}

function Detail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { data: item, error, reload } = useOp<ItemGetOutput>("item_get", { itemId: id }, 15_000);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false); // one call at a time per item, also for a second click before React re-renders
  const [result, setResult] = useState<Result | null>(null);
  // The version the owner has read. A poll may bring a newer one (the agent added a message); answers keep using the
  // read version until the owner confirms the new text, so an answer on unread text is refused as stale (409).
  const [seen, setSeen] = useState<number | null>(null);

  useEffect(() => {
    if (item && seen === null) setSeen(item.version);
  }, [item, seen]);

  const act = async (op: string, input: Json, done?: string) => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setResult(null);
    try {
      await callOp(op, input);
      if (done) setResult({ status: "live", text: done });
      setSeen(null);
      setMessage("");
      onChanged();
    } catch (e) {
      const stale = e instanceof TbError && e.code === "stale_version";
      setResult({ status: "needs-you", text: stale ? "The agent added a message while you were reading. Read it, then answer again." : errText(e) });
    } finally {
      inflight.current = false;
      setBusy(false);
      reload();
    }
  };

  if (!item) return error ? <LoadError message={error} onRetry={reload} /> : <Loading what="the item" />;
  const open = item.status === "open";
  const version = seen ?? item.version;
  const unread = open && version < item.version;
  const snoozeLabel = item.snoozedUntil ? `Until ${whenShort(item.snoozedUntil)}` : "Not snoozed";
  return (
    <article className="detail" aria-label={item.title}>
      {error ? <LoadError message={error} onRetry={reload} /> : null}
      <p className="meta">
        {item.from.name} · {item.kind === "approval" ? "asks for your approval" : "asks a question"} · {when(item.createdAt)}
      </p>
      <h2>{item.title}</h2>
      <div className="tb-row">
        {open ? <Tag status="needs-you">waiting for you</Tag> : <Tag status={item.status === "answered" ? "live" : "default"}>{item.withdrawal ? "withdrawn" : item.status}</Tag>}
        <Tag status={PRIORITY_STATUS[item.priority]}>{PRIORITY_LABEL[item.priority]}</Tag>
        {item.acked && open ? <Tag>seen</Tag> : null}
        {item.family && item.family !== "none" ? <Tag>{FAMILY_LABEL[item.family]}</Tag> : null}
        {open ? <span className="tb-hint">Expires {day(item.expiresAt)}</span> : null}
      </div>
      {item.context ? <p className="tb-soft pre">{item.context}</p> : <p className="tb-hint">The agent gave no further context.</p>}
      {item.open ? (
        // R5: Portal opens the raising app at the page it named (launch ticket); the link names its verified product
        <p className="tb-row">
          <ButtonLink size="sm" href={item.open.url} target="_blank" rel="noopener noreferrer">
            Open in {item.open.app}
          </ButtonLink>
        </p>
      ) : null}
      {item.messages.length > 0 ? (
        <ol className="msgs" aria-label="Messages">
          {item.messages.map((m) => (
            <li key={m.id}>
              <b>{m.author === "owner" ? "You" : item.from.name}</b> <span className="meta">{ago(m.createdAt)}</span>
              <p className="pre">{m.body}</p>
            </li>
          ))}
        </ol>
      ) : null}
      {item.decision ? (
        <Notice tone="live">
          <strong>You answered {item.decision.response}</strong> {when(item.decision.decidedAt)}
          {viaChat(item.decision.decidedBy) ? ` in ${viaChat(item.decision.decidedBy)}` : ""}.
        </Notice>
      ) : null}
      {item.withdrawal ? (
        <Notice tone="neutral">
          <strong>Withdrawn by {item.from.name}</strong> {when(item.withdrawal.at)}. It no longer needs an answer.
          {item.withdrawal.reason ? (
            <>
              {" "}
              Reason: <span className="pre">{item.withdrawal.reason}</span>
            </>
          ) : null}
        </Notice>
      ) : null}
      {item.status === "expired" && !item.withdrawal ? <Notice tone="needs-you">This item expired before it was answered. The agent must ask again.</Notice> : null}
      {item.activity.length > 0 ? (
        <ol className="msgs" aria-label="History">
          {item.activity.map((a) => (
            <ActivityLine key={a.id} a={a} owner={item.from.name} />
          ))}
        </ol>
      ) : null}
      {unread ? (
        <Notice tone="needs-you" role="alert" className="with-action">
          <span className="tb-row">
            <span>
              <strong>The agent added a message after you opened this item.</strong> Read it before you answer.
            </span>
            <Button size="sm" onClick={() => setSeen(item.version)}>
              I have read it
            </Button>
          </span>
        </Notice>
      ) : null}
      {open ? (
        <>
          <Field label="Message to the agent" hint="Needed to answer or to ask for clarification; optional for approve and deny.">
            <Textarea rows={2} maxLength={4000} value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <div className="tb-ctas">
            {item.responses.map((r) => (
              <Button
                key={r}
                variant={VARIANT[r]}
                disabled={busy || ((r === "answer" || r === "clarify") && !message.trim())}
                onClick={() =>
                  void act("item_decide", { itemId: item.id, version, response: r, ...(message.trim() ? { message: message.trim() } : {}) }, "Answer sent. The agent reads it on its next check.")
                }
              >
                {LABEL[r]}
              </Button>
            ))}
            {item.acked ? null : (
              <Button variant="quiet" disabled={busy} onClick={() => void act("item_ack", { itemId: item.id })}>
                Mark as seen
              </Button>
            )}
          </div>
          <div className="pair">
            <Field label="Priority">
              <Select
                value={item.priority}
                disabled={busy}
                onValueChange={(p) => {
                  if (p !== item.priority) void act("item_priority", { itemId: item.id, priority: p });
                }}
                options={(["low", "normal", "high", "urgent"] as const).map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
              />
            </Field>
            <Field label="Snooze">
              <Select
                value=""
                disabled={busy}
                onValueChange={(v) => {
                  const s = SNOOZE.find((x) => x.value === v);
                  if (s) void act("item_snooze", { itemId: item.id, until: new Date(Date.now() + s.ms).toISOString() }, `Snoozed for ${s.label}.`);
                  else if (v === WAKE) void act("item_snooze", { itemId: item.id, until: null }, "Woken up.");
                }}
                options={[{ value: "", label: snoozeLabel }, ...SNOOZE.map(({ value, label }) => ({ value, label })), ...(item.snoozedUntil ? [{ value: WAKE, label: "Wake now" }] : [])]}
              />
            </Field>
          </div>
        </>
      ) : null}
      {result ? (
        <Notice tone={result.status} role={result.status === "needs-you" ? "alert" : "status"}>
          {result.text}
        </Notice>
      ) : null}
      {item.deliveries.length > 0 ? (
        <p className="tb-hint">
          Alert:{" "}
          {item.deliveries
            .map((d) => `${d.channel === "buzz" ? "Buzz DM" : "channel DM"} ${d.status === "held" ? "waits for your approval in Connect" : d.status}${d.error ? ` (${ALERT_ERRORS[d.error] ?? d.error})` : ""}`)
            .join("; ")}
        </p>
      ) : null}
      {item.digest ? (
        <p className="tb-hint">
          Alert:{" "}
          {item.digest.status === "next"
            ? `in the next digest (about ${whenShort(item.digest.at)})`
            : item.digest.status === "sent"
              ? `sent in the digest ${ago(item.digest.at)}`
              : item.digest.status === "held"
                ? "the digest waits for your approval in Connect"
                : item.digest.status === "pending"
                  ? `the digest is being sent${item.digest.error ? ` (${ALERT_ERRORS[item.digest.error] ?? item.digest.error})` : ""}`
                  : `the digest failed${item.digest.error ? ` (${ALERT_ERRORS[item.digest.error] ?? item.digest.error})` : ""}`}
        </p>
      ) : null}
    </article>
  );
}

const EMPTY: Record<View, string> = {
  pending: "Nothing waits for you.",
  snoozed: "No snoozed items.",
  done: "No answered, expired or withdrawn items yet.",
  all: "No items yet.",
};

export function InboxPage({ selected, onSelect, onCounts, hrefOf }: { selected: string | null; onSelect: (id: string) => void; onCounts: (n: number) => void; hrefOf: (id: string) => string }) {
  const [view, setView] = useState<View>("pending");
  const { data, error, reload } = useOp<ItemsListOutput>("items_list", { view, limit: 100 }, 15_000);
  useEffect(() => {
    if (data) onCounts(data.counts.pending);
  }, [data, onCounts]);
  return (
    <section className="app-page" aria-label="Inbox">
      <Head title="Inbox" />
      <div className="inbox">
        <div className="tb-stack inbox-list">
          <Tabs
            label="Show"
            value={view}
            onChange={setView}
            tabs={[
              { value: "pending", label: data ? `Waiting (${data.counts.pending})` : "Waiting" },
              { value: "snoozed", label: data ? `Snoozed (${data.counts.snoozed})` : "Snoozed" },
              { value: "done", label: "Done" },
              { value: "all", label: "All" },
            ]}
          />
          {error ? <LoadError message={error} onRetry={reload} /> : null}
          {!data ? (
            error ? null : <Loading what="the inbox" />
          ) : data.items.length === 0 ? (
            <EmptyState title={EMPTY[view]}>{view === "pending" ? "Your agents’ questions and approval requests appear here." : undefined}</EmptyState>
          ) : (
            <nav className="ruled" aria-label="Items">
              {data.items.map((i) => (
                <Row key={i.id} item={i} active={i.id === selected} href={hrefOf(i.id)} onOpen={() => onSelect(i.id)} />
              ))}
            </nav>
          )}
        </div>
        <div>{selected ? <Detail key={selected} id={selected} onChanged={reload} /> : <EmptyState title="Select an item to read it and answer." />}</div>
      </div>
    </section>
  );
}
