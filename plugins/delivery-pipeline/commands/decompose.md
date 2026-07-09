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

# /shipyard:decompose

Ти ведеш контур 2: перетворення прийнятої архітектури на тікети з явним DAG.
Тікет = GSD-план + `delivery:` блок у frontmatter. Залежності живуть у
frontmatter планів; `graph/tickets.yaml` — генерований view.

**ЄДИНЕ джерело правди — файли `.planning/phases/<N>-*/<N>-<M>-PLAN.md`.**
Jira/GitHub issues, ROLLOUT.md, списки в чаті — НЕ тікети конвеєра, а
щонайбільше експортні проєкції. Декомпозиція без матеріалізованих PLAN-файлів
не існує: /shipyard:deliver читає тільки їх. Оголошувати Gate 2 пройденим на
підставі будь-яких інших артефактів ЗАБОРОНЕНО — Gate 2 це виключно
exit 0 від validate-graph.cjs.

## Step 0 — Знайти вхід

1. Прочитай `.planning/architecture/` — список `ADR-*.md`.
2. Визнач, які ADR ще не декомпозовані: перевір ROADMAP.md і наявні
   `phases/*/`*-PLAN.md на згадки ADR. Якщо неоднозначно — запитай.
3. Нема жодного ADR → скажи, що спершу `/shipyard:investigate`, і зупинись.
4. Кілька кандидатів → AskUserQuestion: який ADR (або кілька в одну фазу).

## Step 0.5 — Моделі GSD-агентів

Декомпозицію виконують GSD-агенти — їхні моделі регламентуються НЕ цим скілом,
а `.planning/config.json`. Перевір і, якщо відсутнє, запропонуй додати
(політика проєкту: важке судження + важка робота → Opus 4.8 з 1M контекстом
`claude-opus-4-8[1m]`, легке → Sonnet 5):

```json
{
  "model_profile": "balanced",
  "models": { "planning": "opus", "research": "sonnet", "verification": "sonnet" },
  "model_overrides": {
    "gsd-planner": "claude-opus-4-8[1m]",
    "gsd-executor": "claude-opus-4-8[1m]"
  },
  "context_window": 1000000,
  "agent_skills": {
    "gsd-planner": ["global:shipyard:delivery-rules"],
    "gsd-executor": ["global:shipyard:delivery-rules"]
  },
  "ship": {
    "pr_body_sections": [
      { "heading": "Acceptance Criteria", "enabled": true,
        "source": "PLAN.md ## Acceptance criteria",
        "fallback": "- Covered by linked requirements and verification evidence." },
      { "heading": "Risks & Dependencies", "enabled": true,
        "source": "PLAN.md ## Risks || PLAN.md ## Dependencies",
        "fallback": "- No known high-risk rollout dependencies." }
    ]
  }
}
```

(`context_window: 1000000` — GSD 1.7 вмикає adaptive-context збагачення для
1M-моделей, узгоджено з opus[1m]-політикою конвеєра.)

(`models.*` приймає лише tier-аліаси opus/sonnet/haiku; повні ID — тільки
через `model_overrides` per-agent. Планувальник — найважча роль декомпозиції,
тому піднятий до Opus 4.8 з 1M контекстом через override; executor — так само.)

## Step 1 — Уточнити режим

Одне питання (AskUserQuestion), з рекомендацією за типом роботи:
- `--tdd` — коли робота добре тестована на рівні юнітів (рекомендуй для
  бекенд-логіки);
- `--mvp` — вертикальні слайси UI→API→DB (рекомендуй для нових фіч з UI);
- без прапорців — стандартне планування.

## Step 2 — GSD-ланцюг

1. Обери номер фази: наступний вільний (або аргумент користувача).
2. Виконай `/gsd-plan-phase <N> --ingest <adr-шляхи> [--tdd|--mvp]`
   (через Skill tool, якщо GSD-команди доступні як скіли, інакше підкажи
   користувачу запустити і дочекайся).
3. **Перевір матеріалізацію**: `ls .planning/phases/<N>-*/*-PLAN.md` — файли
   МАЮТЬ існувати. Якщо GSD-ланцюг недоступний або не створив файли —
   НЕ підміняй їх Jira-тікетами: створи PLAN.md-файли сам, по одному на
   тікет, за шаблоном:

   ```markdown
   ---
   phase: <NN>
   plan: <MM>
   title: "<назва тікета>"
   type: implementation
   wave: <N>                    # 1 + max(wave залежностей); без залежностей = 1
   depends_on: [<T-...>]
   files_modified: [<глоби>]
   requirements: [<REQ-ids>]    # ОБОВ'ЯЗКОВЕ в GSD 1.7: id вимог із ROADMAP.md;
                                # порожній масив = BLOCKER у plan-checker.
                                # Немає ROADMAP-вимог (імпорт із Jira) — створи
                                # REQ-запис у ROADMAP або постав id Jira-тікета
   delivery:
     ticket: T-<NN>-<MM>
     risk: low|medium|high
     human_checkpoint: false
   ---
   ## Goal / ## Context (Reads) / ## Scope / ## Out of scope /
   ## Acceptance criteria / ## Test strategy / ## Verification commands
   ```
4. Виконай `/gsd-plan-review-convergence <N> --all --max-cycles 3`
   (якщо доступний; пропуск конвергенції — це TUNE, пропуск файлів — BLOCK).

## Step 3 — Delivery-розширення frontmatter

Для КОЖНОГО згенерованого `phases/<N>-*/**-PLAN.md` додай у frontmatter:

```yaml
delivery:
  ticket: T-<phase>-<plan>          # напр. T-01-02
  branch: ticket/T-<phase>-<plan>-<slug-з-назви>   # можна опустити — згенерує validate-graph
  risk: low|medium|high             # оціни за змістом плану
  human_checkpoint: true|false      # true ОБОВ'ЯЗКОВО якщо risk: high
```

**Іменування гілок**: гілка — це назва тікета після санітизації:
нижній регістр, кирилиця транслітерується, УСІ знаки крім букв і цифр
(пробіли, `: , ( ) / ' " …`) замінюються одним дефісом, дефіси по краях
зрізаються, довжина slug ≤ 40. Приклад: назва `Add API endpoint (v2): auth`
→ `ticket/T-02-01-add-api-endpoint-v2-auth`. НЕ вигадуй формат сам —
найпростіше не заповнювати `branch` взагалі: `validate-graph` згенерує
канонічне ім'я з назви, а явно вказане — провалідує.

Переконайся, що `files_modified` і `requirements` заповнені в кожному плані —
порожні валять Gate 2 (помилка, не попередження): без `files_modified` немає
ані гарантії «незалежні тікети не конфліктують», ані scope виконавця. `depends_on`
порожній легальний лише для кореневого тікета. Якщо планувальник лишив поля
порожніми — заповни зі змісту плану.

## Step 4 — Gate 2

Gate 2 — це МЕХАНІЧНА перевірка, не судження. Пройдено тоді й лише тоді, коли
`validate-graph.cjs` завершився з exit 0 і `.planning/graph/tickets.json`
свіжозаписаний. Не рапортуй успіх декомпозиції без цього.

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/validate-graph.cjs`
2. Помилки (цикл, конфлікт по файлах, порожній files_modified/requirements,
   high-risk без checkpoint) → виправ frontmatter/слайсинг і повтори. Конфлікт
   по файлах чесніше вирішувати залежністю або пере-нарізкою, ніж розширенням
   files_modified.
3. OK → покажи користувачу підсумок на апрув:
   - таблиця тікетів: id / назва / wave / depends_on / risk;
   - хто high-risk і чекатиме людину;
   - скільки waves і що піде паралельно.
4. Користувач хоче зміни ("T-03 розбий на два") → точкова правка планів →
   знову Step 4.1.
5. Апрув → скажи наступний крок: `/shipyard:deliver` (можна одразу або
   через тиждень — delivery сам зробить холодний старт).

## Правила

- Не пиши продуктовий код — тільки плани і frontmatter.
- Кожен тікет після тебе — самодостатній контракт для fresh-context виконавця:
  Goal, Context reads, Scope, Out of scope, Acceptance criteria, Test strategy,
  Verification commands.
