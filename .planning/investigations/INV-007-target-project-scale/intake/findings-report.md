# Сесія pdffiller b11246f1: проблеми пайплайну, яких немає у фазах 40/41

Сесія: `~/.claude/projects/-Volumes-KINGSTON-PhpstormProjects-pdffiller/b11246f1-….jsonl`, 15:19–22:31 EEST (жива).
Обсяг: MYD-17835 → investigate (INV-002) → decompose (ADR-002, 12+1 тікетів) → deliver у 6 репо.
Метрики: 444 виклики Opus/medium у оркестраторі; 25 окремих state-sync із медіаною 128 с (разом ≈58 хв);
≈23 запуски arch-review на 13 тікетів; 8 із 13 тікетів оркестратор перевірив, закомітив і опублікував сам.

## A. Суперечить фазі 40 або описано неповно

1. D-16 + D-30/T-40-15: executor не може прочитати свій контракт.
2. T-41-08: pre-push-гейт і далі шукає базу тільки в `origin/main` або `main`.
3. T-40-16 і claude-role-host: pr-sentinel не охоплює фазу в кількох репо.
4. T-40-17: regex заголовка жорстко заданий і відхилить конвенцію pdffiller `[MYD-…] type:`.
5. Backlog про scratch-файли охоплює тільки base-merge; claude-role-host.cjs:131 має таку саму перевірку.
6. Backlog про conform-вердикт: випадок, коли вливаються вже перевірені зміни сусідніх тікетів, не розглянуто й не заплановано.

## B. Не описано ніде

7. У sandbox executor немає docker, php, мережі й node_modules. Через це 8/13 тікетів закомічено вручну без receipt, а sentinel їх змерджив.
8. `run-reachability.cjs` падає з ENOBUFS; `sentinel.treeBlobs` читає повне рекурсивне дерево. Кеш 0.63.0 пропатчено локально.
9. Застарілий approve від CodeRabbit блокує merge назавжди (`reviewers.cjs:154`).
10. Немає builder для запитів investigate, decompose, arch-review і fix-round.
11. Тривалість state-sync: pr_fetch_limit, змерджені тікети фази 01, повтори.
12. Вікно ci-wait (15–60 хв) довше за ліміт Bash 600 с; CANCELLED потрапляє в ci-fix.
13. comment-policy конфліктує з анотаціями, яких вимагає репо (`@ai-generated`), і з правками коментарів, яких вимагає ADR.
14. Одна знахідка з type "unknown" скасовує результат arch-review повністю.
15. Прив'язки до наявних Jira-задач немає, тому export вимкнено.
16. ROADMAP від decompose призвів до блокування gsd-sync; `pipeline.gsd_sync` видалено мовчки.
17. Під auto_merge: epic чекпоінт блокує merge у epic.
18. Для baseline-скріншота ескалацію віддано людині, хоча в репо є workflow регенерації.
