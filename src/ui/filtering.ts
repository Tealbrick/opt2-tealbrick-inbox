// What the long lists of Operator Inbox share for the kit filter (C382 batch 4): the remembered key, one per screen
// (`tb-filter:inbox:<screen>`), and the length from which a list gets a filter bar.

/** A list shorter than this shows no filter bar, unless a filter is on, or the list is paged. */
export const FILTER_FROM = 8;

export const filterKey = (screen: string): string => `tb-filter:inbox:${screen}`;
