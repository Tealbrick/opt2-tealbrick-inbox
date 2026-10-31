// All approvals: every action that waits for the owner in every app of the workspace (op holds_overview). Deciding
// stays in the owning app: each row opens it through Portal; Operator Inbox's own items open here.
import { AppIcon, accessFilter, appArt, appName, ButtonLink, EmptyState, ListFilter, Notice, useAccessFilter } from "@opt2-tealbrick/ui";
import type { MouseEvent } from "react";
import type { HoldsOverviewOutput } from "#kit";
import { FILTER_FROM, filterKey } from "./filtering.ts";
import { ago, Head, LoadError, Loading, useOp } from "./shared.tsx";

/** Where scripts/build-ui.ts puts the stills (next to this module in the hashed asset directory, C61). */
const STILLS = new URL("./stills/", import.meta.url).href;

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

export function ApprovalsPage({ onOpenItem, itemHref }: { onOpenItem: (id: string) => void; itemHref: (id: string) => string }) {
  const { data, error, reload } = useOp<HoldsOverviewOutput>("holds_overview", {}, 30_000);
  const [query, setQuery] = useAccessFilter(filterKey("approvals"));
  const textFilter = accessFilter(query);
  // the overview reads every page of every app: this is the whole list, so a match is never "not loaded yet"
  const all = data?.rows ?? [];
  const rows = all.filter((r) => textFilter.test([r.summary, appName(r.product), r.caller.name, r.reason ?? r.op, r.op].join(" ")));
  const showBar = data !== null && (all.length >= FILTER_FROM || query.trim() !== "");
  return (
    <section className="app-page" aria-label="All approvals">
      <Head title="All approvals" lede="Every action that waits for you, in every app of this workspace." />
      {error ? <LoadError message={error} onRetry={reload} /> : null}
      {!data ? (
        error ? null : <Loading what="approvals" />
      ) : (
        <>
          {data.unavailable ? <Notice>{data.unavailable}</Notice> : null}
          {data.rows.length === 0 ? (
            <EmptyState title="Nothing waits for your approval." />
          ) : (
            <>
            {showBar ? (
              <ListFilter
                label="Filter the approvals"
                value={query}
                onChange={setQuery}
                filter={textFilter}
                placeholder="Summary, app, agent, or a regex"
                noun={{ one: "approval", many: "approvals" }}
                shown={rows.length}
                total={all.length}
                onClear={() => setQuery("")}
                hidden={all.length - rows.length}
                hiddenNoun={{ one: "approval that waits for you", many: "approvals that wait for you" }}
              />
            ) : null}
            <div className="ruled">
              {rows.map((r) => {
                const name = appName(r.product);
                return (
                  <div className="item" key={`${r.product}/${r.id}`}>
                    <AppIcon art={appArt(r.product, STILLS)} name={name} size={32} />
                    <h3>{r.summary}</h3>
                    <span className="meta">
                      {name} · {r.caller.name} · {r.reason ?? r.op} · {ago(r.createdAt)}
                    </span>
                    <div className="side">
                      {r.product === "inbox" ? (
                        <ButtonLink
                          size="sm"
                          href={itemHref(r.id)}
                          onClick={(e) => {
                            if (!plainClick(e)) return;
                            e.preventDefault();
                            onOpenItem(r.id);
                          }}
                        >
                          Open
                        </ButtonLink>
                      ) : r.openUrl ? (
                        // Portal opens the owning app at its decision page (launch ticket); deciding happens there
                        <ButtonLink size="sm" href={r.openUrl} target="_blank" rel="noopener noreferrer">
                          Open in {name}
                        </ButtonLink>
                      ) : (
                        <span className="tb-hint">Open {name} from Portal to decide.</span>
                      )}
                      {r.allowAlwaysUrl ? (
                        // C277 A2 (RU-11): Rules holds only. The link is built by the server; Rules opens with a NEW allow rule, nothing is saved here.
                        <ButtonLink variant="quiet" size="sm" href={r.allowAlwaysUrl} target="_blank" rel="noopener noreferrer" aria-describedby={`allow-hint-${r.id}`}>
                          Allow always…
                        </ButtonLink>
                      ) : null}
                    </div>
                    {r.allowAlwaysUrl ? (
                      <p className="tb-hint" id={`allow-hint-${r.id}`}>
                        Opens Rules with a new allow rule. Nothing changes until you save it there.
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            </>
          )}
          {data.errors.map((e) => (
            <Notice key={e.product} tone="needs-you" role="alert">
              <strong>{appName(e.product)}:</strong> its approvals could not be read ({e.code}).
            </Notice>
          ))}
        </>
      )}
    </section>
  );
}
