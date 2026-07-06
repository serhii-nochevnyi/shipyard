---
name: deliver
description: "Delivery (контур 3): холодний старт → дошка тікетів → вибір scope → worktree/PR на тікет → babysit до зеленого (CI + CodeRabbit/Copilot re-init). Наприкінці фази — integrator."
argument-hint: "[тікети через кому — опційно, інакше вибір на дошці]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
---

# /pipeline:deliver

Ти ведеш контур 3: набір тікетів → окремі worktrees → PR на тікет → зелений
стан. Стан живе в GitHub і `.planning/graph/` — сесію можна вбити будь-коли
і перезапустити `/pipeline:deliver` без втрат.

## Моделі агентів (обов'язково передавай `model` при кожному спавні)

Політика: найважче судження → Fable 5, важка робота → Opus 4.8, легка механіка →
Sonnet 5.

```text
integrator     → claude-fable-5  (емерджентні порушення, найдорожчі помилки)
arch-review    → claude-fable-5  (вердикт проти ADR — судження)
executor       → opus[1m]        (основна кодова робота за контрактом)
review-fix     → opus[1m]        (верифікація чужих claim'ів + правки)
ci-fix         → opus[1m]        (діагностика падінь)
drift-check    → sonnet          (механічна звірка контракту з кодом)
```

Точні ID: Fable 5 = `claude-fable-5` (передавай повний ID — tier-аліаса може
не бути); Opus-ярус — Opus 4.8 з 1M контекстом: аліас `opus[1m]`
(повна форма `claude-opus-4-8[1m]`); `sonnet` резолвиться в найновіший
Sonnet (зараз `claude-sonnet-5`).

Override: якщо в `.planning/config.json` є блок `pipeline.models`
(`{"pipeline": {"models": {"drift-check": "opus", ...}}}`) — його значення
мають пріоритет; допускаються tier-аліаси (fable/opus/sonnet) і повні model ID.

Скрипти (детермінований шар — НЕ імпровізуй git/gh руками там, де є скрипт):

```text
node ${CLAUDE_PLUGIN_ROOT}/scripts/validate-graph.cjs
node ${CLAUDE_PLUGIN_ROOT}/scripts/state-sync.cjs
node ${CLAUDE_PLUGIN_ROOT}/scripts/reviewers.cjs <reinit|unresolved> <pr>
bash ${CLAUDE_PLUGIN_ROOT}/scripts/ticket-worktree.sh <create|remove|path|list> ...
```

## Step 0 — Холодний старт (обов'язково при КОЖНОМУ запуску)

1. `validate-graph.cjs` — граф проти поточного стану планів; помилки → стоп,
   покажи їх (можливо, щось змерджено повз конвеєр — направ у /pipeline:decompose).
2. `state-sync.cjs` — перебудувати delivery-state з фактичного GitHub
   (локальний файл — лише кеш).
3. Покажи ДОШКУ з stdout state-sync + tickets.json:

```text
ready:    T-01-01, T-01-04
blocked:  T-02-01 ← чекає T-01-02
pr-open:  T-01-02 (PR #142, checks: 1 failing, review: CHANGES_REQUESTED)
merged:   T-01-03
```

## Step 1 — Вибір scope

- Аргумент з тікетами → це scope; перевір проти дошки.
- Інакше AskUserQuestion (multiSelect) з ready-тікетів + опції "вся фаза N",
  "все ready". pr-open тікети автоматично в scope babysit-циклу — їх не обирають.
- Обраний blocked-тікет → уточни САМЕ ТОДІ:
  залежність має відкритий PR → "додати залежність у scope / стекнутись на її
  гілку (--on-top) / відкласти тікет"; залежність pending → "додати в scope /
  відкласти".
- Merged-залежності завжди задоволені — вибірка з середини графа легальна.

## Step 2 — Drift-gate обраних тікетів

Для кожного тікета зі scope, чий план старший за останній merge в main
(або якщо минуло >2 днів від генерації) — запусти ПАРАЛЕЛЬНО drift-check
агентів (`model: sonnet`; промпт: `${CLAUDE_PLUGIN_ROOT}/references/drift-check.md`
+ контракт тікета). `drifted` → тікет виключається зі scope, позначається needs-replan,
користувачу — підсумок дрейфу і направлення в /pipeline:decompose. НЕ виконуй
дрейфнутий тікет наосліп.

## Step 3 — Виконавці (паралельно по готовності)

Для кожного тікета T зі scope, коли всі його depends_on merged (або —
--on-top — мають стабільну гілку):

1. `base` = origin/main, якщо залежності merged; інакше гілка найглибшої
   незмердженої залежності.
2. `ticket-worktree.sh create <T> <branch з tickets.json> <base>`.
   Ім'я гілки береться ТІЛЬКИ з tickets.json (канонічний формат
   `ticket/<ID>-<slug-з-назви-тікета>`, вже санітизований validate-graph'ом) —
   не конструюй його вручну.
3. Запусти executor-агента (Agent tool, `model: opus[1m]`) У WORKTREE з контрактом:
   повний текст плану тікета + Context reads + правило "працюй ТІЛЬКИ в
   межах files_modified; коміть атомарно з префіксом (T): ...; прожени
   Verification commands до зеленого локально".
4. Після виконавця: push гілки,
   `gh pr create --base <base-branch|main> --head <branch> --draft
   --title "<T>: <title>" --body <PR body за шаблоном>`.
   PR body: Problem / Scope / Ticket / Dependency slice / Test evidence /
   Rollout-Rollback (для risky).
5. Одразу перший `reviewers.cjs reinit <pr>`.
6. Онови delivery-state (`state-sync.cjs`).

Незалежні тікети запускай ПАРАЛЕЛЬНО (кілька Agent в одному повідомленні).
Конфлікти по файлах виключені Gate 2.

## Step 4 — Babysit loop (для КОЖНОГО відкритого PR зі scope)

Лічильник спроб на PR: attempts (старт 1, MAX 5).

```text
loop:
  a. state-sync.cjs → checks цього PR
     failing → ci-fix агент у worktree тікета (`model: opus[1m]`)
       (промпт ${CLAUDE_PLUGIN_ROOT}/references/ci-fix.md + контракт + лог
        падіння: gh run view --log-failed)
       'escalate' від агента → status blocked, до людини
       push відбувся → крок d
     pending → почекай завершення checks (gh pr checks <pr> --watch), потім знову a

  b. reviewers.cjs unresolved <pr>
     є треди → review-fix агент у worktree (`model: opus[1m]`)
       (промпт ${CLAUDE_PLUGIN_ROOT}/references/review-fix.md + JSON тредів)
       агент або править (push → крок d), або відповідає reply на невалідні
       (без push → познач треди опрацьованими, знову b)

  c. arch-review агент (`model: claude-fable-5`)
     (промпт ${CLAUDE_PLUGIN_ROOT}/references/arch-review.md + gh pr diff +
      .planning/architecture/)
     violation    → fix у worktree → push → крок d
     adr-outdated → status blocked, ескалація людині (рішення міняти — не твоє)
     conform      → перевір критерії зеленого:
       всі checks passed ∧ unresolved=0 ∧ arch conform
       → gh pr ready <pr> (зняти draft)
       → human_checkpoint? повідом людину і чекай апруву : status green, ВИХІД

  d. після КОЖНОГО push:
     reviewers.cjs reinit <pr>
     attempts += 1
     attempts > MAX → status blocked, ескалація людині зі зведенням спроб
     → крок a
```

Кілька відкритих PR обслуговуй по черзі раундами (a→d для кожного), поки всі
не green/blocked. green + merged залежності розблоковують наступні тікети зі
scope → повертайся у Step 3 для них.

## Step 5 — Завершення

1. Всі тікети scope green/merged → підсумок: тікет / PR / стан / що чекає
   людину (апруви high-risk, merge).
2. Якщо це були ОСТАННІ тікети фази (всі тікети фази merged) → запропонуй
   integrator-прогін: агент за `${CLAUDE_PLUGIN_ROOT}/references/integrator.md`
   (`model: claude-fable-5`)
   → `INTEGRATION.md`; `needs-fix` → fix-тікети як нові плани → /pipeline:decompose
   Step 4 → наступний /pipeline:deliver.
3. Приберися: `ticket-worktree.sh remove <T>` для merged тікетів.

## Правила

- Merge робить людина (або auto-merge політика репо) — ти доводиш до green.
- Ніколи не force-push. Ніколи не комітиш у main.
- Кожна зміна стану — через state-sync, не ручним редагуванням state-файлів.
- Бот-рев'ювери можуть помилятися: незгода з обґрунтуванням — легальний
  результат review-fix, сліпе виконання — ні.
