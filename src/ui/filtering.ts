// What the long lists of Operator Inbox share for the kit filter (C382 batch 4): the remembered key, one per screen
// (`tb-filter:inbox:<screen>`), and the length from which a list gets a filter bar.

/** A list shorter than this shows no filter bar, unless a filter is on, or the list is paged. */
export const FILTER_FROM = 8;

/**
 * The overview (src/holds.ts, src/app.ts) reads at most this many rows of each app (3 pages of 100) and at most this many of
 * Operator Inbox's own open items. A group that reaches its cap may be cut, and the overview does not say so.
 */
export const APP_ROWS_MOST = 300;
export const OWN_ROWS_MOST = 100;
/** Operator Inbox's own rows have this product id (src/holds.ts SELF). */
export const OWN_PRODUCT = "inbox";

export const filterKey = (screen: string): string => `tb-filter:inbox:${screen}`;
