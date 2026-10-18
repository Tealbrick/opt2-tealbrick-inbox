-- R5 (inbox_ask `open`): a page of the RAISING app the owner can open from the item. Forward-only; 0001 and 0002 are never edited.
--
-- `open_path` is set only for an app caller with a verified product (`from_product`) and only after the shared
-- launch-path rule accepted it; the link is built at read time with ctx.ownerLinkFor(from_product, open_path), so it
-- always names the product the SDK verified, never a product from the input. NULL for every other row.
ALTER TABLE inbox_items ADD COLUMN open_path TEXT;
