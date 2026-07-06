---
name: decompose
description: "Декомпозиція (контур 2): ADR → GSD-плани-тікети з залежностями → валідний граф (Gate 2). Знаходить недекомпозовані ADR сам."
argument-hint: "[номер фази — опційно]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - AskUserQuestion
  - Skill
---

# /pipeline:decompose

Ти ведеш контур 2: перетворення прийнятої архітектури на тікети з явним DAG.
Тікет = GSD-план + `delivery:` блок у frontmatter. Залежності живуть у
frontmatter планів; `graph/tickets.yaml` — генерований view.

## Step 0 — Знайти вхід

1. Прочитай `.planning/architecture/` — список `ADR-*.md`.
2. Визнач, які ADR ще не декомпозовані: перевір ROADMAP.md і наявні
   `phases/*/`*-PLAN.md на згадки ADR. Якщо неоднозначно — запитай.
3. Нема жодного ADR → скажи, що спершу `/pipeline:investigate`, і зупинись.
4. Кілька кандидатів → AskUserQuestion: який ADR (або кілька в одну фазу).

## Step 0.5 — Моделі GSD-агентів

Декомпозицію виконують GSD-агенти — їхні моделі регламентуються НЕ цим скілом,
а `.planning/config.json`. Перевір і, якщо відсутнє, запропонуй додати
(політика проєкту: найважче → Fable 5 `claude-fable-5`, важке → Opus 4.8,
легке → Sonnet 5):

```json
{
  "model_profile": "balanced",
  "models": { "planning": "opus", "research": "sonnet", "verification": "sonnet" },
  "model_overrides": {
    "gsd-planner": "claude-fable-5",
    "gsd-executor": "claude-opus-4-8[1m]"
  }
}
```

(`models.*` приймає лише tier-аліаси opus/sonnet/haiku; повні ID — тільки
через `model_overrides` per-agent. Планувальник — найважча роль декомпозиції,
тому піднятий до Fable через override; executor — Opus 4.8 з 1M контекстом.)

## Step 1 — Уточнити режим

Одне питання (AskUserQuestion), з рекомендацією за типом роботи:
- `--tdd` — коли робота добре тестована на рівні юнітів (рекомендуй для
  бекенд-логіки);
- `--mvp` — вертикальні слайси UI→API→DB (рекомендуй для нових фіч з UI);
- без прапорців — стандартне планування.

## Step 2 — GSD-ланцюг

1. Обери номер фази: наступний вільний (або аргумент користувача).
2. Виконай `/gsd:plan-phase <N> --ingest <adr-шляхи> [--tdd|--mvp]`
   (через Skill tool, якщо GSD-команди доступні як скіли, інакше підкажи
   користувачу запустити і дочекайся).
3. Виконай `/gsd:plan-review-convergence <N> --all --max-cycles 3`.

## Step 3 — Delivery-розширення frontmatter

Для КОЖНОГО згенерованого `phases/<N>-*/**-PLAN.md` додай у frontmatter:

```yaml
delivery:
  ticket: T-<phase>-<plan>          # напр. T-01-02
  branch: ticket/T-<phase>-<plan>-<короткий-slug>
  risk: low|medium|high             # оціни за змістом плану
  human_checkpoint: true|false      # true ОБОВ'ЯЗКОВО якщо risk: high
```

Переконайся, що `depends_on` і `files_modified` заповнені в кожному плані —
без них граф не зійдеться. Якщо планувальник лишив їх порожніми — заповни з
змісту плану.

## Step 4 — Gate 2

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/validate-graph.cjs`
2. Помилки (цикл, конфлікт по файлах, high-risk без checkpoint) → виправ
   frontmatter/слайсинг і повтори. Конфлікт по файлах чесніше вирішувати
   залежністю або пере-нарізкою, ніж розширенням files_modified.
3. OK → покажи користувачу підсумок на апрув:
   - таблиця тікетів: id / назва / wave / depends_on / risk;
   - хто high-risk і чекатиме людину;
   - скільки waves і що піде паралельно.
4. Користувач хоче зміни ("T-03 розбий на два") → точкова правка планів →
   знову Step 4.1.
5. Апрув → скажи наступний крок: `/pipeline:deliver` (можна одразу або
   через тиждень — delivery сам зробить холодний старт).

## Правила

- Не пиши продуктовий код — тільки плани і frontmatter.
- Кожен тікет після тебе — самодостатній контракт для fresh-context виконавця:
  Goal, Context reads, Scope, Out of scope, Acceptance criteria, Test strategy,
  Verification commands.
