---
title: Stacked-PR merges in rapid succession defeat GitHub auto-retargeting, stranding work in the topmost branch
date: 2026-05-28
category: docs/solutions/workflow-issues
module: development-workflow
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Working with a chain of 2+ stacked PRs where each PR's base is the parent stacked branch
  - Merging the stack on GitHub via the web UI in rapid succession
  - Using gh CLI or the merge button without deleting head branches between merges
  - "After merging N PRs, the trunk branch only contains commits from PR #1"
tags: [github, pull-requests, stacked-prs, merge-strategy, git-workflow, auto-retargeting]
---

# Stacked-PR merges in rapid succession defeat GitHub auto-retargeting, stranding work in the topmost branch

## Context

A typical stacked-PR setup for sequential feature work:

```
master (or feature/trunk)
  └── feature/A     ← PR #1: base=feature/trunk, head=feature/A
       └── feature/B  ← PR #2: base=feature/A,    head=feature/B
            └── feature/C ← PR #3: base=feature/B,   head=feature/C
                 └── feature/D ← PR #4: base=feature/C,   head=feature/D
```

The intent: merge all 4 PRs in order, each landing in `feature/trunk` so the trunk ends up with the full N-commit stack.

What actually happens if you merge them in rapid succession (all 4 within a minute or so):

- PR #1 merges → `feature/A` lands in `feature/trunk` ✅
- PR #2 merges → `feature/B` lands in `feature/A` ❌ (NOT `feature/trunk`)
- PR #3 merges → `feature/C` lands in `feature/B` ❌
- PR #4 merges → `feature/D` lands in `feature/C` ❌

Only PR #1's commits reach the trunk. The other 75% of the work is now stranded in the topmost branch (`feature/D`, which is N+1 levels above the trunk via its parent chain).

## Guidance

**Three workable strategies, in order of preference for most repos:**

### (a) Delete each parent head branch immediately after merging — forces auto-retarget

GitHub's auto-retargeting kicks in when a PR's base branch is **deleted** after that PR merges. By deleting `feature/A` immediately after PR #1 merges, GitHub sees PR #2's base is gone and auto-retargets it to `feature/trunk`. Then merging PR #2 lands its commits in the trunk.

Workflow:
```
1. Merge PR #1
2. gh api -X DELETE repos/:owner/:repo/git/refs/heads/feature/A   # or click "Delete branch" in the merged-PR UI
3. (PR #2 now auto-retargeted to feature/trunk by GitHub)
4. Merge PR #2
5. Delete feature/B
6. ... repeat ...
```

Pros: Trunk gets the full stack as intended; matches the mental model of "merging each PR moves work toward the trunk."
Cons: Manual delete step between each merge; easy to forget if you batch-click "Merge" buttons.

### (b) Merge only the topmost branch into trunk after the stack lands in itself — single catch-up merge

If you've already hit the footgun (the situation we hit this session), the simplest fix is to merge the topmost stacked branch directly into trunk:

```bash
git checkout feature/trunk
git pull origin feature/trunk
git merge --no-ff origin/feature/D    # the topmost branch
git push origin feature/trunk
```

The topmost branch contains the full N-commit stack (every parent's commits accumulated). One merge brings everything home.

Pros: Recovers cleanly when the footgun has already been triggered; minimal interruption to the team's existing PR flow.
Cons: The merge commit on trunk references one branch, not N, so the trunk's history doesn't visually surface the per-PR merge points.

### (c) Use a stacked-PR tool

Tools like Graphite (`gt`), `gh stack`, or `git-spr` orchestrate the merge sequence and handle auto-retargeting + branch deletion atomically. If your team frequently works in stacks, the tooling pays for itself.

Pros: Operational hazard removed at the workflow level.
Cons: Onboarding overhead; team-wide adoption needed for consistency.

## Why This Matters

The failure mode is **silent and invisible by default**. The GitHub UI shows all PRs marked "Merged" with green checkmarks. There's no warning, no banner, no PR-level indication that the work didn't reach the trunk. You only discover the problem when:

- A teammate pulls trunk and the expected code isn't there
- CI/deployment from trunk doesn't include the feature
- You run `git log origin/feature/trunk -20` and the merge commits aren't visible

For high-stakes work (production deploys, release branches, hotfix trains), this can mean shipping a partial feature set or panicking about "missing" work that's actually safely committed but stranded in a feature branch.

## When to Apply

Trigger awareness for any of these:

- Opening 3+ PRs in a chain where each PR's base is a feature branch (not the trunk)
- Considering whether to merge a stack via the GitHub web UI or `gh pr merge`
- Diagnosing "where did my code go?" after merging a stack — check the topmost branch
- Adding stacked-PR conventions to a team's contribution docs
- Onboarding teammates who haven't worked in stacks before

## Examples

### Diagnostic: confirm whether you hit the footgun

```bash
# After merging the stack, check what actually reached the trunk.
git fetch origin
git log --oneline origin/feature/trunk -10

# If the topmost commits from PR #2/#3/#N aren't visible, you hit the footgun.
# Check the topmost branch — that's where the work is stranded.
git log --oneline origin/feature/D ^origin/feature/trunk | head -30
```

### Recovery: option (b) catch-up merge

```bash
# All 4 PRs marked merged on GitHub, but only PR #1 reached the trunk.
git fetch origin feature/D
git checkout feature/trunk
git pull origin feature/trunk
git merge --no-ff origin/feature/D
# Verify: every expected file/feature is now in the working tree.
git push origin feature/trunk
```

### Prevention via PR description boilerplate

When opening a stacked PR, add a line like this near the top of the description so reviewers and merger see the merge-order requirement:

```markdown
> **Stacked on PR #N.** Before merging this PR, merge PR #N first AND delete
> its head branch so GitHub auto-retargets this PR to the trunk. Otherwise
> this PR's commits will land in PR #N's head branch instead of the trunk.
```

The repo's recent FleetGraph stack (PRs #41 → #43 → #44 → #45, merged 2026-05-28) is the in-repo evidence the footgun is real on this team's setup.
