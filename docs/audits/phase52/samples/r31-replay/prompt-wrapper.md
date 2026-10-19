RUN BLOCK
<config>
depth: deep
diff_base: 009dee0143
files:
  - plugins/delivery-pipeline/scripts/jira-project.cjs
  - tests/unit/jira-project.test.cjs
</config>
Review the diff `git diff 009dee0143 HEAD` of the checkout in the current directory (HEAD is the reviewed head). Read the changed files in full and the code they call.

Overrides:
- Do NOT write any file. Print the complete report (the REVIEW.md text, frontmatter first) as your final answer. Skip every `gsd_run` or workflow command in the instructions; do not run tests, installs or anything that modifies the checkout.
- Do not read anything under `.planning/` or any `*.md` note in the repository: review the code only.
- Pipeline finding format. Every finding keeps the heading `### <ID>: <title>` (ids CR-NN, WR-NN, IN-NN as in the template) and these lines, in this order:
  **Rule:** <one lowercase kebab-case slug naming the class of defect, for example fail-open-on-error or duplicated-helper; choose it from the defect class, not from the wording of the title>
  **File:** `<one path>:<one integer line>` (the first line of the defective statement; no ranges, no second location; put other locations in the Issue text)
  **Anchor:** `<the verbatim defective source line, trimmed of leading whitespace>`
  **Issue:** ...
  **Fix:** ...
- Report every real defect you find at any severity.
- Write all report text in English.

