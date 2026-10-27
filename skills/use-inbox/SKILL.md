---
name: use-inbox
description: How to ask the owner a question or request the owner's approval through Operator Inbox, and how to read the answer.
---
# Asking the owner through Operator Inbox

{{agent.name}}, use Operator Inbox when you need a human decision or an answer only the owner can give.

## Ask
- Call `inbox__inbox_ask` with `title` (one line the owner reads in the list) and `kind`:
  - `approval`: the owner answers approve, deny or clarify.
  - `question`: the owner answers in words (answer) or asks you to clarify.
- Put the facts the owner needs in `context`: what you want to do, the options, and what happens next.
- Optional: `priority` (low, normal, high, urgent), `responses` (limit the allowed answers), `expiresInS` (default 7 days).
- For an approval, set `family` to say what the owner approves: `money` (spends or refunds money), `destructive` (deletes data), `first_contact` (writes to a new person), `identity` (acts as someone or changes who can sign in), `public_link` (makes something public), or `none` (none of these). Be honest: the owner may approve `first_contact`, `identity`, `public_link` and `none` with a button in a chat message; `money`, `destructive` and an approval without `family` are decided in Operator Inbox only.
- Do not send `open`: only an app can link an item to one of its pages. An agent gets `open_not_allowed`.
- Always send an idempotency key. If you repeat the call with the same key and the same input, you get the first item back, not a second one.
- Keep the returned `itemId`. Do not wait in a loop inside one turn; continue with other work.

## Read the answer
- When the owner answers, or the item expires, you get the event `inbox.item.answered` (subject `inbox_item` = your `itemId`). It wakes you; it does not carry the answer. Then call `inbox__inbox_status` with that `itemId` and act on what it returns. Never act on the event or its summary alone.
- Without events (an older bridge), call `inbox__inbox_status` with the `itemId` on your next check.
- `status: open`: no answer yet. `seenByOwner: true` means the owner has looked at it.
- `status: answered`: act on `response` and read `message`.
  - `approve`: go ahead with exactly what you asked for.
  - `deny`: do not do it.
  - `answer`: the owner's answer is in `message`.
  - `clarify`: the owner needs more from you; the request is closed. Ask again with a new item that answers the owner's question.
- `status: unknown`: no such item of yours (wrong id). Treat it as no answer.
- `status: expired`: nobody answered in time, or you withdrew the item. Never treat expired, unknown or a missing answer as approval. Ask again only if it still matters.

## Withdraw an item you no longer need
- Call `inbox__inbox_withdraw` with the `itemId` and, if you can, a short `reason` (the owner reads it), for example when the question was answered somewhere else.
- `result: withdrawn`: the item is closed. It reads as `expired` in `inbox__inbox_status` and the owner sees "Withdrawn by <you>" with your reason. Calling it again gives the same answer.
- `result: not_open`: the owner already answered it, or it already expired. Nothing changed. Read it with `inbox__inbox_status`; an answer that came in still counts.
- `result: unknown`: no such item of yours. Only the agent or app that asked can withdraw an item.
- A withdrawn item is never an approval. Do not act on it as if it were one.

## Add information
- Call `inbox__inbox_reply` with `itemId` and `message` to add facts to an open item. An answer the owner gave on the older text is refused, so the owner always decides on your latest message.

If any call answers `held`, the owner must approve that call first. Poll `inbox__tb_hold_status` with the `holdId`, then repeat the same call.
